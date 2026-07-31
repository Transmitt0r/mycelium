# Contributing

## Dev setup

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run test
```

`build`'s `tsc` excludes `*.test.ts` (test files shouldn't end up in the published `dist/`), so it
never type-checks tests. `typecheck` runs the same compiler over the whole program, tests included,
via `tsconfig.test.json` (extends the base config, `noEmit`, no exclusion). `vitest run` itself
doesn't type-check either -- it transpiles with esbuild, which strips types without checking them --
so `typecheck` is the only step that would catch a type error confined to a test file.

Node version is pinned in `.nvmrc`.

### Regenerating API types

`src/generated/trilium-schema.d.ts` is generated from TriliumNext/Trilium's bundled ETAPI OpenAPI
spec, pinned to a release tag (a running Trilium server doesn't serve this spec over HTTP itself --
see `scripts/generate-types.ts`'s own doc comment):

```bash
pnpm run generate:types -- v0.104.1
```

Re-run this after bumping the Trilium version this plugin targets. Note the repo name:
`TriliumNext/Trilium`, not `TriliumNext/Notes` (that repo is archived; see AGENTS.md).

Note: `openapi-typescript`'s codegen currently only supports TypeScript ^5.x, while this project
builds against the latest TypeScript major. `generate:types` runs the generator through `pnpm dlx`
in an isolated resolution so it gets a compatible TypeScript without downgrading the project's own
devDependency.

## Commit messages

This repo releases via [semantic-release](https://semantic-release.gitbook.io/semantic-release/):
every commit message on `main` must follow [Conventional Commits](https://www.conventionalcommits.org/),
because the release automation reads the commit history to decide what to publish. There is no
manual version bump anymore — don't edit `version` in `package.json`.

| Prefix | Effect |
| --- | --- |
| `fix: ...` | patch release |
| `feat: ...` | minor release |
| `feat!: ...` or a `BREAKING CHANGE:` footer | major release |
| `chore:`, `docs:`, `refactor:`, `test:`, `ci:` | no release |

## Release process

This package lives in the `mycelium` monorepo (merged in via `git subtree`, full history
preserved) alongside `paperless-ngx`/`onepassword` and the `@transmitt0r/mycelium-*` packages, so
its release workflow lives at the *repo root*, not here: merging to `main` runs
`../../.github/workflows/release-apps.yml`, a matrix job that runs `semantic-release` separately
per app. Since all three apps (and `core/*`/`tools/*`) now share one git history, plain
`semantic-release` would misattribute every commit in the repo to every app — the `extends:
semantic-release-monorepo` in `.releaserc.json` scopes commit analysis and the release tag
(`@transmitt0r/openclaw-plugin-trilium-v<version>`, not the default `v<version>`) to just this
package's own directory. It computes the next version from commits since that tag, publishes to
npm (via trusted OIDC publishing — no token secret), and creates a GitHub release with generated
notes.

Publishing to ClawHub is still a separate manual step:
`clawhub package publish transmitt0r/openclaw-plugin-trilium`.

### Bootstrapping a brand-new package

npm trusted publishing can only be configured for a package that already exists on the registry, so
a package's very first release needs one manual `npm publish` from a maintainer's machine, then a
trusted publisher (repo `Transmitt0r/mycelium`, workflow `release-apps.yml`) added under the
package's Settings → Trusted publishing on npmjs.com. Every release after that is fully automatic.
