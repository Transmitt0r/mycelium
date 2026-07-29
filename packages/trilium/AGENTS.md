# AGENTS.md

@README.md has what this plugin does and how end users configure it.
@CONTRIBUTING.md has full dev setup, the commit convention, and the release process — read it before committing or touching CI.

## Layout

- `src/index.ts` — plugin entrypoint, registers tools with OpenClaw
- `src/tools/` — one file per tool group (notes, tree, attributes, attachments, revisions, calendar, html)
- `src/tools/html.ts` — shared HTML<->plain-text conversion and bounded line-range reading, used by every content-reading/writing tool
- `src/client.ts` — typed Trilium ETAPI client
- `src/generated/trilium-schema.d.ts` — generated, do not hand-edit (see CONTRIBUTING.md)
- `src/semantic/` — plugin-owned semantic search backend (SQLite+sqlite-vec index, Gemini embeddings, Trilium query-language stripping)
- `skills/` — OpenClaw agent skills bundled with the plugin
- `*.test.ts` — colocated with the source they test

## Working in this repo

- Run `pnpm run build`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run test` before committing.
  `build`'s `tsc` excludes test files from the compile; `typecheck` is the one that type-checks them.
- Commit messages **must** follow Conventional Commits — semantic-release derives the npm version
  and GitHub release from them on every push to `main`. A non-conventional message just won't ship.
- Never hand-edit `version` in `package.json` — semantic-release owns it.
- A brand-new package's first npm publish is a manual, one-time bootstrap step (see
  CONTRIBUTING.md) — don't try to "fix" a failing first release by adding more workflow logic.

## Things not to re-derive

- **Repo/image naming**: the upstream project was `TriliumNext/Notes` until mid-2025 (now archived
  on GitHub) and `triliumnext/notes` on Docker Hub. Active development moved to
  `TriliumNext/Trilium` (GitHub) / `triliumnext/trilium` (Docker Hub) — don't resurrect the old
  names from search results or older docs that predate the rename.
- **ETAPI has no pagination**: `/notes` search takes only `limit`, no page/offset. `src/semantic/sync.ts`'s
  two-tier backfill/incremental design exists specifically to work around this — read its doc
  comment before changing sync behavior.
- **`blobId` is a free content hash**: every note in a search response already carries `blobId`, so
  an unchanged note's content never needs to be fetched during sync. Don't reintroduce a
  fetch-then-hash pattern (that's paperless-ngx's design, not needed here).
- **No batch note-fetch endpoint**: unlike paperless-ngx's `id__in`, ETAPI has nothing like
  "get many notes by id" — resolving a list of ids to names/titles is always N individual GETs.
  Keep those bounded (see `MAX_RESOLVE_NAMES` in `src/tools/notes.ts`).
