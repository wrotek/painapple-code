#!/usr/bin/env bash
# Thin wrapper around the Tauri CLI for the app-building commands
# (dev / build / ios init / ios dev / ios build). It:
#
#   1. Defaults CARGO_TARGET_DIR to a cache outside the repo (same value the
#      npm scripts used inline before).
#   2. Injects the app version from the nearest git v-tag via `--config`, so
#      the bundle version tracks the git tag that drives the Python package
#      instead of the static 0.0.1 in tauri.conf.json.
#
# The version is applied ONLY at build time through --config's overlay merge,
# so no tracked file is mutated — builds never dirty the working tree (unlike
# an in-place sed/jq of tauri.conf.json, which has bitten the stable worktree
# before). The 0.0.0 literals in tauri.conf.json / Cargo.toml stay as the
# tag-less fallback.
#
# tao-setup.sh (and ios-postinit.sh for iOS) still run as explicit prefixes in
# package.json — this wrapper deliberately only owns CARGO_TARGET_DIR + version
# so it doesn't disturb that ordering.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(bash "$SCRIPT_DIR/app-version.sh")"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/Library/Caches/painapple-tauri-target}"

exec tauri "$@" --config "{\"version\":\"$VERSION\"}"
