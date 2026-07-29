// Runs under plain Node against the built dist/ output (not bun test) —
// sqlite-vec's extension-loading needs node:sqlite, which Bun does not
// implement. See src/host.ts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { openSemanticIndex } from "../dist/index.js";

// Deterministic fake: a 4-dim "embedding" derived from character codes, so
// texts sharing more characters score more similar without needing a real model.
function fakeEmbeddingProvider({ id = "fake", model = "fake-model", dimensions = 4 } = {}) {
  return {
    id,
    model,
    dimensions,
    async embedQuery(text) {
      return embed(text, dimensions);
    },
    async embedBatch(texts) {
      return texts.map((text) => embed(text, dimensions));
    },
  };
}

function embed(text, dimensions) {
  const vec = new Array(dimensions).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[text.charCodeAt(i) % dimensions] += 1;
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

function fakeAdapter(items) {
  return {
    name: "fake",
    async *listChanged(since) {
      const sorted = [...items].sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
      for (const item of sorted) {
        // Inclusive at the boundary (gte, not gt) — see the SourceAdapter
        // docstring for why an exclusive filter here would be a real bug.
        if (since && item.modifiedAt < since) continue;
        yield { id: item.id, contentHash: item.contentHash, modifiedAt: item.modifiedAt };
      }
    },
    async fetchContent(id) {
      const item = items.find((i) => i.id === id);
      if (!item) throw new Error(`no such item: ${id}`);
      return item.content;
    },
  };
}

const openHandles = [];
afterEach(() => {
  for (const handle of openHandles.splice(0)) handle.close();
});

async function open(config = {}) {
  const result = await openSemanticIndex({
    embeddingProvider: fakeEmbeddingProvider(),
    dbPath: ":memory:",
    chunkTokens: 400,
    chunkOverlap: 80,
    embedConcurrency: 2,
    maxItemsPerSync: 200,
    queryTimeoutMs: 3_000,
    ...config,
  });
  assert.equal(result.available, true, result.available ? "" : result.reason);
  openHandles.push(result.index);
  return result.index;
}

describe("openSemanticIndex + sync + search (Node, real sqlite-vec)", () => {
  test("syncs sources and finds the most relevant one by search term", async () => {
    const index = await open();
    const adapter = fakeAdapter([
      {
        id: 1,
        contentHash: "h1",
        modifiedAt: "2026-01-01T00:00:00Z",
        content: "apples and oranges",
      },
      {
        id: 2,
        contentHash: "h2",
        modifiedAt: "2026-01-02T00:00:00Z",
        content: "quarterly tax filing",
      },
      {
        id: 3,
        contentHash: "h3",
        modifiedAt: "2026-01-03T00:00:00Z",
        content: "orange marmalade recipe",
      },
    ]);

    const summary = await index.sync(adapter);
    assert.equal(summary.processed, 3);
    assert.equal(summary.failed, 0);
    assert.equal(index.sourceCount(), 3);

    const results = await index.search("orange", 5);
    assert.ok(results.length > 0);
    assert.ok(
      results.some((r) => r.sourceId === "1" || r.sourceId === "3"),
      "expected an orange-related source to match",
    );
  });

  test("a second sync pass with no changes skips everything", async () => {
    const index = await open();
    const items = [
      { id: 1, contentHash: "h1", modifiedAt: "2026-01-01T00:00:00Z", content: "hello world" },
    ];
    const adapter = fakeAdapter(items);

    const first = await index.sync(adapter);
    assert.equal(first.processed, 1);

    const second = await index.sync(adapter);
    assert.equal(second.processed, 0);
    assert.equal(second.skippedUnchanged, 1);
  });

  test("a changed contentHash re-embeds the source", async () => {
    const index = await open();
    const items = [
      { id: 1, contentHash: "h1", modifiedAt: "2026-01-01T00:00:00Z", content: "version one" },
    ];
    const adapter = fakeAdapter(items);
    await index.sync(adapter);

    items[0].contentHash = "h2";
    items[0].modifiedAt = "2026-01-02T00:00:00Z";
    items[0].content = "version two";
    const second = await index.sync(adapter);
    assert.equal(second.processed, 1);
    assert.equal(second.skippedUnchanged, 0);
  });

  test("search returns nothing before any sync, and fails open on an empty term", async () => {
    const index = await open();
    assert.deepEqual(await index.search("anything", 5), []);
    assert.deepEqual(await index.search(undefined, 5), []);
  });

  test("reopening with a different embedding model rebuilds the index from scratch", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mycelium-index-"));
    const dbPath = path.join(dir, "index.db");
    try {
      const first = await open({
        dbPath,
        embeddingProvider: fakeEmbeddingProvider({ model: "model-a", dimensions: 4 }),
      });
      await first.sync(
        fakeAdapter([
          { id: 1, contentHash: "h1", modifiedAt: "2026-01-01T00:00:00Z", content: "x" },
        ]),
      );
      assert.equal(first.sourceCount(), 1);
      first.close();
      openHandles.pop();

      // Different model -> different identity fingerprint -> rebuild, even
      // though it's the same dbPath and same dimensionality.
      const second = await open({
        dbPath,
        embeddingProvider: fakeEmbeddingProvider({ model: "model-b", dimensions: 4 }),
      });
      assert.equal(
        second.sourceCount(),
        0,
        "old vectors from model-a must not survive a model change",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
