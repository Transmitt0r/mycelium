# @transmitt0r/mycelium-embed

Pluggable embedding (and eventually chat) client. One `EmbeddingProvider` interface,
two implementations:

- **openai-compatible** — talks to any `/v1/embeddings`-shaped endpoint: OpenAI, OpenRouter,
  Ollama, vLLM, llama.cpp server, LM Studio, etc. Configure `baseUrl` + `apiKey`.
- **local** — an opt-in, zero-API-dependency fallback that runs a small ONNX model
  (e.g. `Xenova/all-MiniLM-L6-v2`) in-process via `@huggingface/transformers`. **Not** enabled
  by default — see the note in `src/index.ts` about why.

## Design notes

- No provider-specific constant (batch size limits, timeouts) should leak into the shared
  interface — those are per-implementation.
- A provider/model change must be detectable by consumers (e.g. to trigger a vector index
  rebuild) — `id`, `model`, and `dimensions` on `EmbeddingProvider` exist for exactly that.
