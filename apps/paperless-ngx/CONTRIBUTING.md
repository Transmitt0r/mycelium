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

`src/generated/paperless-schema.d.ts` is generated from your paperless-ngx instance's live OpenAPI
schema via [openapi-typescript](https://openapi-ts.dev/):

```bash
export PAPERLESS_URL=https://paperless.example.com
export PAPERLESS_TOKEN=your-api-token
pnpm run generate:types
```

Re-run this after upgrading paperless-ngx if you rely on newer filters or fields.

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
preserved) alongside `trilium`/`onepassword` and the `@transmitt0r/mycelium-*` packages, so its
release workflow lives at the *repo root*, not here: merging to `main` runs
`../../.github/workflows/release-apps.yml`, a matrix job that runs `semantic-release` separately
per app. Since all three apps (and `core/*`/`tools/*`) now share one git history, plain
`semantic-release` would misattribute every commit in the repo to every app — the `extends:
semantic-release-monorepo` in `.releaserc.json` scopes commit analysis and the release tag
(`@transmitt0r/openclaw-plugin-paperless-ngx-v<version>`, not the default `v<version>`) to just
this package's own directory. It computes the next version from commits since that tag, publishes
to npm (via trusted OIDC publishing — no token secret), publishes to ClawHub (via
`scripts/publish-to-clawhub.sh` at the repo root, run as this app's `@semantic-release/exec`
`publishCmd` — only invoked once semantic-release has actually decided to publish a release), and
creates a GitHub release with generated notes.

ClawHub publishing needs a `CLAWHUB_API_KEY` repo secret (a maintainer's ClawHub token). An earlier
attempt at this hit an environment-specific bug in ClawHub's npm-pack invocation
("npm pack did not return a tarball filename"); that's since been fixed upstream (confirmed against
ClawHub CLI v0.23.1). If it resurfaces, `clawhub package publish . --family code-plugin` run
manually from this directory is the fallback.

### Bootstrapping a brand-new package

npm trusted publishing can only be configured for a package that already exists on the registry, so
a package's very first release needs one manual `npm publish` from a maintainer's machine, then a
trusted publisher (repo `Transmitt0r/mycelium`, workflow `release-apps.yml`) added under the
package's Settings → Trusted publishing on npmjs.com. Every release after that is fully automatic.
