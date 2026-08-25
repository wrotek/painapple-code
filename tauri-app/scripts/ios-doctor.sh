#!/usr/bin/env bash
# Diagnose an iOS build failure in the `swift build` step that tauri's
# build.rs runs via swift-rs (panic: "Failed to compile swift package Tauri").
#
# Cargo captures the build-script output, so the real Swift compiler errors
# are buried. This reproduces the exact `swift build` invocation swift-rs
# 1.0.7 makes — outside cargo, with full output — and writes everything to
# tauri-app/ios-doctor.log (gitignored, on the shared mount).
#
# Usage: bash scripts/ios-doctor.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$SCRIPT_DIR/../ios-doctor.log"
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

section() { echo; echo "══════ $* ══════"; }

section "toolchain"
echo "date:        $(date)"
echo "xcode-select: $(xcode-select -p 2>&1)"
xcodebuild -version 2>&1
swift --version 2>&1
echo "iphoneos SDK: $(xcrun --sdk iphoneos --show-sdk-version 2>&1) @ $(xcrun --sdk iphoneos --show-sdk-path 2>&1)"
/usr/libexec/PlistBuddy -c 'Print :MinimumSupportedDeploymentTarget' \
  "$(xcrun --sdk iphoneos --show-sdk-path)/SDKSettings.plist" 2>&1 | sed 's/^/SDK min deployment target: /'
rustc -vV 2>&1 | sed 's/^/rustc: /'
echo "ios target installed: $(rustup target list --installed 2>&1 | grep -c aarch64-apple-ios)"

section "tauri crate source"
TAURI_VER="$(awk '/^name = "tauri"$/{f=1;next} f&&/^version/{gsub(/"/,"",$3);print $3;exit}' "$SCRIPT_DIR/../src-tauri/Cargo.lock")"
echo "tauri version from Cargo.lock: $TAURI_VER"
SRC="$(ls -d "$HOME"/.cargo/registry/src/*/tauri-"$TAURI_VER" 2>/dev/null | head -1)"
echo "crate src: ${SRC:-NOT FOUND}"
[ -n "$SRC" ] || { echo "!! tauri crate source not vendored yet — run a cargo fetch first"; exit 1; }
head -1 "$SRC/mobile/ios-api/Package.swift"

section "swift build probe (copy of ios-api, isolated build dir)"
PROBE=/tmp/tauri-ios-api-probe
rm -rf "$PROBE" && cp -R "$SRC/mobile/ios-api" "$PROBE" && chmod -R u+w "$PROBE"
SDK="$(xcrun --sdk iphoneos --show-sdk-path)"

probe() {  # $1 = deployment target
  local tgt="arm64-apple-ios$1"
  section "swift build  -target $tgt"
  ( cd "$PROBE" && rm -rf .build && \
    swift build --sdk "$SDK" -c release --arch arm64 \
      --build-path "$PROBE/.build" \
      -Xswiftc -sdk -Xswiftc "$SDK" \
      -Xswiftc -target -Xswiftc "$tgt" \
      -Xcc "--target=$tgt" -Xcxx "--target=$tgt" )
  echo "→ exit: $?"
}

probe_triple() {  # $1 = deployment target — the swift-rs 1.0.8 / Xcode 27 form
  local tgt="arm64-apple-ios$1"
  section "swift build  --triple $tgt   (swift-rs >= 1.0.8 path)"
  ( cd "$PROBE" && rm -rf .build && \
    swift build --sdk "$SDK" -c release --triple "$tgt" \
      --build-path "$PROBE/.build" \
      -Xcc "--target=$tgt" -Xcxx "--target=$tgt" )
  echo "→ exit: $?"
  find "$PROBE/.build" -name "libTauri.a" 2>/dev/null | sed 's/^/built: /'
}

case "${1:-all}" in
  legacy) probe 13.0; probe 15.0 ;;          # swift-rs 1.0.7 form (broken on Xcode 27)
  triple) probe_triple 15.0 ;;               # swift-rs 1.0.8 form
  *)      probe 13.0; probe 15.0; probe_triple 15.0 ;;
esac

section "done"
echo "full log: $LOG"
