#!/usr/bin/env bash
# Bootstrap a sibling clone of tauri-apps/tao with our iOS patches applied.
# Cargo's [patch.crates-io] in src-tauri/Cargo.toml points at the resulting
# `../tao` directory, so this must succeed before any `cargo build` in this
# workspace (iOS, macOS, or desktop dev).
#
# Patches carried in tao-fix.patch:
#
#   1. view.rs — autorelease the UISceneConfiguration returned to UIKit.
#      tao 0.35.2's `Retained::as_ptr(&config) as _` drops the owning
#      `Retained` at function end before UIKit reads `delegateClass`, a
#      use-after-free that terminates the iPad launch in release builds.
#      Swapped for `Retained::autorelease_return(config)`.
#
#   2. app_state.rs — re-frame the UIWindow after `setWindowScene:`.
#      Spawned-after-launch windows (`SceneRequested` → new WebviewWindow)
#      keep their construction-time frame (inner_size or launch screen
#      bounds), which doesn't match a scene the system brought up at a
#      different size. The result is the WKWebView painting at the wrong
#      size with the scene's black background bleeding through the rest.
#
#   3. scene.rs — implement `windowScene:didUpdateCoordinateSpace:…`.
#      Without this UIWindowSceneDelegate callback, the UIWindow keeps the
#      frame it had at scene-attach time across Stage Manager drags, split
#      view resize, and orientation flips, leaving the newly-exposed area
#      black.
#
#   4. window.rs — implement `set_title` by setting `UIScene.title`.
#      Upstream's iOS impl is a no-op, so tauri's `window.set_title(...)`
#      (and our `set_session_name` Tauri command on top of it) silently
#      does nothing on iPad — every scene shows the bundle display name
#      and iPadOS appends " 1", " 2" to disambiguate. Routing through the
#      scene's title property fixes the Stage Manager Window menu and the
#      multitasking switcher.
#
# Idempotent. Drop this script + tao-fix.patch + the [patch.crates-io]
# block once an upstream tao release ships these fixes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAO_DIR="$SCRIPT_DIR/../../tao"
PATCH="$SCRIPT_DIR/tao-fix.patch"
TAG="tao-v0.35.2"

# Sentinel string from the newest hunk in tao-fix.patch — only matches when
# the current patch is fully applied. Bump this whenever the patch grows so
# existing clones with stale patches get re-patched instead of skipped.
SENTINEL="iPadOS reads UIScene.title"
SENTINEL_FILE="$TAO_DIR/src/platform_impl/ios/window.rs"

if [ -d "$TAO_DIR/.git" ]; then
    if grep -q "$SENTINEL" "$SENTINEL_FILE" 2>/dev/null; then
        # already patched — silent fast path
        exit 0
    fi
    # Either freshly cloned but unpatched, or carrying an older patch.
    # Reset the iOS source tree to the pristine tag so `git apply` always
    # starts from a clean base — otherwise the autorelease_return chunk
    # from an earlier patch would conflict on re-apply.
    echo "tao-setup: resetting $TAO_DIR/src/platform_impl/ios/ before reapplying tao-fix.patch"
    git -C "$TAO_DIR" checkout "$TAG" -- src/platform_impl/ios/
else
    echo "tao-setup: cloning tauri-apps/tao $TAG to $TAO_DIR"
    git clone --branch "$TAG" --depth 1 https://github.com/tauri-apps/tao.git "$TAO_DIR"
fi

(cd "$TAO_DIR" && git apply "$PATCH")
echo "tao-setup: applied $PATCH"
