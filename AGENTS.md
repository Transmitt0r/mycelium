# AGENTS.md

@README.md has what this monorepo is and how the packages fit together.

## Layout

Three top-level categories, all pnpm workspace packages:

- `core/{embed,index,mcp}` — the published `@mycelium/*` feature packages. Root `tsconfig.json`'s project references cover only these three; everything else builds independently (plain `tsc`).
- `tools/{tooling-config,openapi-codegen}` — published, but internal enablers rather than features: shared biome/tsconfig presets, and shared OpenAPI-schema-to-types codegen logic (consumed by the apps' own `scripts/generate-types.ts`, which stay thin wrappers supplying just their own schema-fetching logic).
- `apps/{paperless-ngx,trilium,onepassword}` — the OpenClaw plugins this toolkit was extracted from, merged into this repo via `git subtree` (full history preserved) so they can consume `@mycelium/*` as `workspace:*` dependencies instead of a publish round-trip. Each still publishes to npm independently under its own name (`@transmitt0r/openclaw-plugin-*`) and keeps its own pre-existing `semantic-release` + Conventional Commits release flow — separate from this repo's Changesets flow.

## Working in this repo

- `pnpm install` / `build` / `typecheck` / `lint` / `test` at the root fan out across every workspace package (`pnpm -r --if-present run <script>`) — one set of commands for everything.
- **Node only, not Bun.** OpenClaw (the host every `apps/*` plugin runs inside) only supports Node — see its own `package.json` `engines`/`bin`. `@mycelium/index`'s sqlite-vec store needs `node:sqlite`, which doesn't exist under Bun. Don't reintroduce Bun tooling here.
- `@mycelium/*` packages version via [Changesets](https://github.com/changesets/changesets) (`pnpm run changeset` before a PR; never hand-edit their `version`). `apps/*` are in `.changeset/config.json`'s `ignore` list — they're versioned by their own `semantic-release`, not Changesets.
- `@mycelium/embed`'s local-CPU embedding fallback must stay **opt-in**, never a silent default — a prior in-process local-inference attempt in `apps/paperless-ngx` was OOM-killed in production on a memory-constrained host (see that package's `src/semantic/embedding-provider.ts` comments).
- A `@mycelium/*` package's first npm publish is a manual, one-time bootstrap (npm trusted publishing must be configured on npmjs.com before CI can publish it) — see `.github/workflows/release.yml`'s comment.

## Distribution targets

- **npmjs** — every package here, independently (Changesets for `core/*`+`tools/*`, `semantic-release` for `apps/*`).
- **ClawHub** — `apps/*` only. `core/*`/`tools/*` can't qualify: `@mycelium/mcp` exists specifically so tools work *without* OpenClaw.
- **Docker** — standalone MCP servers built on `@mycelium/mcp` with real tools wired in. Not built yet for any app — the next integration step is one of them adopting `@mycelium/mcp`/`@mycelium/index` in place of its own `src/semantic/` module.
