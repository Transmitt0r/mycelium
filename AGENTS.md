# AGENTS.md

@README.md has what this monorepo is and how the packages fit together.

## Layout

Three top-level categories, all pnpm workspace packages:

- `core/{embed,index,mcp}` — the published `@transmitt0r/mycelium-*` feature packages. Root `tsconfig.json`'s project references cover only these three; everything else builds independently (plain `tsc`).
- `tools/{tooling-config,openapi-codegen}` — published, but internal enablers rather than features: shared biome/tsconfig presets, and shared OpenAPI-schema-to-types codegen logic (consumed by the apps' own `scripts/generate-types.ts`, which stay thin wrappers supplying just their own schema-fetching logic).
- `apps/{paperless-ngx,trilium,onepassword}` — the OpenClaw plugins this toolkit was extracted from, merged into this repo via `git subtree` (full history preserved) so they can consume `@transmitt0r/mycelium-*` as `workspace:*` dependencies instead of a publish round-trip. Each still publishes to npm independently under its own name (`@transmitt0r/openclaw-plugin-*`) and keeps its own pre-existing `semantic-release` + Conventional Commits release flow — separate from this repo's Changesets flow.

## Working in this repo

- `pnpm install` / `build` / `typecheck` / `lint` / `test` at the root fan out across every workspace package (`pnpm -r --if-present run <script>`) — one set of commands for everything.
- **Node only, not Bun.** OpenClaw (the host every `apps/*` plugin runs inside) only supports Node — see its own `package.json` `engines`/`bin`. `@transmitt0r/mycelium-index`'s sqlite-vec store needs `node:sqlite`, which doesn't exist under Bun. Don't reintroduce Bun tooling here.
- `@transmitt0r/mycelium-*` packages version via [Changesets](https://github.com/changesets/changesets) (`pnpm run changeset` before a PR; never hand-edit their `version`). `apps/*` are in `.changeset/config.json`'s `ignore` list — they're versioned by their own `semantic-release`, not Changesets.
- `@transmitt0r/mycelium-embed`'s local-CPU embedding fallback must stay **opt-in**, never a silent default — a prior in-process local-inference attempt (node-llama-cpp, in what's now `apps/paperless-ngx`) was OOM-killed in production on a memory-constrained host (~376MB free RAM, no swap). A remote OpenAI-compatible endpoint has no local memory footprint beyond the request/response payload; local inference should stay something a host opts into deliberately, not something enabled by default.
- A `@transmitt0r/mycelium-*` package's first npm publish is a manual, one-time bootstrap (npm trusted publishing must be configured on npmjs.com before CI can publish it) — see `.github/workflows/release.yml`'s comment.

## Distribution targets

- **npmjs** — every package here, independently (Changesets for `core/*`+`tools/*`, `semantic-release` for `apps/*`).
- **ClawHub** — `apps/*` only. `core/*`/`tools/*` can't qualify: `@transmitt0r/mycelium-mcp` exists specifically so tools work *without* OpenClaw.
- **Docker** — standalone MCP servers built on `@transmitt0r/mycelium-mcp` with real tools wired in. Both `apps/paperless-ngx` and `apps/trilium` have a `Dockerfile` (build from the *monorepo root*, not the app directory — see the Dockerfile's own header comment for the exact command; it needs `@transmitt0r/mycelium-*` workspace siblings). Not published to any registry yet — build locally. `pnpm deploy --legacy` is memory-hungry — needs a few GB free (a colima/Docker Desktop VM's low default memory ceiling, e.g. colima's default 2GiB profile, isn't enough; bump it, e.g. `colima stop && colima start --memory 6`) — and explicitly prunes the `openclaw` peer dependency post-deploy (verified unreachable from `dist/mcp-server.js`, see each app's own AGENTS.md) since pnpm installs it anyway despite `peerDependenciesMeta.optional`. Both apps also adopted `@transmitt0r/mycelium-embed`/`@transmitt0r/mycelium-index` (each plugin's `src/semantic/` module wires those together instead of duplicating them) and split `semantic/handle.ts` (host-agnostic core) from `semantic/handle-openclaw.ts` (the OpenClaw adapter) so the standalone server's module graph never imports `openclaw` at the source level — same pattern in both apps, follow it for any new app.
