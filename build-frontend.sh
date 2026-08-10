#!/usr/bin/env bash
# Build the frontend bundle for a from-source deployment.
#
# Running from a checkout (./start.sh, a git worktree, a systemd unit) serves
# the 186 ES modules individually — great for editing, but a cold load costs
# ~195 requests across ~6 dependency waves. This produces the same single
# bundle the wheel and Docker image ship, cutting that to ~11 requests.
#
# Safe to skip entirely: with no bundle present the server just serves loose
# modules, exactly as before. Safe to run repeatedly.
#
#   ./build-frontend.sh            build (bootstraps node deps on first run)
#   ./build-frontend.sh --clean    remove the bundle, back to loose modules
#
# After editing anything under static/js/ the bundle is stale; the server
# notices and falls back to loose modules until you re-run this. So on a dev
# box you generally want --clean, and on a deployment you re-run this after
# every update (deploy.fish does it for stable automatically).
set -e

cd "$(dirname "$0")"
BUNDLER=tools/bundler
OUT=src/painapple_code/static/dist

if [ "$1" = "--clean" ]; then
    rm -rf "$OUT"
    echo "removed $OUT — serving loose modules"
    exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
    cat >&2 <<'EOF'
error: npm not found.

The bundle needs Node to build. Either install Node 18+, or skip this —
the server runs fine without a bundle, just with a slower cold load.
EOF
    exit 1
fi

# Only esbuild + yaml (~7 MB), deliberately not tools/package.json's full
# vendor/render toolchain, which compiles native modules.
if [ ! -d "$BUNDLER/node_modules" ] || [ "$BUNDLER/package-lock.json" -nt "$BUNDLER/node_modules" ]; then
    echo "installing bundler deps..."
    npm ci --ignore-scripts --silent --prefix "$BUNDLER"
fi

node "$BUNDLER/build-app.mjs"
echo "restart the server to pick it up"
