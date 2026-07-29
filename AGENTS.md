# AGENTS.md

@README.md has what this monorepo is and how the packages fit together.

## Layout

- `packages/embed` — pluggable embedding/chat client (any OpenAI-compatible endpoint + opt-in local CPU fallback)
- `packages/index` — local-first semantic index (sqlite-vec store, incremental sync, hybrid RRF search)
- `packages/mcp` — bridges agent-tool factories onto a standalone MCP server (stdio + Streamable HTTP)
- `packages/tooling-config` — shared biome/tsconfig presets for this repo and the standalone plugin repos (paperless-ngx, trilium, 1password)
- `tsconfig.json` — root project-references graph; `tsconfig.base.json` — shared compiler options
- Bun workspaces (`package.json`'s `workspaces` field), not pnpm. The single-package plugin repos stay on pnpm/vitest; don't try to unify those.

## Working in this repo

- Run `bun install`, `bun run build`, `bun run typecheck`, `bun run lint`, `bun test` before committing.
- `packages/index` also has `bun run test:integration` (run from within that package), which runs under plain **Node**, not Bun — its sqlite-vec backing needs `node:sqlite`'s extension-loading support, which Bun's bundled sqlite3 build doesn't have. It exercises the built `dist/` output, so `bun run build` must happen first. CI runs both.
- Versioning/publishing goes through [Changesets](https://github.com/changesets/changesets), not semantic-release — this is a multi-package repo with independent per-package versions, and Changesets is what most TS monorepos in this space use. Run `bun run changeset` to record a change before opening a PR; the release workflow opens a "Version Packages" PR and publishes on merge.
- Never hand-edit a package's `version` — Changesets owns it.
- `@mycelium/embed`'s local-CPU embedding fallback must stay **opt-in**, never a silent default. A prior in-process local-inference attempt in a sibling plugin (paperless-ngx) got OOM-killed in production on a memory-constrained host — see that repo's `src/semantic/embedding-provider.ts` history before changing this default.
- A brand-new package's first npm publish needs npm trusted publishing configured manually on npmjs.com first (see `.github/workflows/release.yml`'s comment) — that's a one-time bootstrap step per package, not something to route around in CI.
