#!/usr/bin/env bash
# Invoked as @semantic-release/exec's publishCmd from each app's own
# .releaserc.json (cwd is that app's directory, only reached when
# semantic-release has actually decided to publish a release) -- see
# apps/*/CONTRIBUTING.md's "Release process" section.
set -euo pipefail

npx --yes clawhub login --token "$CLAWHUB_API_KEY" --no-browser

openclaw_version=$(node -e "console.log(JSON.parse(require('fs').readFileSync('node_modules/openclaw/package.json','utf8')).version)")
npm pkg set openclaw.build.openclawVersion="$openclaw_version"

npx --yes clawhub package publish . --family code-plugin --json
