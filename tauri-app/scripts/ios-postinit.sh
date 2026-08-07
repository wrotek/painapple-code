#!/usr/bin/env bash
# Re-apply our patches to the cargo-mobile2-generated iOS Xcode project after
# `tauri ios init` regenerates `gen/apple/project.yml` from its template.
#
# Each patch is independently idempotent (sentinel grep), so this script is
# safe to run before every build. Patches:
#
#   1. UIApplicationSceneManifest + UISceneConfigurations — needed for iPadOS
#      multi-scene. The `UIApplicationSupportsMultipleScenes: true` flag tells
#      tao's iOS layer to opt the app into the scene lifecycle; without it
#      `multiple_scenes_enabled() == false` and additional UIWindowScenes are
#      refused (iPad drag-from-dock split view opens full-screen).
#
#      The `UISceneConfigurations` block is the Info.plist fallback iOS uses
#      when AppDelegate's `configurationForConnectingSceneSession:` returns a
#      UISceneConfiguration with a nil `delegateClass`. In release builds tao
#      0.35.2's implementation hits exactly that: objc2's `define_class!`
#      lazy registration is dead-stripped by `-O` and `TaoSceneDelegate::class()`
#      returns nil, so iOS terminates the launch unless this fallback is
#      declared. `ios:dev` doesn't trigger it because debug builds keep the
#      registration data live.
#
#   2. Externals excludes "**/*.a" — the template adds the whole `Externals/`
#      tree as sources, which makes XcodeGen schedule both
#      `Externals/arm64/debug/libapp.a` and `Externals/arm64/release/libapp.a`
#      as resource copies into the same `<App>.app/libapp.a` slot. Xcode then
#      errors with "Multiple commands produce libapp.a". The static lib is
#      already linked via LIBRARY_SEARCH_PATHS + the libapp.a dependency,
#      so excluding `*.a` from the source group is the right fix.
#
#   3. iCloud KV-store entitlement — `tauri ios init` writes an empty
#      .entitlements plist; we need `com.apple.developer.ubiquity-kvstore-identifier`
#      so the Rust/Swift side can use NSUbiquitousKeyValueStore to sync the
#      recent-servers list across devices. The value uses Xcode's build-time
#      $(TeamIdentifierPrefix)$(CFBundleIdentifier) substitution, which gives
#      every device signed into the same Apple ID a shared key-value bucket
#      scoped to this app's bundle ID.
#
#   4. native-ios/ sources copy — brings our tracked Obj-C(++) sources
#      into the iOS target so they get compiled into the app. Currently
#      this brings in KeyCommandShim.mm (UIKeyCommand swizzle for Cmd+W →
#      close-tab). The canonical copy lives outside gen/apple/ so it
#      survives `tauri ios init`; this patch copies it into
#      gen/apple/Sources/painapple-code-app/ where xcodegen's `- path:
#      Sources` recursive scan picks it up. (An earlier revision of this
#      patch instead injected `- path: ../../native-ios` into project.yml
#      under `sources:` — xcodegen silently dropped that path because
#      it traverses outside the project root, so no source was actually
#      added. The copy approach sidesteps that limitation.)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APPLE_DIR="$SCRIPT_DIR/../src-tauri/gen/apple"
PROJECT_YML="$APPLE_DIR/project.yml"
ENTITLEMENTS="$APPLE_DIR/painapple-code-app_iOS/painapple-code-app_iOS.entitlements"

if [ ! -f "$PROJECT_YML" ]; then
    echo "ios-postinit: $PROJECT_YML not found — run 'tauri ios init' first" >&2
    exit 1
fi

changed=0

# ── Patch 1: UIApplicationSceneManifest + UISceneConfigurations ───────────
# Sentinel checks for UISceneConfigurations (the full patch), not just the
# manifest key — earlier revisions of this script wrote only the manifest,
# and a re-run on such a project.yml needs to upgrade it.
if grep -q "UISceneConfigurations" "$PROJECT_YML"; then
    echo "ios-postinit: UISceneConfigurations already present, skipping"
