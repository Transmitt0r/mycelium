import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingProviderHandle } from "./embedding-provider.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "content-type": "application/json" },
  });
}

// Stubs the fetch call the handle is given directly (via fetchImpl), rather
// than vi.stubGlobal -- injected explicitly since EmbeddingProviderHandle
// takes fetchImpl as a constructor option specifically so tests never have
// to touch the real global fetch.
function stubFetch(handler: (request: Request) => Response) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input as string, init);
    return handler(request);
  });
}

function makeHandle(fetchImpl: ReturnType<typeof stubFetch>, overrides?: { dimensions?: number }) {
  return new EmbeddingProviderHandle({
    apiKey: "test-api-key",
    model: "gemini-embedding-2",
    dimensions: overrides?.dimensions ?? 768,
    fetchImpl,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EmbeddingProviderHandle", () => {
  it("embeds a single query via models.embedContent", async () => {
    const fetchImpl = stubFetch(() => jsonResponse({ embedding: { values: [0.1, 0.2, 0.3] } }));
    const handle = makeHandle(fetchImpl);
    const result = await handle.embedQuery("hello world");
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  it("sends the configured apiKey, model, and dimensions in the embedContent request", async () => {
    let capturedRequest: Request | undefined;
    let capturedBody: unknown;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      capturedRequest = new Request(input as string, init);
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse({ embedding: { values: [1] } });
    });
    const handle = makeHandle(fetchImpl, { dimensions: 768 });
    await handle.embedQuery("hello");

    expect(capturedRequest?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
    );
    expect(capturedRequest?.headers.get("x-goog-api-key")).toBe("test-api-key");
    expect(capturedBody).toEqual({
      model: "models/gemini-embedding-2",
      content: { parts: [{ text: "hello" }] },
      outputDimensionality: 768,
    });
  });

  it("embeds a batch via models.batchEmbedContents in a single request", async () => {
    let callCount = 0;
    let capturedBody: unknown;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      callCount += 1;
      capturedBody = JSON.parse(String(init?.body));
      expect((input as string).endsWith(":batchEmbedContents")).toBe(true);
      return jsonResponse({
        embeddings: [{ values: [1, 0] }, { values: [0, 1] }, { values: [1, 1] }],
      });
    });
    const handle = makeHandle(fetchImpl);
    const result = await handle.embedBatch(["a", "b", "c"]);

    expect(callCount).toBe(1);
    expect(result).toEqual([
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
    expect(capturedBody).toEqual({
      requests: [
        {
          model: "models/gemini-embedding-2",
          content: { parts: [{ text: "a" }] },
          outputDimensionality: 768,
        },
        {
          model: "models/gemini-embedding-2",
          content: { parts: [{ text: "b" }] },
          outputDimensionality: 768,
        },
        {
          model: "models/gemini-embedding-2",
          content: { parts: [{ text: "c" }] },
          outputDimensionality: 768,
        },
      ],
    });
  });

  it("splits a batch larger than 100 items into multiple sequential requests", async () => {
    const requestSizes: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { requests: unknown[] };
      requestSizes.push(body.requests.length);
      return jsonResponse({ embeddings: body.requests.map((_, i) => ({ values: [i] })) });
    });
    const handle = makeHandle(fetchImpl);
    const texts = Array.from({ length: 205 }, (_, i) => `chunk-${i}`);
    const result = await handle.embedBatch(texts);

    expect(requestSizes).toEqual([100, 100, 5]);
    expect(result).toHaveLength(205);
  });

  it("returns [] for an empty batch without making a request", async () => {
    const fetchImpl = stubFetch(() => {
      throw new Error("should not be called");
    });
    const handle = makeHandle(fetchImpl);
    expect(await handle.embedBatch([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("propagates a 429 rate-limit response as a thrown error", async () => {
    const fetchImpl = stubFetch(() => jsonResponse({ error: { message: "rate limited" } }, 429));
    const handle = makeHandle(fetchImpl);
    await expect(handle.embedQuery("hello")).rejects.toThrow(/429/);
  });

  it("propagates a 4xx auth error as a thrown error", async () => {
    const fetchImpl = stubFetch(() => jsonResponse({ error: { message: "invalid API key" } }, 403));
    const handle = makeHandle(fetchImpl);
    await expect(handle.embedQuery("hello")).rejects.toThrow(/403/);
  });

  it("throws a clear error when the response is missing embedding.values", async () => {
    const fetchImpl = stubFetch(() => jsonResponse({}));
    const handle = makeHandle(fetchImpl);
    await expect(handle.embedQuery("hello")).rejects.toThrow(/missing embedding\.values/);
  });

  it("throws a clear error when a batch response's length doesn't match the request", async () => {
    const fetchImpl = stubFetch(() => jsonResponse({ embeddings: [{ values: [1] }] }));
    const handle = makeHandle(fetchImpl);
    await expect(handle.embedBatch(["a", "b"])).rejects.toThrow(
      /batch response had 1 embeddings for 2/,
    );
  });

  it("does not retry on failure -- one request per call", async () => {
    const fetchImpl = stubFetch(() => jsonResponse({ error: "boom" }, 500));
    const handle = makeHandle(fetchImpl);
    await expect(handle.embedQuery("hello")).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
