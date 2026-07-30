import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

// Calls Google's Gemini embeddings API directly (its own HTTP client, no
// OpenClaw provider registry, no SDK dependency) -- same choice and
// rationale as @transmitt0r/openclaw-plugin-paperless-ngx's identically
// named module: local inference has a real memory footprint (a GGUF
// model + its runtime working set) that a small always-on host may not
// have headroom for, while a remote API call only costs the
// request/response payload, at the price of note content leaving the
// machine to be embedded (see the README's Semantic search section) and
// needing an API key configured.
export const EMBEDDING_PROVIDER_ID = "gemini";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Same rationale as client.ts's DEFAULT_TIMEOUT_MS: without a bounded
// deadline, a stalled network call hangs a sync pass (or a query-time
// embed, though search.ts's own queryTimeoutMs is normally the tighter
// bound there) indefinitely.
const REQUEST_TIMEOUT_MS = 30_000;

type EmbedContentResponse = { embedding?: { values?: number[] } };
type BatchEmbedContentsResponse = { embeddings?: { values?: number[] }[] };

// Gemini's batchEmbedContents rejects a request with more than 100 items
// (confirmed live against this plugin's sibling, paperless-ngx: a
// document chunked into >100 pieces got a 400 "at most 100 requests can
// be..." error). Split into sub-batches transparently rather than
// surfacing that limit to callers.
const MAX_BATCH_SIZE = 100;

export type EmbeddingProviderHandleOptions = {
  apiKey: string;
  model: string;
  dimensions: number;
  logger?: PluginLogger;
  // Overridable for tests -- defaults to the global fetch, so tests can
  // stub it instead of making a real network call.
  fetchImpl?: typeof fetch;
};

// A thin, stateless HTTP client for Gemini's embeddings API. There's no
// local model to lazily load or idle-unload -- every call is just a
// request/response, so this class carries no warm-resource state at all.
// `unload`/`dispose` are kept as no-ops purely so handle.ts's shutdown
// path doesn't need to special-case "is there anything to dispose".
export class EmbeddingProviderHandle {
  readonly model: string;
  readonly dimensions: number;

  private readonly apiKey: string;
  private readonly logger: PluginLogger | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: EmbeddingProviderHandleOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // Query-time embedding (models.embedContent) -- Gemini has no separate
  // "query" vs. "document" input-type distinction the way some embedding
  // APIs do; the same endpoint/shape is used for both embedQuery and each
  // item of embedBatch.
  async embedQuery(text: string): Promise<number[]> {
    const response = await this.request<EmbedContentResponse>(`${this.model}:embedContent`, {
      model: `models/${this.model}`,
      content: { parts: [{ text }] },
      outputDimensionality: this.dimensions,
    });
    const values = response.embedding?.values;
    if (!values) {
      throw new Error("gemini embeddings: response missing embedding.values");
    }
    return values;
  }

  // Note-time embedding, batched via models.batchEmbedContents. Split
  // into sub-batches of at most MAX_BATCH_SIZE (sequential, not
  // concurrent -- sync.ts already bounds concurrency across notes via its
  // own embedConcurrency, so a large single note doesn't also need to fan
  // out multiple simultaneous requests against the same API key).
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const results: number[][] = [];
    for (let start = 0; start < texts.length; start += MAX_BATCH_SIZE) {
      const slice = texts.slice(start, start + MAX_BATCH_SIZE);
      results.push(...(await this.embedBatchOnce(slice)));
    }
    return results;
  }

  private async embedBatchOnce(texts: string[]): Promise<number[][]> {
    const response = await this.request<BatchEmbedContentsResponse>(
      `${this.model}:batchEmbedContents`,
      {
        requests: texts.map((text) => ({
          model: `models/${this.model}`,
          content: { parts: [{ text }] },
          outputDimensionality: this.dimensions,
        })),
      },
    );
    const embeddings = response.embeddings;
    if (!embeddings || embeddings.length !== texts.length) {
      throw new Error(
        `gemini embeddings: batch response had ${embeddings?.length ?? 0} embeddings for ${texts.length} inputs`,
      );
    }
    return embeddings.map((embedding, index) => {
      if (!embedding.values) {
        throw new Error(`gemini embeddings: batch item ${index} missing values`);
      }
      return embedding.values;
    });
  }

  // Propagates any non-2xx response (rate limit, auth failure, transient
  // 5xx) as a thrown error rather than swallowing it -- fail-open is the
  // caller's job (search.ts's try/catch+timeout for query-time embeds,
  // sync.ts's per-note catch for note-time embeds), not this client's. No
  // retry/backoff here by design for this first pass.
  private async request<T>(pathSuffix: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${GEMINI_API_BASE}/${pathSuffix}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `gemini embeddings API error (${response.status} ${response.statusText}): ${detail}`,
      );
    }
    return (await response.json()) as T;
  }

  async unload(): Promise<void> {}

  async dispose(): Promise<void> {
    await this.unload();
  }
}