elif grep -q "UIApplicationSceneManifest" "$PROJECT_YML"; then
    echo "ios-postinit: stale partial UIApplicationSceneManifest detected (no UISceneConfigurations)" >&2
    echo "             rm -rf src-tauri/gen/apple and re-run 'npm run ios:init'" >&2
    exit 1
else
    python3 - "$PROJECT_YML" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path).read()
# Match the 6-space-indented "properties:" line under info: under the iOS target.
pattern = r'(\n      properties:\n)'
addition = (
    '        UIApplicationSceneManifest:\n'
    '          UIApplicationSupportsMultipleScenes: true\n'
    '          UISceneConfigurations:\n'
    '            UIWindowSceneSessionRoleApplication:\n'
    '              - UISceneConfigurationName: TaoScene\n'
    '                UISceneDelegateClassName: TaoSceneDelegate\n'
)
new_text, count = re.subn(pattern, lambda m: m.group(1) + addition, text, count=1)
if count == 0:
    sys.exit("ios-postinit: could not locate 'properties:' section in project.yml")
open(path, 'w').write(new_text)
print("ios-postinit: added UIApplicationSceneManifest + UISceneConfigurations to project.yml")
PY
    changed=1
fi

# ── Patch 2: Externals excludes "**/*.a" ──────────────────────────────────
# Sentinel is the literal exclude pattern — unique enough that finding it
# anywhere in the file means Patch 2 has already run.
if grep -qF '"**/*.a"' "$PROJECT_YML"; then
    echo "ios-postinit: Externals *.a exclude already present, skipping"
else
    python3 - "$PROJECT_YML" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path).read()
# Replace bare `- path: Externals\n` with the same line plus an excludes block.
# Use a lookahead for the next sibling `- path:` line so we only match the bare
# (unconfigured) form and don't double-patch a partially-extended entry.
pattern = r'(- path: Externals)\n(?=\s+- path:)'
addition = (
    r'\1\n'
    r'        excludes:\n'
    r'          - "**/*.a"\n'
)
new_text, count = re.subn(pattern, addition, text, count=1)
if count == 0:
    sys.exit("ios-postinit: could not locate bare '- path: Externals' line in project.yml")
open(path, 'w').write(new_text)
print("ios-postinit: added '**/*.a' exclude to Externals source in project.yml")
PY
    changed=1
fi

# ── Patch 3: iCloud KV-store entitlement ──────────────────────────────────
# PlistBuddy is bundled with macOS so it's always available wherever this
# script runs. The "Add" subcommand fails if the key already exists, so we
# probe with "Print" first to keep the script idempotent.
if [ ! -f "$ENTITLEMENTS" ]; then
    echo "ios-postinit: $ENTITLEMENTS not found — skipping iCloud entitlement patch"
elif /usr/libexec/PlistBuddy -c "Print :com.apple.developer.ubiquity-kvstore-identifier" "$ENTITLEMENTS" >/dev/null 2>&1; then
    echo "ios-postinit: iCloud KV-store entitlement already present, skipping"
else
    /usr/libexec/PlistBuddy \
        -c 'Add :com.apple.developer.ubiquity-kvstore-identifier string $(TeamIdentifierPrefix)$(CFBundleIdentifier)' \
        "$ENTITLEMENTS"
    echo "ios-postinit: added com.apple.developer.ubiquity-kvstore-identifier to entitlements"
fi

