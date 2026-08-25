#!/usr/bin/env bash
# Report where the SwiftRs runtime exports (retain_object / release_object /
# string_from_bytes) live in the swift-rs build output, and in what binding
# (T = global/linkable, t = local/internalized, absent = not there at all).
#
# Those three are what the Rust link needs. Which of the three states we're in
# decides the fix, so measure rather than guess. Writes a full log to
# tauri-app/ios-symbols.log (gitignored, on the shared mount).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$SCRIPT_DIR/../ios-symbols.log"
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/Library/Caches/painapple-tauri-target}"
echo "target dir: $TARGET_DIR"
echo "swift-rs version in lock: $(awk '/^name = "swift-rs"/{f=1;next} f&&/^version/{gsub(/"/,"",$3);print $3;exit}' "$SCRIPT_DIR/../src-tauri/Cargo.lock")"
echo

echo "══════ every archive/object under a swift-rs build dir ══════"
find "$TARGET_DIR" -path "*/swift-rs/*" \( -name "*.a" -o -name "*.o" \) 2>/dev/null | while IFS= read -r f; do
    [ -n "$f" ] || continue
    hits="$(nm "$f" 2>/dev/null | grep -E "(_retain_object|_release_object|_string_from_bytes)$" | sort -u)"
    printf '\n── %s\n' "$f"
    printf '   mtime: %s  size: %s\n' "$(stat -f '%Sm' "$f" 2>/dev/null || stat -c '%y' "$f")" "$(stat -f '%z' "$f" 2>/dev/null || stat -c '%s' "$f")"
    if [ -n "$hits" ]; then
        echo "$hits" | sed 's/^/   /'
    else
        echo "   (none of the three symbols)"
    fi
    # Which members does this archive actually contain?
    case "$f" in
      *.a) nm "$f" 2>/dev/null | grep -E ':$' | sed 's/^/   member: /' | head -20 ;;
    esac
done

echo
echo "══════ whole-tree search: anything defining them ══════"
# Cast wider — maybe SwiftPM emitted a separate SwiftRs product we never link.
find "$TARGET_DIR" \( -name "*.a" -o -name "*.o" \) 2>/dev/null | while IFS= read -r f; do
    [ -n "$f" ] || continue
    if nm "$f" 2>/dev/null | grep -qE " [TtSsDd] (_retain_object|_string_from_bytes)$"; then
        echo "DEFINES: $f"
        nm "$f" 2>/dev/null | grep -E " [TtSsDd] (_retain_object|_release_object|_string_from_bytes)$" | sort -u | sed 's/^/   /'
    fi
done

echo
echo "full log: $LOG"
