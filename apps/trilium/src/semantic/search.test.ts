import { describe, expect, it, vi } from "vitest";
import { searchSemantic } from "./search.js";
import type { ChunkHit } from "./types.js";

function fakeStore(hits: ChunkHit[]) {
  return { knnSearch: vi.fn((_embedding: number[], _limit: number) => hits) };
}

function fakeEmbeddingProvider(opts?: { embedQuery?: (text: string) => Promise<number[]> }) {
  return { embedQuery: vi.fn(opts?.embedQuery ?? (async () => [1, 0, 0, 0])) };
}

describe("searchSemantic", () => {
  it("no-ops on an undefined search term without calling the embedding provider", async () => {
    const embeddingProvider = fakeEmbeddingProvider();
    const store = fakeStore([]);
    const result = await searchSemantic(
      {
        store: store as never,
        embeddingProvider: embeddingProvider as never,
        queryTimeoutMs: 1000,
      },
      undefined,
      10,
    );
    expect(result).toEqual([]);
    expect(embeddingProvider.embedQuery).not.toHaveBeenCalled();
    expect(store.knnSearch).not.toHaveBeenCalled();
  });

  it("no-ops on a query that's pure structured filtering with no free text to embed", async () => {
    const embeddingProvider = fakeEmbeddingProvider();
    const store = fakeStore([]);
    const result = await searchSemantic(
      {
        store: store as never,
        embeddingProvider: embeddingProvider as never,
        queryTimeoutMs: 1000,
      },
      "#book #year >= 1950",
      10,
    );
    expect(result).toEqual([]);
    expect(embeddingProvider.embedQuery).not.toHaveBeenCalled();
  });

  it("embeds only the free-text portion extracted from Trilium's query language", async () => {
    const embeddingProvider = fakeEmbeddingProvider();
    const store = fakeStore([]);
    await searchSemantic(
      {
        store: store as never,
        embeddingProvider: embeddingProvider as never,
        queryTimeoutMs: 1000,
      },
      "car insurance #year >= 1950",
      10,
    );
    expect(embeddingProvider.embedQuery).toHaveBeenCalledWith("car insurance");
  });

  it("dedupes chunk-level hits to the single best-scoring chunk per note", async () => {
    const hits: ChunkHit[] = [
      {
        chunkId: "n1:1-5",
        noteId: "n1",
        startLine: 1,
        endLine: 5,
        text: "weaker chunk",
        score: 0.5,
      },
      {
        chunkId: "n1:6-10",
        noteId: "n1",
        startLine: 6,
        endLine: 10,
        text: "stronger chunk",
        score: 0.9,
      },
      {
        chunkId: "n2:1-5",
        noteId: "n2",
        startLine: 1,
        endLine: 5,
        text: "note 2 chunk",
        score: 0.7,
      },
    ];
    const store = fakeStore(hits);
    const embeddingProvider = fakeEmbeddingProvider();
    const result = await searchSemantic(
      {
        store: store as never,
        embeddingProvider: embeddingProvider as never,
        queryTimeoutMs: 1000,
      },
      "term",
      10,
    );
    expect(result).toEqual([
      { noteId: "n1", snippet: "stronger chunk", score: 0.9, startLine: 6, endLine: 10 },
      { noteId: "n2", snippet: "note 2 chunk", score: 0.7, startLine: 1, endLine: 5 },
    ]);
  });

  it("caps results at `limit`, best-scoring notes first", async () => {
    const hits: ChunkHit[] = Array.from({ length: 5 }, (_, i) => ({
      chunkId: `n${i}:1-1`,
      noteId: `n${i}`,
      startLine: 1,
      endLine: 1,
      text: `note ${i}`,
      score: i / 10,
    }));
    const store = fakeStore(hits);
    const embeddingProvider = fakeEmbeddingProvider();
    const result = await searchSemantic(
      {
        store: store as never,
        embeddingProvider: embeddingProvider as never,
        queryTimeoutMs: 1000,
      },
      "term",
      2,
    );
    expect(result).toHaveLength(2);
    expect(result[0]?.noteId).toBe("n4");
    expect(result[1]?.noteId).toBe("n3");
  });

  it("fails open (returns []) when the embedding provider throws", async () => {
    const embeddingProvider = fakeEmbeddingProvider({
      embedQuery: async () => {
        throw new Error("model not loaded");
      },
    });
    const store = fakeStore([]);
    const warn = vi.fn();
    const result = await searchSemantic(
      {
        store: store as never,
        embeddingProvider: embeddingProvider as never,
        queryTimeoutMs: 1000,
        logger: { warn },
      },
      "term",
      10,
    );
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("fails open (returns []) when the store's KNN scan throws", async () => {
    const embeddingProvider = fakeEmbeddingProvider();
    const store = {
      knnSearch: vi.fn(() => {
        throw new Error("sqlite busy");
      }),
    };
    const result = await searchSemantic(
      {
        store: store as never,
        embeddingProvider: embeddingProvider as never,
        queryTimeoutMs: 1000,
      },
      "term",
      10,
    );
    expect(result).toEqual([]);
  });

  it("fails open (returns []) when the query overruns queryTimeoutMs", async () => {
    const embeddingProvider = fakeEmbeddingProvider({
      embedQuery: () => new Promise((resolve) => setTimeout(() => resolve([1, 0, 0, 0]), 50)),
    });
    const store = fakeStore([]);
    const result = await searchSemantic(
      { store: store as never, embeddingProvider: embeddingProvider as never, queryTimeoutMs: 5 },
      "term",
      10,
    );
    expect(result).toEqual([]);
  });
});
