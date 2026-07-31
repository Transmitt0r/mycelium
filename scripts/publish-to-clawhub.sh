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
# from being created.
#
# Root cause of the "npm pack did not return a tarball filename" failure
# hit live on 2026-07-31: npm 12.0.0 (2026-07-08) changed `npm pack
# --json`'s output from a top-level array to an object keyed by package
# name; ClawHub CLI v0.23.1's own npm-pack invocation reads
# `npmOutput[0]?.filename`, which silently breaks against the new shape.
# Fixed at the source by pinning release-apps.yml's npm install to the
# 11.x line instead of @latest -- kept best-effort here anyway as
# defense-in-depth against whatever ClawHub or npm break next.
set -uo pipefail

npx --yes clawhub login --token "$CLAWHUB_API_KEY" --no-browser

openclaw_version=$(node -e "console.log(JSON.parse(require('fs').readFileSync('node_modules/openclaw/package.json','utf8')).version)")
npm pkg set openclaw.build.openclawVersion="$openclaw_version"

if ! npx --yes clawhub package publish . --family code-plugin --json; then
  echo "::warning::ClawHub publish failed -- npm publish already succeeded and the GitHub release will still be created. See the job log above for ClawHub's own error output." >&2
fi
