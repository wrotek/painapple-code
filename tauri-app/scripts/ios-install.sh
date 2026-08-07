#!/usr/bin/env bash
# Usage: ios-install.sh [device-query] [--launch]
#   device-query  substring matched against device name/type (default: "ipad")
#   --launch      after install, also start the app on the device
#
# devicectl's "install" only installs — no auto-launch. The launch step is a
# separate `devicectl process launch` call we opt into here, so the default
# stays "install and let me tap the icon" but a single flag flips it to a
# one-shot deploy-and-run for tight iteration loops.
set -euo pipefail

QUERY="ipad"
LAUNCH=0
for arg in "$@"; do
  case "$arg" in
    --launch) LAUNCH=1 ;;
    --no-launch) LAUNCH=0 ;;
    --*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) QUERY="$arg" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IPA="$SCRIPT_DIR/../src-tauri/gen/apple/build/arm64/pAInapple Code.ipa"
BUNDLE_ID="com.boothw.painapple"

if [[ ! -f "$IPA" ]]; then
  echo "IPA not found at: $IPA" >&2
  echo "Run 'npm run ios:build' first." >&2
  exit 1
fi

UDID=$(QUERY="$QUERY" python3 - <<'PY'
import json, os, subprocess, sys
q = os.environ["QUERY"].lower()
out = subprocess.check_output(["xcrun", "devicectl", "list", "devices", "--json-output", "-"])
devices = json.loads(out).get("result", {}).get("devices", [])
matches = []
for d in devices:
    name = d.get("deviceProperties", {}).get("name", "")
    dtype = d.get("hardwareProperties", {}).get("deviceType", "")
    product = d.get("hardwareProperties", {}).get("productType", "")
    if q in f"{name} {dtype} {product}".lower():
        matches.append((name, d.get("identifier", "")))
if not matches:
    sys.exit(f"no device matching {q!r}")
if len(matches) > 1:
    names = ", ".join(n for n, _ in matches)
    sys.exit(f"multiple devices matching {q!r}: {names}")
print(matches[0][1])
PY
)

echo "Installing to: $UDID"
xcrun devicectl device install app --device "$UDID" "$IPA"

if [[ "$LAUNCH" == "1" ]]; then
  echo "Launching $BUNDLE_ID on $UDID"
  xcrun devicectl device process launch --device "$UDID" "$BUNDLE_ID"
fi