# ── Patch 4: copy native-ios/ sources into Sources/painapple-code-app/ ────
# Copies our tracked Obj-C(++) sources from `src-tauri/native-ios/` into
# the gen tree's `Sources/painapple-code-app/` directory so xcodegen's
# recursive `- path: Sources` scan picks them up. rsync-style: only copies
# when source is newer/missing on the dest side, so re-runs are no-ops.
NATIVE_IOS_SRC="$SCRIPT_DIR/../src-tauri/native-ios"
NATIVE_IOS_DST="$APPLE_DIR/Sources/painapple-code-app"
if [ -d "$NATIVE_IOS_SRC" ] && [ -d "$NATIVE_IOS_DST" ]; then
    copied=0
    for src in "$NATIVE_IOS_SRC"/*.mm "$NATIVE_IOS_SRC"/*.m "$NATIVE_IOS_SRC"/*.swift; do
        [ -e "$src" ] || continue
        dst="$NATIVE_IOS_DST/$(basename "$src")"
        if [ ! -f "$dst" ] || [ "$src" -nt "$dst" ]; then
            cp "$src" "$dst"
            echo "ios-postinit: copied $(basename "$src") → Sources/painapple-code-app/"
            copied=1
        fi
    done
    if [ "$copied" = "0" ]; then
        echo "ios-postinit: native-ios sources already up-to-date, skipping"
    else
        changed=1
    fi
fi
# Clean up the dead `- path: ../../native-ios` line from a prior revision
# of this patch (xcodegen silently dropped it; leaving it in is harmless
# but misleading when debugging).
if grep -q "\\.\\./\\.\\./native-ios" "$PROJECT_YML"; then
    python3 - "$PROJECT_YML" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path).read()
new_text = re.sub(r'^      - path: \.\./\.\./native-ios\n', '', text, count=1, flags=re.MULTILINE)
if new_text != text:
    open(path, 'w').write(new_text)
    print("ios-postinit: removed stale '- path: ../../native-ios' line from project.yml")
PY
    changed=1
fi

# ── Patch 5: force iOS deployment target >= 15.0 ──────────────────────────
# cargo-mobile2's project.yml template hardcodes `deploymentTarget: iOS: 14.0`
# and does NOT read `bundle.iOS.minimumSystemVersion` from tauri.conf.json, so
# the generated Xcode project always lands on 14.0 regardless of config. The
# iOS 27 SDK refuses any deployment target below 15.0 ("the range of supported
# deployment target versions is 15.0 to 27.0"), failing the build. Rewrite the
# value here, after `tauri ios init` has regenerated project.yml from template.
# Sentinel: a target line that already parses to >= 15 means we've run.
if python3 - "$PROJECT_YML" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
m = re.search(r'deploymentTarget:\n\s+iOS:\s*([\d.]+)', text)
sys.exit(0 if (m and tuple(int(p) for p in m.group(1).split('.')) >= (15, 0)) else 1)
PY
then
    echo "ios-postinit: iOS deployment target already >= 15.0, skipping"
else
    python3 - "$PROJECT_YML" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path).read()
new_text, count = re.subn(
    r'(deploymentTarget:\n\s+iOS:\s*)[\d.]+',
    lambda m: m.group(1) + '15.0', text, count=1)
if count == 0:
    sys.exit("ios-postinit: could not locate 'deploymentTarget: iOS:' in project.yml")
open(path, 'w').write(new_text)
print("ios-postinit: forced iOS deployment target to 15.0 in project.yml")
PY
    changed=1
fi

# ── Regenerate .xcodeproj from the edited project.yml ─────────────────────
# tauri ios init runs xcodegen once with the template's project.yml, then
# our patches modify project.yml — xcodebuild would otherwise see the stale
# pbxproj. Only re-run when something actually changed so repeated dev
# invocations stay fast.
if [ "$changed" = "1" ]; then
    if ! command -v xcodegen >/dev/null 2>&1; then
        echo "ios-postinit: xcodegen not found on PATH (brew install xcodegen)" >&2
        exit 1
    fi
    echo "ios-postinit: regenerating xcodeproj via xcodegen"
    (cd "$APPLE_DIR" && xcodegen generate --quiet)
fi
