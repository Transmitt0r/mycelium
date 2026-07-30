// Shared types for the plugin-owned semantic search backend (see
// src/semantic/handle.ts for how these are wired together, and the seam
// comment atop src/tools/notes.ts for how this integrates with
// trilium_search_notes). Architecture mirrors
// @transmitt0r/openclaw-plugin-paperless-ngx's src/semantic/ closely --
// same SQLite+sqlite-vec store, same Gemini embedding backend, same RRF
// fusion approach -- adapted for Trilium's data model where it differs
// (string noteIds instead of integer document ids; no per-item `content`
// on a search/list response, only a `blobId` content-hash, so the sync
// short-circuit compares that instead of hashing fetched content).

// The agent-facing contract trilium_search_notes merges into its lexical
// results. startLine/endLine let the caller chain straight into
// trilium_read_note_content instead of only getting matched text with no
// way to locate it in the note.
export type SemanticMatch = {
  noteId: string;
  snippet: string;
  score: number;
  startLine: number;
  endLine: number;
};

// One markdown-chunked span of a note's (HTML-stripped) content, with line
// numbers relative to the same normalized text trilium_read_note_content
// numbers against. `id` is a stable per-chunk key (`${noteId}:${startLine}-
// ${endLine}`) used as the vec0 table's primary key.
export type ChunkRecord = {
  id: string;
  noteId: string;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
};

// A chunk-level hit from the vector index, before doc-level dedup/fusion.
export type ChunkHit = {
  chunkId: string;
  noteId: string;
  startLine: number;
  endLine: number;
  text: string;
  // Cosine similarity in [-1, 1] (higher is better) -- already converted
  // from sqlite-vec's distance metric, never a raw distance, so callers
  // never have to remember which direction "better" points.
  score: number;
};

// Canonical fingerprint of "what produced this index". Compared against
// what's stored on disk on every startup; any mismatch means the stored
// vectors were produced by a different model/dimensionality/chunking
// scheme and can't be mixed with new ones, so the index is wiped and
// rebuilt from scratch instead.
export type IndexIdentity = {
  providerId: string;
  model: string;
  dimensions: number;
  chunkTokens: number;
  chunkOverlap: number;
};

export function identitiesMatch(a: IndexIdentity, b: IndexIdentity): boolean {
  return (
    a.providerId === b.providerId &&
    a.model === b.model &&
    a.dimensions === b.dimensions &&
    a.chunkTokens === b.chunkTokens &&
    a.chunkOverlap === b.chunkOverlap
  );
}

// Tuned for a personal/small-team Trilium vault (hundreds to low
// thousands of notes on a home server, no GPU) -- the same envelope
// paperless-ngx's design targets, not a multi-tenant/enterprise scale.
export type SemanticSearchConfig = {
  enabled: boolean;
  // A Gemini embeddings model id, e.g. "gemini-embedding-2" (no "models/"
  // prefix -- embedding-provider.ts adds that when building the request
  // body/URL).
  model: string;
  dimensions: number;
  chunkTokens: number;
  chunkOverlap: number;
  indexPath: string;
  // How often a background incremental sync pass runs.
  syncIntervalMs: number;
  // Trilium's ETAPI /notes search endpoint has no pagination/offset
  // param (only `limit`), unlike paperless-ngx's page/page_size -- see
  // sync.ts's own doc comment for how this shapes the two-tier
  // backfill/incremental design these two limits feed.
  initialBackfillLimit: number;
  incrementalSyncLimit: number;
  // Bounds concurrent per-note fetch+embed tasks during a sync pass.
  embedConcurrency: number;
  // Fail-open budget for a single query-time embed + KNN scan.
  queryTimeoutMs: number;
};

export const DEFAULT_SEMANTIC_SEARCH_CONFIG: Omit<SemanticSearchConfig, "indexPath"> = {
  enabled: true,
  // Same choice/rationale as paperless-ngx: a remote API call has no local
  // memory footprint, unlike local GGUF inference (which was tried there
  // first and dropped after an OOM on a resource-constrained host).
  model: "gemini-embedding-2",
  // 768 is the smallest of Gemini's three supported outputDimensionality
  // values (768/1536/3072), chosen for the cheapest storage/scan cost.
  dimensions: 768,
  chunkTokens: 400,
  chunkOverlap: 80,
  syncIntervalMs: 15 * 60_000,
  // A one-shot cap generous enough to cover a typical personal vault's
  // full history on the very first backfill pass -- see sync.ts for what
  // happens (a logged warning, not silent truncation) when a vault
  // exceeds this.
  initialBackfillLimit: 2000,
  // Subsequent passes only need to sweep recently-changed notes, not the
  // whole vault again.
  incrementalSyncLimit: 200,
  // Bumped from the paperless-ngx sibling's default of 2: this plugin's
  // per-note work is a single content GET + one embedBatch call, lighter
  // per-item than paperless-ngx's OCR-content path, and 2 was found (in
  // review) to make a multi-thousand-note first backfill take on the
  // order of tens of minutes at the default initialBackfillLimit. Still
  // conservative relative to Gemini's own rate limits -- see the README's
  // Semantic search section for the resulting expected first-backfill
  // duration.
  embedConcurrency: 4,
  queryTimeoutMs: 3_000,
};
