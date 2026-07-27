import { afterEach, describe, expect, it, vi } from "vitest";
import { createTriliumClient } from "../client.js";
import { SemanticIndexStore } from "./store.js";
import { runIncrementalSync } from "./sync.js";
import type { IndexIdentity } from "./types.js";

const BASE_URL = "https://trilium.example.com";

type Route = {
  test: (pathname: string, method: string) => boolean;
  handle: (request: Request) => unknown;
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function textResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function stubFetch(routes: Route[]) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    const url = new URL(request.url);
    const route = routes.find((r) => r.test(url.pathname, request.method));
    if (!route) throw new Error(`Unhandled request in test: ${request.method} ${url.pathname}`);
    const result = route.handle(request);
    return result instanceof Response ? result : jsonResponse(result);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setup(routes: Route[]) {
  const fetchMock = stubFetch(routes);
  const client = createTriliumClient({ baseUrl: BASE_URL, apiToken: "test-token" });
  return { client, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function memoryStore(identity: IndexIdentity) {
  const opened = await SemanticIndexStore.open(":memory:", identity.dimensions);
  if (!opened.available) throw new Error(`test setup failed: ${opened.reason}`);
  opened.store.rebuild(identity);
  return opened.store;
}

const IDENTITY: IndexIdentity = {
  providerId: "gemini",
  model: "test-model",
  dimensions: 4,
  chunkTokens: 400,
  chunkOverlap: 80,
};

function fakeEmbeddingProvider(opts?: { embedBatch?: (texts: string[]) => Promise<number[][]> }) {
  return {
    embedBatch: vi.fn(
      opts?.embedBatch ?? (async (texts: string[]) => texts.map(() => [1, 0, 0, 0])),
    ),
  };
}

const baseConfig = {
  chunkTokens: 400,
  chunkOverlap: 80,
  initialBackfillLimit: 200,
  incrementalSyncLimit: 200,
  embedConcurrency: 2,
};

type NoteFixture = { noteId: string; blobId: string; utcDateModified: string; type?: string };

const notesSearchRoute = (notes: NoteFixture[]): Route => ({
  test: (pathname, method) => method === "GET" && pathname === "/etapi/notes",
  handle: () => ({
    results: notes.map((n) => ({ ...n, type: n.type ?? "text", title: n.noteId })),
  }),
});

const contentRoute = (contentByNoteId: Record<string, string>): Route => ({
  test: (pathname, method) => method === "GET" && /^\/etapi\/notes\/[^/]+\/content$/.test(pathname),
  handle: (request) => {
    const noteId = new URL(request.url).pathname.split("/")[3];
    return textResponse(contentByNoteId[noteId ?? ""] ?? "");
  },
});

describe("runIncrementalSync", () => {
  it("embeds and stores every note on a first (full backfill) pass", async () => {
    const { client } = setup([
      notesSearchRoute([
        { noteId: "n1", blobId: "b1", utcDateModified: "2024-01-01 00:00:00.000Z" },
        { noteId: "n2", blobId: "b2", utcDateModified: "2024-01-02 00:00:00.000Z" },
      ]),
      contentRoute({ n1: "first note body", n2: "second note body" }),
    ]);
    const store = await memoryStore(IDENTITY);
    const embeddingProvider = fakeEmbeddingProvider();

    const summary = await runIncrementalSync({
      client,
      store,
      embeddingProvider,
      config: baseConfig,
    });

    expect(summary.processed).toBe(2);
    expect(summary.skippedUnchanged).toBe(0);
    expect(summary.failed).toBe(0);
    expect(store.noteCount()).toBe(2);
    store.close();
  });

  it("scopes the search to text/code notes and sends the watermark filter on a subsequent pass", async () => {
    const store = await memoryStore(IDENTITY);
    store.setSyncWatermark("2024-01-01 00:00:00.000Z");
    const { client, fetchMock } = setup([notesSearchRoute([])]);
    const embeddingProvider = fakeEmbeddingProvider();

    await runIncrementalSync({ client, store, embeddingProvider, config: baseConfig });

    const request = fetchMock.mock.calls[0]?.[0];
    if (!request) throw new Error("test setup: no request captured");
    const requestUrl = new URL((request as Request).url);
    const search = requestUrl.searchParams.get("search") ?? "";
    expect(search).toContain('note.type = "text"');
    expect(search).toContain('note.utcDateModified >= "2024-01-01 00:00:00.000Z"');
    expect(requestUrl.searchParams.get("orderBy")).toBe("utcDateModified");
    expect(requestUrl.searchParams.get("orderDirection")).toBe("asc");
    store.close();
  });

  it("skips a note whose blobId is unchanged without ever fetching its content", async () => {
    const store = await memoryStore(IDENTITY);
    store.upsertNote("n1", "b1", "2024-01-01 00:00:00.000Z", []);
    let contentFetched = false;
    const { client } = setup([
      notesSearchRoute([
        { noteId: "n1", blobId: "b1", utcDateModified: "2024-01-01 00:00:00.000Z" },
      ]),
      {
        test: (p, m) => m === "GET" && p === "/etapi/notes/n1/content",
        handle: () => {
          contentFetched = true;
          return textResponse("should never be fetched");
        },
      },
    ]);
    const embeddingProvider = fakeEmbeddingProvider();

    const summary = await runIncrementalSync({
      client,
      store,
      embeddingProvider,
      config: baseConfig,
    });

    expect(summary.skippedUnchanged).toBe(1);
    expect(summary.processed).toBe(0);
    expect(contentFetched).toBe(false);
    store.close();
  });

  it("re-embeds when the blobId changed", async () => {
    const store = await memoryStore(IDENTITY);
    store.upsertNote("n1", "old-blob", "2024-01-01 00:00:00.000Z", []);
    const { client } = setup([
      notesSearchRoute([
        { noteId: "n1", blobId: "new-blob", utcDateModified: "2024-02-01 00:00:00.000Z" },
      ]),
      contentRoute({ n1: "edited body" }),
    ]);
    const embeddingProvider = fakeEmbeddingProvider();

    const summary = await runIncrementalSync({
      client,
      store,
      embeddingProvider,
      config: baseConfig,
    });

    expect(summary.processed).toBe(1);
    expect(summary.skippedUnchanged).toBe(0);
    expect(store.getNoteBlobId("n1")).toBe("new-blob");
    store.close();
  });

  it("continues past a single note's embedding failure and counts it as failed", async () => {
    const store = await memoryStore(IDENTITY);
    const embeddingProvider = fakeEmbeddingProvider({
      embedBatch: async (texts) => {
        if (texts.some((t) => t.includes("poison"))) throw new Error("embedding provider exploded");
        return texts.map(() => [1, 0, 0, 0]);
      },
    });
    const { client } = setup([
      notesSearchRoute([
        { noteId: "n1", blobId: "b1", utcDateModified: "2024-01-01 00:00:00.000Z" },
        { noteId: "n2", blobId: "b2", utcDateModified: "2024-01-02 00:00:00.000Z" },
      ]),
      contentRoute({ n1: "poison document", n2: "healthy document" }),
    ]);

    const summary = await runIncrementalSync({
      client,
      store,
      embeddingProvider,
      config: baseConfig,
    });

    expect(summary.failed).toBe(1);
    expect(summary.processed).toBe(1);
    expect(store.getNoteBlobId("n2")).toBeDefined();
    expect(store.getNoteBlobId("n1")).toBeUndefined();
    store.close();
  });

  it("advances the watermark to the newest utcDateModified seen (ascending order, last item)", async () => {
    const store = await memoryStore(IDENTITY);
    const { client } = setup([
      notesSearchRoute([
        { noteId: "n1", blobId: "b1", utcDateModified: "2024-01-01 00:00:00.000Z" },
        { noteId: "n2", blobId: "b2", utcDateModified: "2024-03-01 00:00:00.000Z" },
      ]),
      contentRoute({ n1: "older", n2: "newer" }),
    ]);
    const embeddingProvider = fakeEmbeddingProvider();

    await runIncrementalSync({ client, store, embeddingProvider, config: baseConfig });

    expect(store.getSyncWatermark()).toBe("2024-03-01 00:00:00.000Z");
    store.close();
  });

  it("warns and sets hitLimit when the initial backfill hits its cap", async () => {
    const store = await memoryStore(IDENTITY);
    const notes = Array.from({ length: 3 }, (_, i) => ({
      noteId: `n${i}`,
      blobId: `b${i}`,
      utcDateModified: `2024-01-0${i + 1} 00:00:00.000Z`,
    }));
    const { client } = setup([
      notesSearchRoute(notes),
      contentRoute(Object.fromEntries(notes.map((n) => [n.noteId, "body"]))),
    ]);
    const embeddingProvider = fakeEmbeddingProvider();
    const logger = { warn: vi.fn() };

    const summary = await runIncrementalSync({
      client,
      store,
      embeddingProvider,
      config: { ...baseConfig, initialBackfillLimit: 3 },
      logger,
    });

    expect(summary.hitLimit).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("initial backfill hit its 3-note cap"),
    );
    store.close();
  });

  // Regression test for a real bug found in review: if more notes share
  // the exact boundary utcDateModified than incrementalSyncLimit, the
  // `>=` filter re-fetches the same leading subset forever and the
  // watermark can never advance -- this should now be detected and
  // surfaced as watermarkStuck, not looped through silently.
  it("detects and warns when the watermark is stuck at a tied boundary", async () => {
    const store = await memoryStore(IDENTITY);
    store.setSyncWatermark("2024-01-01 00:00:00.000Z");
    const tiedNotes = [
      { noteId: "n1", blobId: "b1", utcDateModified: "2024-01-01 00:00:00.000Z" },
      { noteId: "n2", blobId: "b2", utcDateModified: "2024-01-01 00:00:00.000Z" },
    ];
    const { client } = setup([notesSearchRoute(tiedNotes), contentRoute({ n1: "a", n2: "b" })]);
    const embeddingProvider = fakeEmbeddingProvider();
    const logger = { warn: vi.fn() };

    const summary = await runIncrementalSync({
      client,
      store,
      embeddingProvider,
      config: { ...baseConfig, incrementalSyncLimit: 2 },
      logger,
    });

    expect(summary.watermarkStuck).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("sync watermark stuck"));
    store.close();
  });

  it("does not report watermarkStuck when the pass makes real forward progress", async () => {
    const store = await memoryStore(IDENTITY);
    store.setSyncWatermark("2024-01-01 00:00:00.000Z");
    const { client } = setup([
      notesSearchRoute([
        { noteId: "n1", blobId: "b1", utcDateModified: "2024-02-01 00:00:00.000Z" },
      ]),
      contentRoute({ n1: "a" }),
    ]);
    const embeddingProvider = fakeEmbeddingProvider();

    const summary = await runIncrementalSync({
      client,
      store,
      embeddingProvider,
      config: baseConfig,
    });

    expect(summary.watermarkStuck).toBe(false);
    store.close();
  });
});
