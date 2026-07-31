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
to npm (via trusted OIDC publishing — no token secret), publishes to ClawHub, and creates a GitHub
release with generated notes.

Two `@semantic-release/exec` hooks run as part of this (see this app's `.releaserc.json`):
`prepareCmd` runs `scripts/sync-openclaw-plugin-version.sh` right after `@semantic-release/npm`'s
own `prepare` step has bumped `package.json`'s version, keeping `openclaw.plugin.json`'s `version`
field in sync so the published npm/ClawHub tarballs never carry a stale one (ClawHub's package
validator flags a mismatch as `package-manifest-version-drift`). `publishCmd` runs
`scripts/publish-to-clawhub.sh` — needs a `CLAWHUB_API_KEY` repo secret (a maintainer's ClawHub
token) — and is best-effort: a ClawHub-side failure logs a `::warning::` but never blocks the npm
publish or GitHub release. It's failed twice so far, for two different reasons — a leftover,
unresolved-token `.npmrc` from `actions/setup-node`'s `registry-url` (no longer relevant now that
`release-apps.yml` never sets `registry-url`), and npm 12.0.0 changing `npm pack --json`'s output
shape in a way ClawHub CLI v0.23.1's own npm-pack invocation doesn't handle (fixed by pinning
`release-apps.yml`'s npm install to the 11.x line — see that workflow's comments; confirmed live via
`@transmitt0r/openclaw-plugin-onepassword@0.1.5`, the first release to publish to ClawHub
successfully). If it fails again, `clawhub package publish . --family code-plugin` run manually from
this directory is the fallback.

### Bootstrapping a brand-new package

npm trusted publishing can only be configured for a package that already exists on the registry, so
a package's very first release needs one manual `npm publish` from a maintainer's machine, then a
trusted publisher (repo `Transmitt0r/mycelium`, workflow `release-apps.yml`) added under the
package's Settings → Trusted publishing on npmjs.com. Every release after that is fully automatic.
