# mycelium

Shared toolkit for building agent plugins over personal knowledge sources (documents, notes,
and whatever comes next) — extracted out of the [OpenClaw](https://github.com/openclaw/openclaw) plugins for
[paperless-ngx](https://github.com/Transmitt0r/openclaw-plugin-paperless-ngx) and
[Trilium Notes](https://github.com/Transmitt0r/openclaw-plugin-trilium), which had independently
grown near-identical semantic search implementations.

Three problems, three packages:

| Package | Problem it solves |
|---|---|
| [`@mycelium/embed`](./packages/embed) | "I want to use any LLM for embeddings/retrieval, not just one hardcoded provider." Pluggable client for any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, vLLM, LM Studio, ...), plus an opt-in local CPU fallback with zero API dependency. |
| [`@mycelium/index`](./packages/index) | "I want semantic search over my personal document/note corpus without running a vector DB server." A local, file-backed sqlite-vec index with incremental sync and hybrid lexical+semantic search (Reciprocal Rank Fusion). |
| [`@mycelium/mcp`](./packages/mcp) | "I want my plugin's tools usable outside one specific agent host." Bridges the same tool definitions onto a standalone MCP server, over stdio and Streamable HTTP. |

Plus [`@mycelium/tooling-config`](./packages/tooling-config): shared biome/tsconfig presets so
the standalone plugin repos this toolkit feeds stop drifting from each other.

## Why "mycelium"

The fungal network that links otherwise-separate organisms and moves nutrients between them —
which is the job here: linking separate personal-data sources to any LLM provider, over any
transport, without each plugin reinventing the same wiring.

## Development

Bun-native: Bun as the package manager, workspace resolver, and test runner. TypeScript 7,
Biome for lint/format, [Changesets](https://github.com/changesets/changesets) for versioning
and multi-package releases.

```sh
bun install
bun run build
bun run lint
bun test
```

See [AGENTS.md](./AGENTS.md) for repo layout and conventions.

## License

MIT
