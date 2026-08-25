#!/usr/bin/env bash
# Vendor a patched copy of swift-rs 1.0.8 into ../swift-rs, the way
# tao-setup.sh vendors tao. Cargo's [patch.crates-io] in src-tauri/Cargo.toml
# points at the resulting directory, so this must succeed before any
# `cargo build` in this workspace.
#
# Why: Xcode 27 broke swift-rs's iOS cross-compilation three ways. 1.0.8
# (published 2026-08-20) fixed the first — SwiftPM's new build engine appends
# its own host -sdk/-target AFTER the -Xswiftc overrides, so the Tauri Swift
# package was compiled against the macOS SDK ("unable to resolve module
# dependency: 'UIKit'"). It passes --triple instead. Two remain, both patched
# in swift-rs-fix.patch:
#
#   1. Archive discovery. 1.0.8 probes [out/]Products/<Config>-<platform> for
#      the built archive and silently falls back to the legacy
#      <build-path>/<configuration> dir when the probe misses — which it does
#      on Xcode 27.0 beta 27A5194q. cargo is then told to search a directory
#      that holds no archive. Patched to locate lib<Name>.a by recursive
#      search: the file itself is the only reliable statement about where
#      SwiftPM put it.
#
#   2. SwiftRs runtime symbols. Xcode 27's SwiftPM internalizes @_cdecl exports
#      in static products. 1.0.8 promotes them back with llvm-objcopy but only
#      for each package's OWN object member, skipping dependency members to
#      avoid defining the same globals twice. The three functions the swift-rs
#      *Rust* crate itself calls — retain_object / release_object /
#      string_from_bytes — live in the SwiftRs Swift library, embedded as
#      exactly such a dependency member, so they stay local and EVERY iOS build
#      fails with "Undefined symbols for architecture arm64". Patched to
#      promote them in one archive only (the package named by
#      SWIFT_RS_RUNTIME_PACKAGE, default Tauri), so ld resolves them there and
#      never pulls the duplicate member out of a sibling archive.
#
# Requires the llvm-tools rustup component (Apple ships no llvm-objcopy):
#   rustup component add llvm-tools
#
# Idempotent. Drop this script + swift-rs-fix.patch + the [patch.crates-io]
# entry once an upstream swift-rs release carries both fixes.
set -euo pipefail

VERSION="1.0.8"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="$SCRIPT_DIR/../../swift-rs"
PATCH="$SCRIPT_DIR/swift-rs-fix.patch"

# Sentinel: a function name that only exists in our patch. Bump it if the
# patch grows, so stale vendored copies get rebuilt instead of skipped.
SENTINEL="globalize_runtime_symbols"

if [ -f "$DEST/src-rs/build.rs" ] && grep -q "$SENTINEL" "$DEST/src-rs/build.rs"; then
    exit 0  # already vendored + patched — silent fast path
fi

echo "swift-rs-setup: vendoring patched swift-rs $VERSION into $DEST"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL -o "$tmp/swift-rs.crate" \
    "https://static.crates.io/crates/swift-rs/swift-rs-$VERSION.crate"
tar -xzf "$tmp/swift-rs.crate" -C "$tmp"

rm -rf "$DEST"
mv "$tmp/swift-rs-$VERSION" "$DEST"
# A .crate ships a pinned lockfile and a cargo-generated manifest; neither is
# wanted for a path dependency.
rm -f "$DEST/Cargo.lock"

(cd "$DEST" && patch -p1 --silent < "$PATCH")
echo "swift-rs-setup: applied $(basename "$PATCH")"
