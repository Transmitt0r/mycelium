# AGENTS.md

@README.md has what this plugin does and how end users configure it.
@CONTRIBUTING.md has full dev setup, the commit convention, and the release process — read it before committing or touching CI.

## Layout

- `src/index.ts` — plugin entrypoint, registers the secret provider with OpenClaw
- `src/resolver.ts` — batches SecretRef ids into `op read` calls against the 1Password CLI
- `src/resolver.test.ts` — colocated tests

## Working in this repo

- Run `pnpm run build`, `pnpm run lint`, `pnpm run test` before committing.
- Commit messages **must** follow Conventional Commits — semantic-release derives the npm version
  and GitHub release from them on every push to `main`. A non-conventional message just won't ship.
- Never hand-edit `version` in `package.json` — semantic-release owns it.
- A brand-new package's first npm publish is a manual, one-time bootstrap step (see
  CONTRIBUTING.md) — don't try to "fix" a failing first release by adding more workflow logic.
