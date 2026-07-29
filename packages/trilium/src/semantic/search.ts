import type { EmbeddingProviderHandle } from "./embedding-provider.js";
import { extractFreeTextTerms } from "./query.js";
import type { SemanticIndexStore } from "./store.js";
import type { SemanticMatch } from "./types.js";

export type SearchDeps = {
  store: SemanticIndexStore;
  embeddingProvider: EmbeddingProviderHandle;
  queryTimeoutMs: number;
  logger?: { warn: (message: string) => void };
};

// Oversample chunk-level KNN hits before deduping to one row per note, so
// a note doesn't get dropped just because its single best-matching chunk
// didn't make it into a `limit`-sized raw scan. Same constant/reasoning as
// paperless-ngx's identically named module.
const CANDIDATE_OVERSAMPLE = 4;

// The real fetchSemanticMatches implementation used by
// trilium_search_notes: pulls the plain-text portion out of Trilium's
// query-language `search` string (see extractFreeTextTerms -- a pure
// label/relation/property filter has nothing to embed), embeds it, does a
// chunk-level KNN scan, and collapses it to the single best-scoring chunk
// per note. Never throws -- any embedding-provider or SQLite error, or a
// call that overruns `queryTimeoutMs`, resolves to `[]` so
// trilium_search_notes always still returns Trilium's own lexical results
// untouched (fail open).
export async function searchSemantic(
  deps: SearchDeps,
  rawSearch: string | undefined,
  limit: number,
): Promise<SemanticMatch[]> {
  const searchTerm = rawSearch ? extractFreeTextTerms(rawSearch) : "";
  if (!searchTerm) return [];

  try {
    return await withTimeout(runQuery(deps, searchTerm, limit), deps.queryTimeoutMs);
  } catch (err) {
    deps.logger?.warn(
      `semantic search: query failed, falling back to lexical-only results: ${describeError(err)}`,
    );
    return [];
  }
}

async function runQuery(
  deps: SearchDeps,
  searchTerm: string,
  limit: number,
): Promise<SemanticMatch[]> {
  const queryEmbedding = await deps.embeddingProvider.embedQuery(searchTerm);
  const hits = deps.store.knnSearch(queryEmbedding, Math.max(limit, 1) * CANDIDATE_OVERSAMPLE);

  const bestPerNote = new Map<
    string,
    { snippet: string; score: number; startLine: number; endLine: number }
  >();
  for (const hit of hits) {
    const existing = bestPerNote.get(hit.noteId);
    if (!existing || hit.score > existing.score) {
      bestPerNote.set(hit.noteId, {
        snippet: hit.text,
        score: hit.score,
        startLine: hit.startLine,
        endLine: hit.endLine,
      });
    }
  }

  return [...bestPerNote.entries()]
    .map(([noteId, { snippet, score, startLine, endLine }]) => ({
      noteId,
      snippet,
      score,
      startLine,
      endLine,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`semantic query timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
