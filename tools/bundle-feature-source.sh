#!/usr/bin/env bash
#
# bundle-feature-source.sh — populate bridge-source/ next to the painapple-code
# Feature's install.sh, plus mirror the whole feature into .devcontainer/
# painapple-code/ so the in-repo devcontainer can reference it as a local
# Feature path.
#
# Why this exists:
#   The Feature's install.sh used to `git clone` painapple-code from GitHub
#   at build time, which requires the repo to be public OR a token in the
#   build context. To stay private-friendly, we ship the bridge source inside
#   the Feature OCI artifact instead. This script produces that bundle.
#
# When to run:
#   - Automatically: via `initializeCommand` in .devcontainer/devcontainer.json
#     (fires on every `devcontainer up` / "Rebuild Container").
#   - Automatically: via the release-features.yml workflow before publish.
#   - Manually: any time you edit features/src/painapple-code/ files and want
#     the local devcontainer to pick them up without a full container rebuild.
#
# Flags:
#   --feature-only   Skip the .devcontainer/ mirror (useful in CI).
#
# Output:
#   features/src/painapple-code/bridge-source/       (canonical, gitignored)
#   .devcontainer/painapple-code/                    (mirror, gitignored,
#                                                    unless --feature-only)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

FEATURE_SRC="features/src/painapple-code"
LOCAL_FEATURE_DIR=".devcontainer/painapple-code"
BUNDLE_SUBDIR="bridge-source"

FEATURE_ONLY=false
[ "${1:-}" = "--feature-only" ] && FEATURE_ONLY=true

# Files NOT shipped to /opt/painapple-code in the runtime container.
# Everything else under git ls-files is included — keeps it whitelist-light
# and self-updating as the repo grows.
EXCLUDES=(
    --exclude='features'
    --exclude='examples'
    --exclude='.devcontainer'
    --exclude='.github'
    --exclude='painapple-docker.sh'
    --exclude='docker-compose.yml'
    --exclude='Dockerfile'
    --exclude='docker-entrypoint.sh'
    --exclude='deploy.fish'
    --exclude='claude-stats.fish'
    --exclude='start.sh'
    --exclude='start-server.sh'
    --exclude='CLAUDE.md'
    --exclude='TODO*.md'
    --exclude='WISHLIST.md'
    --exclude='scripts'
    --exclude='bugs'
    --exclude='node_modules'
    --exclude='package-lock.json'
)

generate_bundle() {
    local dest="$1"
    rm -rf "$dest"
    mkdir -p "$dest"
    # git archive HEAD streams a tarball of tracked files at the current
    # commit; tar -x with --exclude drops the devcontainer infra. We use
    # the working tree (not HEAD) when the script runs in CI on a freshly
    # checked-out workspace, but git archive is more reliable for the
    # "don't ship uncommitted junk" case.
    git archive --format=tar HEAD | tar -x -C "$dest" "${EXCLUDES[@]}"
    local count size
    count=$(find "$dest" -type f | wc -l)
    size=$(du -sh "$dest" | awk '{print $1}')
    echo "  → $count files, $size in $dest/"
}

echo "==> Generating $FEATURE_SRC/$BUNDLE_SUBDIR/"
generate_bundle "$FEATURE_SRC/$BUNDLE_SUBDIR"

if [ "$FEATURE_ONLY" = "true" ]; then
    echo "==> Done (--feature-only, skipping .devcontainer/ mirror)."
    exit 0
fi

# Mirror the entire Feature dir into .devcontainer/painapple-code/ so the
# in-repo devcontainer can reference "./painapple-code" without symlinks
# (which @devcontainers/cli rejects) and without duplicate manual copies.
echo "==> Mirroring $FEATURE_SRC/ → $LOCAL_FEATURE_DIR/"
rm -rf "$LOCAL_FEATURE_DIR"
mkdir -p "$LOCAL_FEATURE_DIR"
cp -a "$FEATURE_SRC"/. "$LOCAL_FEATURE_DIR/"
echo "  → $(find "$LOCAL_FEATURE_DIR" -type f | wc -l) files in $LOCAL_FEATURE_DIR/"
echo "==> Done."
