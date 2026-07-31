#!/usr/bin/env bash
# Invoked as @semantic-release/exec's prepareCmd from each app's own
# .releaserc.json (cwd is that app's directory), positioned right after
# @semantic-release/npm's own prepare step (which bumps package.json's
# version) and before any publish step -- so both the npm-published
# tarball and the ClawHub-published one carry a matching
# openclaw.plugin.json version instead of whatever it was hand-set to
# at plugin creation and never touched again. ClawHub's own package
# validator flags this drift as "package-manifest-version-drift".
set -euo pipefail

version=$(node -e "console.log(require('./package.json').version)")

# A targeted line-anchored replace (not a full JSON.parse/stringify
# round-trip) so the rest of the file -- array formatting, key order --
# stays byte-identical; only the top-level "version" field (2-space
# indented) changes.
node -e "
const fs = require('node:fs');
const raw = fs.readFileSync('openclaw.plugin.json', 'utf8');
const updated = raw.replace(/^(  \"version\": \")[^\"]*(\")/m, \`\$1\${process.argv[1]}\$2\`);
if (updated === raw) {
  throw new Error('openclaw.plugin.json: no top-level \"version\" field matched');
}
fs.writeFileSync('openclaw.plugin.json', updated);
" "$version"
