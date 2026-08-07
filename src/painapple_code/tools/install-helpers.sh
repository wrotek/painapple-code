#!/usr/bin/env bash
#
# install-helpers.sh — install painapple-code helpers to user-level locations.
#
# What it installs:
#   tools/shadow-git                  → ~/.local/bin/shadow-git
#   tools/shadow-query                → ~/.local/bin/shadow-query
#   tools/agents/shadow-git-helper.md → ~/.claude/agents/shadow-git-helper.md
#
# All targets are user-scoped. No sudo, no PATH edits, no shell rc edits.
# The shadow-git-helper agent invokes the CLI via its absolute path
# (~/.local/bin/shadow-git), so $PATH does not need to include ~/.local/bin.
#
# Usage:
#   src/painapple_code/tools/install-helpers.sh             # install (skip if target already exists)
#   src/painapple_code/tools/install-helpers.sh --update    # overwrite existing files (alias: --force)
#   src/painapple_code/tools/install-helpers.sh --uninstall # remove installed files
#   src/painapple_code/tools/install-helpers.sh --dry-run   # show plan without doing anything
#   src/painapple_code/tools/install-helpers.sh --help

set -euo pipefail

# ------- locate the package root regardless of where the script is invoked from.
# The script lives at src/painapple_code/tools/install-helpers.sh; PKG_ROOT
# is src/painapple_code/ (or its installed equivalent under site-packages).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ------- file pairs: "<source-relative-to-PKG_ROOT>|<target-absolute>"
#   tab-separated kept simple for bash 3 portability.
FILES=(
    "tools/shadow-git|$HOME/.local/bin/shadow-git"
    "tools/shadow-query|$HOME/.local/bin/shadow-query"
    "tools/agents/shadow-git-helper.md|$HOME/.claude/agents/shadow-git-helper.md"
)

# Legacy targets from earlier installs (renamed/moved files). Cleaned up
# on every run so users don't end up with both old and new agents.
LEGACY_TARGETS=(
    "$HOME/.claude/agents/shadow-git-researcher.md"
    "$HOME/.local/bin/dbq"
)

# ------- args
MODE="install"   # install | uninstall
FORCE=0
DRY_RUN=0

usage() {
    sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        --update|--force) FORCE=1 ;;
        --uninstall)      MODE="uninstall" ;;
        --dry-run)        DRY_RUN=1 ;;
        --help|-h)        usage ;;
        *) echo "Unknown argument: $1" >&2; echo "Run with --help for usage." >&2; exit 2 ;;
    esac
    shift
done

# ------- helpers
say()  { printf '%s\n' "$*"; }
run()  { if [ "$DRY_RUN" -eq 1 ]; then say "  [dry-run] $*"; else eval "$@"; fi; }

# Make a path display-friendly by collapsing $HOME → ~
tilde() { printf '%s\n' "${1/#$HOME/\~}"; }

install_one() {
    local src="$1" target="$2"
    local src_abs="$PKG_ROOT/$src"

    if [ ! -f "$src_abs" ]; then
        say "  ERROR: source missing: $src_abs" >&2
        return 1
    fi

    local target_dir
    target_dir="$(dirname "$target")"

    if [ ! -d "$target_dir" ]; then
        say "  mkdir -p $(tilde "$target_dir")"
        run "mkdir -p \"$target_dir\""
    fi

    if [ -e "$target" ] || [ -L "$target" ]; then
        if [ "$FORCE" -ne 1 ]; then
            say "  skip   $(tilde "$target")  (exists — use --update to overwrite)"
            return 0
        fi
        say "  update $(tilde "$target")"
    else
        say "  install $(tilde "$target")"
    fi

    run "cp -f \"$src_abs\" \"$target\""

    # Preserve executability for scripts
    if [ -x "$src_abs" ]; then
        run "chmod 755 \"$target\""
    fi
}

uninstall_one() {
    local target="$1"
    if [ -e "$target" ] || [ -L "$target" ]; then
        say "  remove $(tilde "$target")"
        run "rm -f \"$target\""
    else
        say "  skip   $(tilde "$target")  (not installed)"
    fi
}

# ------- run
DRY_LABEL=""
[ "$DRY_RUN" -eq 1 ] && DRY_LABEL=" (dry-run)"
say "painapple-code helpers — ${MODE}${DRY_LABEL}"
say "  pkg:  $(tilde "$PKG_ROOT")"
say ""

for pair in "${FILES[@]}"; do
    src="${pair%%|*}"
    target="${pair#*|}"
    if [ "$MODE" = "install" ]; then
        install_one "$src" "$target"
    else
        uninstall_one "$target"
    fi
done

# Clean up legacy targets on both install and uninstall.
for legacy in "${LEGACY_TARGETS[@]}"; do
    if [ -e "$legacy" ] || [ -L "$legacy" ]; then
        say "  remove (legacy) $(tilde "$legacy")"
        run "rm -f \"$legacy\""
    fi
done

say ""
if [ "$MODE" = "install" ] && [ "$DRY_RUN" -eq 0 ]; then
    say "Done. The shadow-git-helper agent is now available at:"
    say "  $(tilde "$HOME/.claude/agents/shadow-git-helper.md")"
    say "It invokes the CLI via the absolute path $(tilde "$HOME/.local/bin/shadow-git"),"
    say "so no PATH change is needed. Re-run with --update to refresh from the repo."
fi
