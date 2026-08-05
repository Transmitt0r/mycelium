# openclaw-plugin-paperless-ngx

[![CI](https://github.com/Transmitt0r/openclaw-plugin-paperless-ngx/actions/workflows/ci.yml/badge.svg)](https://github.com/Transmitt0r/openclaw-plugin-paperless-ngx/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An [OpenClaw](https://docs.openclaw.ai) plugin for [paperless-ngx](https://docs.paperless-ngx.com/).

It registers a small, general-purpose set of agent tools over the paperless-ngx REST API, with a
deliberate focus on retrieval: search documents, get a document's metadata, read a document's
content (bounded, page-able), pattern-search within a document, patch a document, and list/create
tags, correspondents, and document types. Tools are split by *access pattern* (search vs. read vs.
pattern-search), not by resource type, and are bounded by default rather than pulling a document's
full OCR text into context unless a caller specifically reads it that way.

## Install

```bash
openclaw plugins install clawhub:transmitt0r/openclaw-plugin-paperless-ngx
```

Or for local development, point OpenClaw at a built copy of this repo.

## Configure

The plugin needs the base URL of your paperless-ngx instance and an API token
(Settings → My Profile → API Token in paperless-ngx):

```json
{
  "plugins": {
    "entries": {
      "paperless-ngx": {
        "config": {
          "baseUrl": "https://paperless.example.com",
          "apiToken": "your-api-token"
        }
      }
    }
  }
}
```

`apiToken` also accepts a [SecretRef](https://docs.openclaw.ai/cli/config) instead of a plain string, so it doesn't have to sit in `openclaw.json` in cleartext:

```bash
openclaw config set plugins.entries.paperless-ngx.config.apiToken \
  --ref-provider default --ref-source env --ref-id PAPERLESS_TOKEN
```

(or `--ref-source exec`/`file` for a password manager CLI, vault, etc.)

## Tools

| Tool | Description |
| --- | --- |
| `paperless_search_documents` | Search/filter documents (full-text search, correspondent, document type, tag, date range, ordering, pagination), or batch-fetch by `ids`. Never returns OCR content — a `content_snippet` around the match is included instead when `search`/`query` is set. Also includes a link to each document in the paperless-ngx web UI and correspondent/document type/tag names resolved alongside their ids. `search` is hybrid lexical+semantic under the hood (see below) — no separate param or tool for it. |
| `paperless_get_document` | Fetch a single document's metadata by id. Same automatic name resolution as `paperless_search_documents`. Never returns raw content; pass `excerpt_search` for a short `content_snippet`-style excerpt around one term. |
| `paperless_read_document` | Read a document's OCR content, bounded to a line range (capped at 500 lines/call, defaults to the first 200 if no range is given). Page through a longer document by following up with `start_line` past what you've already read (`total_lines` in the response tells you when there's more). |
| `paperless_search_document_content` | Search one document's OCR content for a pattern (like `grep -n -C`) without reading the whole document into context — returns matching lines plus surrounding context. |
| `paperless_update_document` | Patch a document's title, correspondent, document type, tags, or created date. Use `tags` for a full replacement, or `add_tag_ids`/`remove_tag_ids` to adjust tags without disturbing the rest. Never touches `storage_path`. OCR `content` is omitted from the response unless `fields` explicitly includes `"content"` (capped at 500 lines, same as `paperless_read_document`). |
| `paperless_list_taxonomy` | List tags, correspondents, or document types (`kind: "tag" \| "correspondent" \| "document_type"`), optionally filtered by name. Tags additionally resolve parent/children ids to names. |
| `paperless_create_taxonomy_term` | Create a new tag, correspondent, or document type (`kind`). `parent_id` is only meaningful for `kind: "tag"`. |

There's deliberately no delete tool in this first pass.

### Semantic search

`paperless_search_documents` understands meaning, not just keywords — searching "car insurance"
also finds a document whose text only ever says "Kfz-Haftpflichtversicherung". This happens
automatically inside the existing `search` param; there's no separate tool or mode to choose.

This needs an embedding provider configured, and by default sends data off your machine: document
OCR content and your search terms are sent to whatever endpoint you configure to be embedded.
**Without `semanticSearch.embedding` fully configured, this stays off automatically** —
`paperless_search_documents` silently falls back to today's keyword-only (lexical) behavior, the
same way it fails open if the embedding endpoint is unreachable, rate limits you, or errors for any
other reason.

Powered by [`@transmitt0r/mycelium-embed`](https://www.npmjs.com/package/@transmitt0r/mycelium-embed): any OpenAI-compatible
`/v1/embeddings` endpoint works — OpenAI, [OpenRouter](https://openrouter.ai), Ollama, vLLM, LM
Studio, and so on. `baseUrl`, `apiKey`, `model`, and `dimensions` are all required (models vary by
endpoint, so there's no universal default to fall back to):

```json
{
  "plugins": {
    "entries": {
      "paperless-ngx": {
        "config": {
          "semanticSearch": {
            "embedding": {
              "baseUrl": "https://openrouter.ai/api/v1",
              "apiKey": "your-api-key",
              "model": "text-embedding-3-small",
              "dimensions": 1536
            }
          }
        }
      }
    }
  }
}
```

Or run entirely on-CPU with zero API calls, opt in explicitly with `"provider": "local"`
(`baseUrl`/`apiKey` aren't needed there — `model`/`dimensions` default to a small bundled ONNX
model). This is never chosen automatically: an earlier in-process local-inference attempt got
OOM-killed in production on a memory-constrained host, so treat it as something to enable
deliberately on a box with enough headroom, not a drop-in default.

`semanticSearch.embedding.apiKey` accepts a [SecretRef](https://docs.openclaw.ai/cli/config) too,
same as `apiToken` above. Once configured, the index builds up in the background; to turn it back
off or move where its local index file lives:

```json
{
  "semanticSearch": {
    "enabled": false,
    "indexPath": "/custom/path/semantic-index.db"
  }
}
```

## Standalone MCP server

These tools also run outside OpenClaw entirely, as an ordinary [MCP](https://modelcontextprotocol.io)
server (stdio or Streamable HTTP), via [`@transmitt0r/mycelium-mcp`](https://www.npmjs.com/package/@transmitt0r/mycelium-mcp).
Useful for any MCP client -- Claude Desktop, Claude Code, etc. -- not just OpenClaw.

Configuration is env vars instead of `openclaw.json`:

| Env var | Required | Notes |
| --- | --- | --- |
| `PAPERLESS_BASE_URL` | yes | Same as `baseUrl` above |
| `PAPERLESS_API_TOKEN` | yes | Same as `apiToken` above -- always a plain string here, no SecretRef support (that's an OpenClaw config-system concept) |
| `PAPERLESS_BASE_URL_FILE` / `PAPERLESS_API_TOKEN_FILE` | no | Docker-secret variants: path to a file whose trimmed contents are used instead of the plain env var above (the `_FILE` convention used by the postgres image and friends). Takes precedence when set |
| `PAPERLESS_SEMANTIC_SEARCH_ENABLED` | no | Set to `true`/`false` to enable/disable (defaults on, same fail-open behavior as the plugin). Only the exact strings `"true"`/`"false"` are accepted; any other value aborts startup |
| `PAPERLESS_SEMANTIC_INDEX_PATH` | no | Defaults under `~/.mycelium/paperless-ngx/` |
| `PAPERLESS_EMBEDDING_PROVIDER` | no | `openai-compatible` (default) or `local` -- see the Semantic search section above |
| `PAPERLESS_EMBEDDING_BASE_URL` / `PAPERLESS_EMBEDDING_API_KEY` / `PAPERLESS_EMBEDDING_MODEL` / `PAPERLESS_EMBEDDING_DIMENSIONS` | see above | Required together for the `openai-compatible` provider, same as `semanticSearch.embedding.*` above |
| `PAPERLESS_READ_ONLY` | no | Set to exactly `true` to register only the read tools (document search, get/read, content search, taxonomy list) -- the write tools are never registered at all, so they can't be listed or called. Good defense-in-depth whenever the server is exposed over HTTP -- but it trims the tool list only; it is **not** a substitute for authenticating the HTTP transport. Any unrecognized non-empty value fails startup rather than silently shipping a writable server |
| `MCP_TRANSPORT` | no | `stdio` (default) or `http`. Only `stdio`/`http` (or unset/empty) are accepted; any other value aborts startup instead of silently falling back |
| `MCP_PORT` / `MCP_HTTP_PATH` | no | Only used when `MCP_TRANSPORT=http`; default to `3000` / `/mcp`. `MCP_PORT` must be a decimal integer (1–65535) |
| `MCP_BIND_HOST` | no | Only used when `MCP_TRANSPORT=http`; default `127.0.0.1` (loopback-only). Set to `0.0.0.0` to expose the server on all interfaces (e.g. a bridged Docker network behind a reverse proxy) — always an explicit choice, never the default |

```bash
pnpm run build
PAPERLESS_BASE_URL=https://paperless.example.com PAPERLESS_API_TOKEN=your-api-token \
  pnpm run start:mcp
```

There's no npm `bin` entry for this yet -- `node dist/mcp-server.js` (or `pnpm run start:mcp`) is
the current way to run it outside a container. A `Dockerfile` is available too (build from the
monorepo root, not this directory -- see the Dockerfile's own header comment for the exact
command); it isn't published to any registry, so build it locally.

## Skills

The plugin bundles one skill (`skills/paperless`) that OpenClaw picks up automatically once
it's installed: on-demand document search and retrieval ("find my car insurance policy", "what's
the policy number on that Allianz document"). Retrieval is the one workflow that looks the same for
everyone, which is why it ships as part of the plugin.

Inbox triage/ingest (assigning correspondent, type, tags, title, date to new documents) deliberately
isn't included — everyone's filing conventions, naming schemes, and safety rules around auto-editing
their archive differ enough that a one-size-fits-all ingest skill would just be wrong for most
people. Write your own against `paperless_search_documents`/`paperless_update_document` (and the
rest of the tools above) in your own workspace instead, tuned to how you actually file things.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, regenerating API types, commit conventions,
and how releases work.
