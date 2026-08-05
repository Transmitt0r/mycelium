import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaperlessClient, unwrap } from "./client.js";

describe("unwrap", () => {
  it("returns data on success", () => {
    expect(unwrap({ data: { id: 1 } })).toEqual({ id: 1 });
  });

  it("throws on error", () => {
    expect(() => unwrap({ error: { detail: "not found" } })).toThrow(/not found/);
  });

  it("throws when data is missing", () => {
    expect(() => unwrap({})).toThrow(/no data/);
  });

  it("surfaces the HTTP status for a non-2xx response with an empty body", () => {
    const response = new Response(null, { status: 401, statusText: "Unauthorized" });
    expect(() => unwrap({ response })).toThrow(/401/);
  });
});

describe("createPaperlessClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the token as an Authorization header and strips trailing slashes from baseUrl", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ count: 0, results: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createPaperlessClient({
      baseUrl: "https://paperless.example.com/",
      apiToken: "test-token",
    });
    await client.GET("/api/documents/", { params: { query: {} } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe("https://paperless.example.com/api/documents/");
    expect(request.headers.get("authorization")).toBe("Token test-token");
  });

  // Regression: a connection-level failure used to surface as Node's bare
  // "fetch failed", which named neither host nor endpoint -- and on the
  // semantic sync path (where an embedding endpoint is also in play) that
  // was misdiagnosed as an embedding outage.
  it("names the endpoint and the underlying cause when the connection fails", async () => {
    const cause = new Error("connect ECONNREFUSED 10.0.0.5:443");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause });
      }),
    );

    const client = createPaperlessClient({
      baseUrl: "https://paperless.example.com",
      apiToken: "test-token",
    });

    await expect(client.GET("/api/documents/", { params: { query: {} } })).rejects.toThrow(
      "paperless-ngx API unreachable (https://paperless.example.com/api/documents/): " +
        "connect ECONNREFUSED 10.0.0.5:443",
    );
  });

  it("names the endpoint when the request times out", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw timeout;
      }),
    );

    const client = createPaperlessClient({
      baseUrl: "https://paperless.example.com",
      apiToken: "test-token",
    });

    await expect(client.GET("/api/documents/", { params: { query: {} } })).rejects.toThrow(
      /paperless-ngx API timed out after 30000ms \(https:\/\/paperless\.example\.com\/api\/documents\/\)/,
    );
  });

  it("keeps the query string out of the connectivity error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND host") });
      }),
    );

    const client = createPaperlessClient({
      baseUrl: "https://paperless.example.com",
      apiToken: "test-token",
    });

    await expect(
      client.GET("/api/documents/", { params: { query: { query: "secret term" } } }),
    ).rejects.toThrow(/^(?!.*secret term).*paperless-ngx API unreachable/s);
  });

  it("passes a caller-initiated abort through untouched", async () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw abort;
      }),
    );

    const client = createPaperlessClient({
      baseUrl: "https://paperless.example.com",
      apiToken: "test-token",
    });

    await expect(client.GET("/api/documents/", { params: { query: {} } })).rejects.toBe(abort);
  });
});
