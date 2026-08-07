#!/usr/bin/env bash
# Usage: macos-install.sh [--launch]
#   --launch  after install, also open the app
#
# Counterpart to ios-install.sh. Assumes `npm run build` has already produced
# a .app under $CARGO_TARGET_DIR/release/bundle/macos/. Replaces any existing
# copy in /Applications and (optionally) opens the freshly installed app.
#
# Signing is not done here — it happens inside `tauri build` when
# APPLE_SIGNING_IDENTITY (and APPLE_API_KEY/APPLE_API_ISSUER/APPLE_API_KEY_PATH
# for notarization) are set in the environment. This script just reports what
# codesign/spctl say about the produced bundle, then copies it.
set -euo pipefail

LAUNCH=0
for arg in "$@"; do
  case "$arg" in
    --launch) LAUNCH=1 ;;
    --no-launch) LAUNCH=0 ;;
    --*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/Library/Caches/painapple-tauri-target}"
APP_NAME="pAInapple Code.app"
SRC_APP="$CARGO_TARGET_DIR/release/bundle/macos/$APP_NAME"
DST_APP="/Applications/$APP_NAME"

if [[ ! -d "$SRC_APP" ]]; then
  echo "App bundle not found at: $SRC_APP" >&2
  echo "Run 'npm run build' first." >&2
  exit 1
fi

# Report signing + Gatekeeper status (informational — don't fail the install).
echo "── signing status ──"
if codesign --verify --deep --strict "$SRC_APP" 2>/dev/null; then
  IDENT=$(codesign -dvv "$SRC_APP" 2>&1 | awk -F'=' '/^Authority=/{print $2; exit}')
  echo "codesign: OK${IDENT:+ ($IDENT)}"
else
  echo "codesign: UNSIGNED or invalid signature"
  echo "         Set APPLE_SIGNING_IDENTITY before 'npm run build' to sign."
fi

if SPCTL_OUT=$(spctl --assess --type execute --verbose "$SRC_APP" 2>&1); then
  echo "spctl:    $(echo "$SPCTL_OUT" | tail -n1)"
else
  echo "spctl:    REJECTED — first launch will require right-click → Open"
  echo "         (or set APPLE_API_KEY/APPLE_API_ISSUER/APPLE_API_KEY_PATH to notarize)"
fi

echo "── install ──"
if [[ -e "$DST_APP" ]]; then
  echo "Removing existing $DST_APP"
  rm -rf "$DST_APP"
fi
echo "Copying $SRC_APP → /Applications/"
cp -R "$SRC_APP" "$DST_APP"
echo "Installed."

if [[ "$LAUNCH" == "1" ]]; then
  echo "Launching $DST_APP"
  open "$DST_APP"
fi
