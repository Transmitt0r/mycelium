#!/usr/bin/env bash
# Invoked as @semantic-release/exec's successCmd from each app's own
# .releaserc.json (cwd is that app's directory). `successCmd` only fires
# after a release has been fully and successfully published (npm, ClawHub,
# GitHub release/tag), so the version recorded here is the authoritative
# nextRelease.version for THIS run -- unlike inferring it from the git tag,
# which would also match on a no-op re-run of the same commit.
#
# The version is passed as $1 (semantic-release/exec interpolates
# ${nextRelease.version}); the app name is taken from the cwd's basename.
# We write a small JSON file at the monorepo root (../.. from apps/<app>) so
# release-apps.yml's publish-images job can consume it via an artifact.
set -euo pipefail

version="${1:?nextRelease.version required}"
app="$(basename "$(pwd)")"

# Line-anchored parse-free write (the file is tiny and consumed by the
# workflow's own jq, which is strict about JSON).
printf '{"app":"%s","version":"%s"}\n' "$app" "$version" > "../../${app}.release.json"
