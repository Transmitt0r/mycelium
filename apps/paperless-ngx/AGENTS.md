# AGENTS.md

@README.md has what this plugin does and how end users configure it.
@CONTRIBUTING.md has full dev setup, the commit convention, and the release process — read it before committing or touching CI.

## Layout

- `src/index.ts` — plugin entrypoint, registers tools with OpenClaw
- `src/tools/` — one file per tool group (documents, taxonomy, relations, pagination)
- `src/client.ts` — typed paperless-ngx API client
- `src/generated/paperless-schema.d.ts` — generated, do not hand-edit (see CONTRIBUTING.md)
- `src/semantic/` — wires `@mycelium/embed` (pluggable embedding provider) and `@mycelium/index`
  (the actual store/sync/search engine) together for this plugin; `source-adapter.ts` is the only
  paperless-specific piece (implements `@mycelium/index`'s `SourceAdapter`). Don't reintroduce a
  local sqlite-vec/embedding-provider implementation here — that duplication is exactly what got
  extracted into `@mycelium/*`.
- `src/semantic/handle.ts` (`createSemanticSearchCore`) has **zero `openclaw` imports, not even type
  imports** — verified by `pnpm run build` then `grep -rln 'from "openclaw' dist/` (should only ever
  print `dist/index.js` and `dist/semantic/handle-openclaw.js`). `src/semantic/handle-openclaw.ts` is
  the thin adapter translating `OpenClawPluginApi` into `handle.ts`'s host-agnostic
  `SemanticSearchHostDeps`; `index.ts` imports the adapter, `src/mcp-server.ts` imports `handle.ts`
  directly. If you add an `api.*` read to make semantic search do something new, it goes in
  `handle-openclaw.ts`, never in `handle.ts` — that's what keeps `openclaw` out of the standalone
  server's dependency tree (see `peerDependenciesMeta.openclaw.optional` in `package.json`).
- `src/mcp-server.ts` — standalone MCP server entrypoint on `@mycelium/mcp` (stdio/HTTP), configured
  via env vars instead of `openclaw.json` (see README's "Standalone MCP server" section). Tool
  factories (`src/tools/*.ts`) are reused unmodified from the OpenClaw plugin path — they were never
  OpenClaw-coupled to begin with. `src/mcp-server-config.ts` holds the (tested) env-var parsing.
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
