#!/usr/bin/env bash
# Print the Tauri bundle version derived from the nearest git v-tag.
#
# The git tag (created by ../../deploy.fish, e.g. `v1.0.1`) is the single
# source of truth for the whole project: the Python package reads it via
# setuptools-scm, and this script feeds the same tag to the Tauri bundle so
# the native app version tracks it instead of the static 0.0.1 literal in
# tauri.conf.json.
#
# Tauri requires STRICT SemVer (X.Y.Z, no dev/+local suffix), so we use the
# bare nearest tag — NOT setuptools-scm's `1.0.1.dev82+g…` form, which Tauri
# rejects. Untagged clones fall back to 0.0.0.
set -euo pipefail

tag="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || echo v0.0.0)"
echo "${tag#v}"
