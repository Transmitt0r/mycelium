# @transmitt0r/mycelium-index

A local, file-backed semantic index for personal-scale document/note corpora
(thousands, not millions, of chunks). Generalizes the `semantic/` module shared
almost line-for-line by the paperless-ngx and trilium OpenClaw plugins.

- **Store**: SQLite + [sqlite-vec](https://github.com/asg017/sqlite-vec), one file, fully
  rebuildable from the source system — never the source of truth.
- **Sync**: incremental, watermark-based, with a content-hash short-circuit so unchanged
  content is never re-embedded.
- **Search**: hybrid — your source system's own lexical/keyword search fused with semantic
  KNN via Reciprocal Rank Fusion (rank-based, not score-based, since the two are rarely on
  comparable scales).
- **Source-agnostic**: a small `SourceAdapter` interface is the only thing a new source
  system needs to implement.

## Usage

```ts
import { openSemanticIndex } from "@transmitt0r/mycelium-index";
import { createEmbeddingProvider } from "@transmitt0r/mycelium-embed";

const result = await openSemanticIndex({
  embeddingProvider: createEmbeddingProvider({
    provider: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    model: "text-embedding-3-small",
    dimensions: 1536,
  }),
  dbPath: "./semantic-index.db",
  chunkTokens: 400,
  chunkOverlap: 80,
  embedConcurrency: 2,
  maxItemsPerSync: 200,
  queryTimeoutMs: 3_000,
});
if (!result.available) throw new Error(result.reason);

await result.index.sync(mySourceAdapter);
const matches = await result.index.search("invoice from March", 5);
```

`mySourceAdapter` is whatever implements `SourceAdapter` for the system being indexed —
paperless-ngx, Trilium, or anything else with a "list what changed since X" + "fetch content by
id" shape.

## Runtime requirement

The sqlite-vec backing needs `node:sqlite`'s extension-loading support, which Bun does not
implement (verified directly — Bun's bundled sqlite3 build has extension loading compiled out).
Run this package under Node.

## Provider swaps and rebuilds

Every embedding provider/model change must trigger a full index rebuild — a table can never
mix vectors from two different embedding spaces. This package tracks an identity fingerprint
(`provider id + model + dimensions + chunking config`) for exactly that purpose.
