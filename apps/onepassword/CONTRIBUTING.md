# Contributing

## Dev setup

```bash
pnpm install
pnpm run build
pnpm run lint
pnpm run test
```

Node version is pinned in `.nvmrc`.

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
preserved) alongside `paperless-ngx`/`trilium` and the `@transmitt0r/mycelium-*` packages, so its
release workflow lives at the *repo root*, not here: merging to `main` runs
`../../.github/workflows/release-apps.yml`, a matrix job that runs `semantic-release` separately
per app. Since all three apps (and `core/*`/`tools/*`) now share one git history, plain
`semantic-release` would misattribute every commit in the repo to every app — the `extends:
semantic-release-monorepo` in `.releaserc.json` scopes commit analysis and the release tag
(`@transmitt0r/openclaw-plugin-onepassword-v<version>`, not the default `v<version>`) to just this
package's own directory. It computes the next version from commits since that tag, publishes to
npm (via trusted OIDC publishing — no token secret), and creates a GitHub release with generated
notes.

Publishing to ClawHub is still a separate manual step:
`clawhub package publish transmitt0r/openclaw-plugin-onepassword`.

### Bootstrapping a brand-new package

npm trusted publishing can only be configured for a package that already exists on the registry, so
a package's very first release needs one manual `npm publish` from a maintainer's machine, then a
trusted publisher (repo `Transmitt0r/mycelium`, workflow `release-apps.yml`) added under the
package's Settings → Trusted publishing on npmjs.com. Every release after that is fully automatic.

Note: the trusted publisher config is keyed to the exact workflow file path
(`.github/workflows/release-apps.yml`) — renaming that file breaks OIDC publishing (it silently
falls back to demanding an `NPM_TOKEN`) until the trusted publisher config is updated to match.
