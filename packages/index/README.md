# @mycelium/index

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

## Provider swaps and rebuilds

Every embedding provider/model change must trigger a full index rebuild — a table can never
mix vectors from two different embedding spaces. This package tracks an identity fingerprint
(`provider id + model + dimensions + chunking config`) for exactly that purpose.
