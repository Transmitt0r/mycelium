// Shared types for the plugin-owned semantic search backend (see
// src/semantic/handle.ts for how these are wired together, and the seam
// comment atop src/tools/documents.ts for how this integrates with
// paperless_search_documents).

// The agent-facing contract paperless_search_documents merges into its
// lexical results. Intentionally the same shape the seam in
// src/tools/documents.ts already declared -- this module is what makes it
// real instead of a stub. startLine/endLine (added after the fact -- the
// original seam only had documentId/snippet/score) are the matched chunk's
// span so the caller can chain straight into paperless_read_document
// instead of only getting the snippet text with no way to locate it in the
// document. Same CRLF/CR-normalized line numbering as ChunkRecord/ChunkHit
// below.
export type SemanticMatch = {
  documentId: number;
  snippet: string;
  score: number;
  startLine: number;
  endLine: number;
};

// One markdown-chunked span of a document's OCR content, with line numbers
// relative to the same CRLF/CR-normalized text paperless_read_document
// numbers against (see normalizeLineEndings in documents.ts). `id` is a
// stable per-chunk key (`${documentId}:${chunkIndex}`) used as the vec0
// table's primary key.
export type ChunkRecord = {
  id: string;
  documentId: number;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
};

// A chunk-level hit from the vector index, before doc-level dedup/fusion.
export type ChunkHit = {
  chunkId: string;
  documentId: number;
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
// rebuilt from scratch instead. `providerId` is currently always
// EMBEDDING_PROVIDER_ID from embedding-provider.ts (there's only one
// embedding backend, Gemini's embeddings API) -- kept as its own field
// rather than folded away so a future change of embedding backend is still
// recognized as an identity change and triggers a rebuild, the same as a
// model/dimensions change does.
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

// Tuned for the reference deployment (2 vCPU / 4GB RAM, no GPU, 600-6000
// documents) called out in the design brief, not for the 100k-document
// envelope the architecture merely has to not fall over under.
export type SemanticSearchConfig = {
  enabled: boolean;
  // A Gemini embeddings model id, e.g. "gemini-embedding-2" (no "models/"
  // prefix -- embedding-provider.ts adds that when building the request
  // body/URL). There's no local runtime to configure here: embedding calls
  // are plain HTTP requests to Google's API (see embedding-provider.ts).
  model: string;
  dimensions: number;
  chunkTokens: number;
  chunkOverlap: number;
  indexPath: string;
  // How often a background incremental sync pass runs.
  syncIntervalMs: number;
  // Upper bound on documents processed in a single sync pass, so one pass
  // can't monopolize a 2 vCPU box indefinitely -- the checkpoint watermark
  // makes it safe to pick up the rest on the next pass.
  maxDocumentsPerSync: number;
  // Bounds concurrent embedBatch calls during sync (runWithConcurrency).
  // Now a rate-limit/concurrency courtesy toward Gemini's API rather than a
  // local-CPU-contention concern, but the knob (and its default) carries
  // over unchanged.
  embedConcurrency: number;
  // Fail-open budget for a single query-time embed + KNN scan.
  queryTimeoutMs: number;
};

export const DEFAULT_SEMANTIC_SEARCH_CONFIG: Omit<SemanticSearchConfig, "indexPath"> = {
  enabled: true,
  // Gemini's embeddings model. Chosen over local inference (an earlier
  // design, EmbeddingGemma-300m via node-llama-cpp) after a live deployment
  // showed a real embed call hanging and getting SIGKILLed: the reference
  // box had ~376MB free RAM and zero swap, nowhere near enough headroom for
  // a 300MB GGUF model + llama.cpp's own working set alongside everything
  // else already running. A remote API call has no local memory footprint
  // beyond the request/response payload.
  model: "gemini-embedding-2",
  // 768 is the smallest of Gemini's three supported outputDimensionality
  // values (768/1536/3072 -- arbitrary values like the prior 256 default
  // are rejected), chosen for the cheapest storage/scan cost of the
  // supported set. Unlike node-llama-cpp, Gemini renormalizes truncated
  // embeddings server-side, so no client-side Matryoshka
  // truncate-and-renormalize step is needed here.
  dimensions: 768,
  chunkTokens: 400,
  chunkOverlap: 80,
  syncIntervalMs: 15 * 60_000,
  maxDocumentsPerSync: 200,
  embedConcurrency: 2,
  queryTimeoutMs: 3_000,
};
