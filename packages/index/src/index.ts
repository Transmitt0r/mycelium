import type { EmbeddingProvider } from "@mycelium/embed";

// Entity-shape differences between source systems (paperless documents,
// trilium notes, ...) live behind this adapter; everything else here is source-agnostic.
export interface SourceAdapter<TId extends string | number> {
  readonly sourceId: string;
  listChanged(
    since: string | null,
  ): AsyncIterable<{ id: TId; contentHash: string; modifiedAt: string }>;
  fetchContent(id: TId): Promise<string>;
}

export interface SemanticIndexConfig {
  embeddingProvider: EmbeddingProvider;
  dbPath: string;
  chunkTokens?: number;
  chunkOverlap?: number;
}

export interface RankedHit<TId> {
  id: TId;
  score: number;
}

// Merges ranked lists by rank position, not raw score — lexical and semantic
// scores are rarely on comparable scales. k=60 per the original RRF paper.
export function reciprocalRankFusion<TId extends string | number>(
  rankedLists: TId[][],
  k = 60,
): RankedHit<TId>[] {
  const scores = new Map<TId, number>();
  for (const list of rankedLists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

// TODO: SemanticIndexStore (sqlite-vec schema, identity-drift rebuild, knnSearch).
// TODO: runIncrementalSync(adapter, store, embeddingProvider) — watermark + content-hash
//       short-circuit, bounded concurrency.
// TODO: searchSemantic(store, embeddingProvider, query) — timeout-bounded, fails open to [].
