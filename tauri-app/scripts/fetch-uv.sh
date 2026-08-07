#!/usr/bin/env bash
# Fetch the pinned `uv` release binaries that Tauri bundles as sidecars
# (bundle.externalBin in tauri.macos.conf.json). uv is what "local mode"
# uses to provision the Python bridge on the user's machine — managed
# CPython download + `uv tool install painapple-code` — so the .app works
# on Macs with no usable system Python (see
# docs-ai/plans/2026-07-10-desktop-app-macos-local-mode.md).
#
# Idempotent and version-pinned: binaries land in src-tauri/binaries/
# (gitignored) named uv-<target-triple>, which is the exact layout the
# Tauri bundler expects for `externalBin: ["binaries/uv"]`. A version
# marker file makes re-runs a no-op until UV_VERSION is bumped.
#
# Usage:
#   scripts/fetch-uv.sh              # host triple only (dev builds)
#   scripts/fetch-uv.sh --mac        # both darwin triples (universal build)
#   scripts/fetch-uv.sh <triple>...  # explicit triples
set -euo pipefail

UV_VERSION="0.11.28"
BASE_URL="https://github.com/astral-sh/uv/releases/download/${UV_VERSION}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="$SCRIPT_DIR/../src-tauri/binaries"
MARKER="$DEST/.uv-version"

host_triple() {
    case "$(uname -s)-$(uname -m)" in
        Darwin-arm64)  echo "aarch64-apple-darwin" ;;
        Darwin-x86_64) echo "x86_64-apple-darwin" ;;
        Linux-x86_64)  echo "x86_64-unknown-linux-gnu" ;;
        Linux-aarch64) echo "aarch64-unknown-linux-gnu" ;;
        *) echo "fetch-uv: unsupported host $(uname -s)-$(uname -m)" >&2; exit 1 ;;
    esac
}

TRIPLES=()
if [ $# -eq 0 ]; then
    TRIPLES=("$(host_triple)")
elif [ "$1" = "--mac" ]; then
    TRIPLES=("aarch64-apple-darwin" "x86_64-apple-darwin")
else
    TRIPLES=("$@")
fi

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

mkdir -p "$DEST"

for triple in "${TRIPLES[@]}"; do
    out="$DEST/uv-$triple"
    if [ -x "$out" ] && [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$UV_VERSION" ]; then
        continue  # already present at the pinned version — silent fast path
    fi

    echo "fetch-uv: downloading uv $UV_VERSION for $triple"
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT

    tarball="uv-$triple.tar.gz"
    curl -fsSL -o "$tmp/$tarball" "$BASE_URL/$tarball"
    curl -fsSL -o "$tmp/$tarball.sha256" "$BASE_URL/$tarball.sha256"

    expected="$(awk '{print $1}' "$tmp/$tarball.sha256")"
    actual="$(sha256_of "$tmp/$tarball")"
    if [ "$expected" != "$actual" ]; then
        echo "fetch-uv: sha256 mismatch for $tarball (expected $expected, got $actual)" >&2
        exit 1
    fi

    tar -xzf "$tmp/$tarball" -C "$tmp"
    # Archive layout: uv-<triple>/uv (plus uvx, which we don't ship).
    mv "$tmp/uv-$triple/uv" "$out"
    chmod 755 "$out"
    rm -rf "$tmp"
    trap - EXIT
    echo "fetch-uv: → $out"
done

echo "$UV_VERSION" > "$MARKER"
