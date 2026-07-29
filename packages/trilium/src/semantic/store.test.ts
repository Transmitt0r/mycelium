import { describe, expect, it } from "vitest";
import { SemanticIndexStore } from "./store.js";
import type { IndexIdentity } from "./types.js";

// Real node:sqlite + real sqlite-vec extension, in-memory -- no fake/mock
// here, since the whole point of this module is the SQL/vec0 query
// actually being correct. Only the embeddings themselves are synthetic.
async function openMemoryStore(dimensions = 4) {
  const opened = await SemanticIndexStore.open(":memory:", dimensions);
  if (!opened.available) {
    throw new Error(`test setup: sqlite-vec unavailable in this environment: ${opened.reason}`);
  }
  return opened.store;
}

const IDENTITY: IndexIdentity = {
  providerId: "gemini",
  model: "test-model",
  dimensions: 4,
  chunkTokens: 400,
  chunkOverlap: 80,
};

describe("SemanticIndexStore", () => {
  it("opens an in-memory store and reports no identity before first use", async () => {
    const store = await openMemoryStore();
    expect(store.getIdentity()).toBeUndefined();
    store.close();
  });

  it("rebuild() records the identity so a later open can detect drift", async () => {
    const store = await openMemoryStore();
    store.rebuild(IDENTITY);
    expect(store.getIdentity()).toEqual(IDENTITY);
    store.close();
  });

  it("upsertNote stores chunks and their blobId, retrievable by note id", async () => {
    const store = await openMemoryStore();
    store.rebuild(IDENTITY);
    store.upsertNote("note1", "blob-a", "2024-01-01 00:00:00.000Z", [
      {
        id: "note1:1-5",
        startLine: 1,
        endLine: 5,
        text: "hello world",
        hash: "chunk-hash",
        embedding: [1, 0, 0, 0],
      },
    ]);
    expect(store.getNoteBlobId("note1")).toBe("blob-a");
    expect(store.noteCount()).toBe(1);
    store.close();
  });

  it("upsertNote replaces previous chunks/vectors for the same note", async () => {
    const store = await openMemoryStore();
    store.rebuild(IDENTITY);
    store.upsertNote("note1", "blob-a", "2024-01-01 00:00:00.000Z", [
      {
        id: "note1:1-5",
        startLine: 1,
        endLine: 5,
        text: "old chunk",
        hash: "h1",
        embedding: [1, 0, 0, 0],
      },
    ]);
    store.upsertNote("note1", "blob-b", "2024-01-02 00:00:00.000Z", [
      {
        id: "note1:1-3",
        startLine: 1,
        endLine: 3,
        text: "new chunk",
        hash: "h2",
        embedding: [0, 1, 0, 0],
      },
    ]);
    expect(store.getNoteBlobId("note1")).toBe("blob-b");
    const hits = store.knnSearch([0, 1, 0, 0], 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toBe("new chunk");
    store.close();
  });

  it("deleteNote removes both chunk rows and their vectors (bulk, not one DELETE per chunk)", async () => {
    const store = await openMemoryStore();
    store.rebuild(IDENTITY);
    store.upsertNote("note1", "blob-a", "2024-01-01 00:00:00.000Z", [
      { id: "note1:1-5", startLine: 1, endLine: 5, text: "a", hash: "h1", embedding: [1, 0, 0, 0] },
      {
        id: "note1:6-10",
        startLine: 6,
        endLine: 10,
        text: "b",
        hash: "h2",
        embedding: [0, 1, 0, 0],
      },
    ]);
    store.deleteNote("note1");
    expect(store.getNoteBlobId("note1")).toBeUndefined();
    expect(store.noteCount()).toBe(0);
    expect(store.knnSearch([1, 0, 0, 0], 10)).toHaveLength(0);
    store.close();
  });

  it("rebuild() wipes all existing notes/chunks/vectors and the sync watermark", async () => {
    const store = await openMemoryStore();
    store.rebuild(IDENTITY);
    store.upsertNote("note1", "blob-a", "2024-01-01 00:00:00.000Z", [
      {
        id: "note1:1-5",
        startLine: 1,
        endLine: 5,
        text: "text",
        hash: "h1",
        embedding: [1, 0, 0, 0],
      },
    ]);
    store.setSyncWatermark("2024-06-01 00:00:00.000Z");

    store.rebuild({ ...IDENTITY, model: "different-model" });

    expect(store.noteCount()).toBe(0);
    expect(store.getSyncWatermark()).toBeUndefined();
    expect(store.getIdentity()?.model).toBe("different-model");
    store.close();
  });

  it("knnSearch ranks chunks by cosine similarity, best first", async () => {
    const store = await openMemoryStore();
    store.rebuild(IDENTITY);
    store.upsertNote("note1", "blob-a", "2024-01-01 00:00:00.000Z", [
      {
        id: "note1:1-1",
        startLine: 1,
        endLine: 1,
        text: "identical",
        hash: "h1",
        embedding: [1, 0, 0, 0],
      },
    ]);
    store.upsertNote("note2", "blob-b", "2024-01-01 00:00:00.000Z", [
      {
        id: "note2:1-1",
        startLine: 1,
        endLine: 1,
        text: "close",
        hash: "h2",
        embedding: [0.9, 0.1, 0, 0],
      },
    ]);
    store.upsertNote("note3", "blob-c", "2024-01-01 00:00:00.000Z", [
      {
        id: "note3:1-1",
        startLine: 1,
        endLine: 1,
        text: "orthogonal",
        hash: "h3",
        embedding: [0, 1, 0, 0],
      },
    ]);

    const hits = store.knnSearch([1, 0, 0, 0], 10);
    expect(hits.map((h) => h.noteId)).toEqual(["note1", "note2", "note3"]);
    expect(hits[0]?.score).toBeCloseTo(1, 5);
    expect(hits[2]?.score).toBeCloseTo(0, 5);
    const scores = hits.map((h) => h.score);
    expect(scores[0]).toBeGreaterThan(scores[1] ?? Number.NaN);
    expect(scores[1]).toBeGreaterThan(scores[2] ?? Number.NaN);
    store.close();
  });

  it("knnSearch respects the limit", async () => {
    const store = await openMemoryStore();
    store.rebuild(IDENTITY);
    for (let i = 1; i <= 5; i++) {
      store.upsertNote(`note${i}`, `blob-${i}`, "2024-01-01 00:00:00.000Z", [
        {
          id: `note${i}:1-1`,
          startLine: 1,
          endLine: 1,
          text: `doc ${i}`,
          hash: `h${i}`,
          embedding: [i, 0, 0, 0],
        },
      ]);
    }
    const hits = store.knnSearch([1, 0, 0, 0], 2);
    expect(hits).toHaveLength(2);
    store.close();
  });

  it("sync watermark round-trips", async () => {
    const store = await openMemoryStore();
    store.rebuild(IDENTITY);
    expect(store.getSyncWatermark()).toBeUndefined();
    store.setSyncWatermark("2024-05-01 12:00:00.000Z");
    expect(store.getSyncWatermark()).toBe("2024-05-01 12:00:00.000Z");
    store.close();
  });

  it("rejects a non-positive-integer dimensions value", async () => {
    const opened = await SemanticIndexStore.open(":memory:", 0);
    expect(opened.available).toBe(false);
  });
});
