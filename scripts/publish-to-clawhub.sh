#!/usr/bin/env bash
# Invoked as @semantic-release/exec's publishCmd from each app's own
# .releaserc.json (cwd is that app's directory, only reached when
# semantic-release has actually decided to publish a release) -- see
# apps/*/CONTRIBUTING.md's "Release process" section.
#
# By the time this runs, @semantic-release/npm's own publish step has
# already run (it's listed first in the plugins array), so the real npm
# publish is done regardless of what happens below. Treat ClawHub as
# best-effort and never fail the overall semantic-release run because of
# it -- a ClawHub-side failure here must not block the GitHub release
# (@semantic-release/github's publish step, which runs after this one)
# from being created. Confirmed live on 2026-07-31: ClawHub's own
# internal `npm pack` invocation failed ("npm pack did not return a
# tarball filename") on a real CI run even though a local repro of the
# previously-suspected cause (a leftover, unresolved-token .npmrc from
# actions/setup-node's registry-url) came back clean -- so the local
# repro didn't match the real failure mode, and this remains an
# unresolved, unpredictable upstream issue.
set -uo pipefail

npx --yes clawhub login --token "$CLAWHUB_API_KEY" --no-browser

openclaw_version=$(node -e "console.log(JSON.parse(require('fs').readFileSync('node_modules/openclaw/package.json','utf8')).version)")
npm pkg set openclaw.build.openclawVersion="$openclaw_version"

if ! npx --yes clawhub package publish . --family code-plugin --json; then
  echo "::warning::ClawHub publish failed -- npm publish already succeeded and the GitHub release will still be created. See the job log above for ClawHub's own error output." >&2
fi
