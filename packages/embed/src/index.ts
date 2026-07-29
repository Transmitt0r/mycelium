export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  embedQuery(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingProviderConfig {
  // "local" is opt-in only — see AGENTS.md for why.
  provider: "openai-compatible" | "local";
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

// TODO: createOpenAICompatibleEmbeddingProvider(config) — via @ai-sdk/openai-compatible.
// TODO: createLocalEmbeddingProvider(config) — via @huggingface/transformers.
