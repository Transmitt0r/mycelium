# openclaw-plugin-trilium

[![CI](https://github.com/Transmitt0r/openclaw-plugin-trilium/actions/workflows/ci.yml/badge.svg)](https://github.com/Transmitt0r/openclaw-plugin-trilium/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An [OpenClaw](https://docs.openclaw.ai) plugin for [TriliumNext](https://triliumnotes.org/) Notes,
talking to its [ETAPI](https://docs.triliumnotes.org/user-guide/advanced-usage/etapi) REST API.

It registers a set of agent tools over notes, the tree (branches/cloning), labels/relations
(attributes), attachments, revisions, and journal/calendar notes -- covering the same
search/read/write/organize workflows you'd otherwise do by hand in Trilium's own UI. Tools are
split by resource (notes, tree, attributes, attachments, revisions, calendar), each bounded by
default rather than pulling a note's full content into context unless a caller specifically reads
it that way.

## Install

```bash
openclaw plugins install clawhub:transmitt0r/openclaw-plugin-trilium
```

Or for local development, point OpenClaw at a built copy of this repo.

## Configure

The plugin needs the base URL of your Trilium instance and an ETAPI token (Options → ETAPI →
Create new ETAPI token in the Trilium UI):

```json
{
  "plugins": {
    "entries": {
      "trilium": {
        "config": {
          "baseUrl": "https://trilium.example.com",
          "apiToken": "your-etapi-token"
        }
      }
    }
  }
}
```

`apiToken` also accepts a [SecretRef](https://docs.openclaw.ai/cli/config) instead of a plain string:

```bash
openclaw config set plugins.entries.trilium.config.apiToken \
  --ref-provider default --ref-source env --ref-id TRILIUM_TOKEN
```

(or `--ref-source exec`/`file` for a password manager CLI, vault, etc.)

## Tools

| Tool | Description |
| --- | --- |
| `trilium_search_notes` | Search/filter notes using Trilium's own query language (free text, `#label`, `~relation`, `note.property` filters, boolean logic). Never returns full content. `search` is hybrid lexical/attribute + semantic under the hood -- no separate param or tool for it. |
| `trilium_get_note` | Fetch a note's metadata by id -- title, type, attributes, tree placement. By default resolves parent/child ids to `{noteId, branchId, title, type}` so tree navigation rarely needs a follow-up call (`resolve_names`, capped at 50 ids). Can also include the note's attachments/revisions in the same call. |
| `trilium_read_note_content` | Read a note's content, bounded to a line range (capped at 500 lines/call, defaults to the first 200). `text`-type note content (CKEditor HTML) is converted to plain text by default -- pass `raw_html: true` for the original markup. |
| `trilium_create_note` | Create a note and place it in the tree. Plain text content is auto-wrapped into HTML paragraphs for `text` notes unless it already looks like HTML. |
| `trilium_update_note` | Update a note's title/type/mime and/or replace its full content in one call (content has no partial/append write in ETAPI). |
| `trilium_delete_note` | Delete a note (and its subtree). Recoverable via `trilium_undelete_note`. |
| `trilium_undelete_note` | Restore a previously deleted note. |
| `trilium_get_recent_changes` | List recent note creations/modifications/deletions, newest first -- "what did I change today" style queries. |
| `trilium_place_note_in_tree` | Clone a note into (or move/reorder/reprefix it within) a tree location. |
| `trilium_remove_note_from_location` | Remove one tree placement of a note without necessarily deleting the note itself (if it has other placements). |
| `trilium_create_attribute` | Add a label (key-value tag) or relation (typed link) to a note. |
| `trilium_update_attribute` | Update an existing label's value or any attribute's position by id. |
| `trilium_delete_attribute` | Remove a label or relation by id. |
| `trilium_create_attachment` | Create an attachment owned by a note (or revision). |
| `trilium_get_attachment` | Fetch an attachment's metadata, optionally including its (bounded) content. |
| `trilium_update_attachment` | Update an attachment's metadata and/or replace its content. |
| `trilium_delete_attachment` | Permanently delete an attachment (no undelete, unlike notes). |
| `trilium_create_revision` | Snapshot a note's current title/content -- useful before a large rewrite. |
| `trilium_read_revision_content` | Read a past revision's content (bounded, same as `trilium_read_note_content`). |
| `trilium_get_calendar_note` | Get or create the day/week/month/year journal note or the inbox note for a given date. |

## Semantic search

`trilium_search_notes` understands meaning, not just keywords -- searching "car insurance" also
finds a note whose text only ever says "Kfz-Haftpflichtversicherung". This happens automatically
inside the existing `search` param; there's no separate tool or mode to choose.

This needs an embedding provider configured, and by default sends data off your machine:
`text`/`code` note content and your search terms are sent to whatever endpoint you configure to be
embedded. **Without `semanticSearch.embedding` fully configured, this stays off automatically** --
`trilium_search_notes` silently falls back to Trilium's own lexical/attribute-only search, the same
way it fails open if the embedding endpoint is unreachable, rate limits you, or errors for any
other reason.

Powered by [`@mycelium/embed`](https://www.npmjs.com/package/@mycelium/embed): any OpenAI-compatible
`/v1/embeddings` endpoint works -- OpenAI, [OpenRouter](https://openrouter.ai), Ollama, vLLM, LM
Studio, and so on. `baseUrl`, `apiKey`, `model`, and `dimensions` are all required (models vary by
endpoint, so there's no universal default to fall back to):

```json
{
  "plugins": {
    "entries": {
      "trilium": {
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
(`baseUrl`/`apiKey` aren't needed there -- `model`/`dimensions` default to a small bundled ONNX
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

Only `text` and `code` notes are indexed -- `file`/`image`/`canvas`/etc. notes don't have
free-form textual content to embed meaningfully. Trilium's ETAPI has no pagination on its search
endpoint (only a flat `limit`), so each sync pass pages through up to 200 changed notes by
re-querying with an advancing `utcDateModified` cursor; a pass runs on plugin startup and every 15
minutes after. A vault with more than a couple hundred existing `text`/`code` notes backfills
gradually over several passes (partial semantic coverage in the meantime -- lexical/attribute
search still works normally throughout) rather than all at once, the same bound
[`@mycelium/index`](https://www.npmjs.com/package/@mycelium/index) applies to every source it syncs.

## Skills

The plugin bundles one skill (`skills/trilium`) that OpenClaw picks up automatically once it's
installed: on-demand note search and retrieval, plus lightweight organization (labels, tree
placement). Everyone's own note-taking conventions differ enough that anything more opinionated
(auto-tagging rules, a fixed daily-journal template, etc.) is left for you to write in your own
workspace against these tools, tuned to how you actually use Trilium.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, regenerating API types, commit conventions,
and how releases work.
