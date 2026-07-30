# AGENTS.md

@README.md has what this monorepo is and how the packages fit together.

## Layout

- `packages/embed`, `packages/index`, `packages/mcp` — the published `@mycelium/*` packages.
- `packages/tooling-config` — shared biome/tsconfig presets, self-hosted by this repo's own root config (not just published for external use).
- `packages/paperless-ngx`, `packages/trilium`, `packages/onepassword` — the OpenClaw plugins this toolkit was extracted from, merged into this repo via `git subtree` (full history preserved) so they can consume `@mycelium/*` as `workspace:*` dependencies. Each still publishes to npm independently under its own name (`@transmitt0r/openclaw-plugin-*`).
- `tools/openapi-codegen` — shared, unpublished (`"private": true`) logic for regenerating a package's `src/generated/*.d.ts` from a fetched OpenAPI schema. Consumed by paperless-ngx's and trilium's own `scripts/generate-types.ts`.
- Root `tsconfig.json`'s project references cover only `@mycelium/embed`/`index`/`mcp` — the plugin packages and `tools/openapi-codegen` build independently (plain `tsc`, not `tsc -b`).

## Working in this repo

- `pnpm install` / `build` / `typecheck` / `lint` / `test` at the root fan out across every workspace package (`pnpm -r --if-present run <script>`) — one set of commands for everything.
- **Node only, not Bun.** OpenClaw (the host every plugin here runs inside) only supports Node — see its own `package.json` `engines`/`bin`. `@mycelium/index`'s sqlite-vec store needs `node:sqlite`, which doesn't exist under Bun. Don't reintroduce Bun tooling here.
- Two independent release flows coexist: `@mycelium/*` packages use [Changesets](https://github.com/changesets/changesets) (`pnpm run changeset` before a PR; never hand-edit their `version`). The three plugin packages keep their own pre-existing `semantic-release` + Conventional Commits flow, untouched by Changesets.
- `@mycelium/embed`'s local-CPU embedding fallback must stay **opt-in**, never a silent default — a prior in-process local-inference attempt in `paperless-ngx` was OOM-killed in production on a memory-constrained host (see `packages/paperless-ngx/src/semantic/embedding-provider.ts`'s comments).
- A `@mycelium/*` package's first npm publish is a manual, one-time bootstrap (npm trusted publishing must be configured on npmjs.com before CI can publish it) — see `.github/workflows/release.yml`'s comment.

## Distribution targets

- **npmjs** — every package here, independently (Changesets for `@mycelium/*`, `semantic-release` for the plugins).
- **ClawHub** — the three plugins only. `@mycelium/*` packages can't qualify: `@mycelium/mcp` exists specifically so tools work *without* OpenClaw.
- **Docker** — standalone MCP servers built on `@mycelium/mcp` with real tools wired in. Not built yet for any plugin — the next integration step is one of them adopting `@mycelium/mcp`/`@mycelium/index` in place of its own `src/semantic/` module.
