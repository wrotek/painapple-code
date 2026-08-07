#!/usr/bin/env bash
# painapple-docker.sh — image build companion for repo checkouts.
#
# This script now does exactly ONE thing: build the painapple-code container
# image from the Dockerfile next to it (including the personalized
# --devcontainer / --dockerfile build paths). Everything else — running the
# bridge, lifecycle, config, passwords, pulling prebuilt images — moved into
# the unified `painapple` CLI:
#
#   pipx install painapple-code
#   painapple --in-docker                       # run the bridge in a container
#   painapple setup NAME                        # per-profile setup wizard
#   painapple start/stop/logs/password NAME     # lifecycle + auth
#   painapple pull                              # fetch the prebuilt image
#
# Build configuration is self-contained: flags and env vars with sane
# defaults (see `help`). As a legacy convenience, if an old wrapper.conf
# (~/.painapple-code/wrapper.conf) is present, its build-relevant keys —
# IMAGE, DEVCONTAINER_PATH, DOCKERFILE_PATH, RUNTIME, RUNTIME_FLAGS — are
# still READ as defaults (env vars and flags win). This script never
# writes that file; the unified CLI no longer reads or writes it either.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# ──── Defaults ────────────────────────────────────────────────────────────
PAINAPPLE_HOME="${PAINAPPLE_HOME:-$HOME/.painapple-code}"
# Legacy wrapper config — read-only, build-relevant keys only (see header).
CONFIG_FILE="$PAINAPPLE_HOME/wrapper.conf"
IMAGE_DEFAULT="painapple-code:latest"

# Tag used for the unmodified painapple-code base when a personalized build
# is requested. The final image (tagged $IMAGE) is built ON TOP of this one
# by @devcontainers/cli, so two `build` calls back-to-back stay cache-warm.
PERSONALIZE_BASE_TAG="painapple-code:base"

# ──── Colors ──────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_BOLD=$'\e[1m'; C_DIM=$'\e[2m'
    C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'; C_RED=$'\e[31m'
    C_BLUE=$'\e[34m'; C_CYAN=$'\e[36m'; C_RESET=$'\e[0m'
else
    C_BOLD='' C_DIM='' C_GREEN='' C_YELLOW='' C_RED='' C_BLUE='' C_CYAN='' C_RESET=''
fi

say()  { printf '%s\n' "$*"; }
info() { printf '%s %s\n' "${C_BLUE}→${C_RESET}" "$*"; }
ok()   { printf '%s %s\n' "${C_GREEN}✓${C_RESET}" "$*"; }
warn() { printf '%s %s\n' "${C_YELLOW}⚠${C_RESET}" "$*" >&2; }
err()  { printf '%s %s\n' "${C_RED}✗${C_RESET}" "$*" >&2; }

# ──── Runtime resolution ──────────────────────────────────────────────────
# Priority: env (single-run override) > legacy wrapper.conf > auto-detect.
#
# Env values are captured ONCE at script start before anything else runs,
# so the `. $CONFIG_FILE` inside load_config can't clobber them.
ENV_RUNTIME="${RUNTIME-}"
ENV_RUNTIME_FLAGS="${RUNTIME_FLAGS-}"
ENV_IMAGE="${IMAGE-}"
RUNTIME=""
RUNTIME_FLAGS=""
RUNTIME_FLAGS_ARRAY=()

# Auto-detect when neither env nor config supplied a runtime. Prefers
# docker because it's the more common default; users on podman-only
# hosts (rootless RHEL/Fedora) still get it as fallback.
auto_detect_runtime() {
    if command -v docker > /dev/null 2>&1; then
        echo docker
    elif command -v podman > /dev/null 2>&1; then
        echo podman
    else
        err "Neither docker nor podman found in PATH."
        err "Install one of them, or set RUNTIME=… to override."
        exit 1
    fi
}

# Call the runtime through R() rather than "$RUNTIME" directly, so the
# RUNTIME_FLAGS injection (e.g. --storage-driver=vfs) applies uniformly.
R() {
    "$RUNTIME" "${RUNTIME_FLAGS_ARRAY[@]}" "$@"
}

# ──── Config load (read-only) ─────────────────────────────────────────────
# Initializes the build-relevant settings from defaults, layers the legacy
# wrapper.conf over them if one exists (READ ONLY — never written), then
# lets env vars win. Any non-build keys a legacy config defines are sourced
# into throwaway variables and ignored.
load_config() {
    IMAGE="$IMAGE_DEFAULT"
    # Empty = standard build. When set to a file or directory path, `build`
    # layers the user's devcontainer.json features on top of painapple-code
    # via @devcontainers/cli — see cmd_build's personalize branch.
    DEVCONTAINER_PATH=""
    # Empty = standard build. When set to a Dockerfile (or directory
    # containing one), `build` appends that Dockerfile's instructions
    # (RUN/COPY/ENV/etc.) on top of painapple-code:base. Mutually
    # exclusive with DEVCONTAINER_PATH.
    DOCKERFILE_PATH=""
    RUNTIME=""
    RUNTIME_FLAGS=""
    if [ -f "$CONFIG_FILE" ]; then
        # shellcheck source=/dev/null
        . "$CONFIG_FILE"
    fi
    [ -z "$IMAGE" ] && IMAGE="$IMAGE_DEFAULT"

    # Env overrides beat legacy config values. The env values were captured
    # at script start, BEFORE the config was sourced.
    [ -n "$ENV_RUNTIME"       ] && RUNTIME="$ENV_RUNTIME"
    [ -n "$ENV_RUNTIME_FLAGS" ] && RUNTIME_FLAGS="$ENV_RUNTIME_FLAGS"
    [ -n "$ENV_IMAGE"         ] && IMAGE="$ENV_IMAGE"
    [ -z "$RUNTIME" ] && RUNTIME="$(auto_detect_runtime)"

    RUNTIME_FLAGS_ARRAY=()
    if [ -n "$RUNTIME_FLAGS" ]; then
        read -ra RUNTIME_FLAGS_ARRAY <<< "$RUNTIME_FLAGS"
    fi
    return 0
}

# ──── Path resolvers ──────────────────────────────────────────────────────
# Resolve a user-supplied devcontainer path (file or directory) to the
# canonical devcontainer.json. Echoes the resolved file path on stdout;
# returns non-zero if nothing matches.
resolve_devcontainer_path() {
    local p="$1"
    if [ -f "$p" ]; then
        echo "$p"
        return 0
    fi
    if [ -d "$p" ]; then
        if [ -f "$p/devcontainer.json" ]; then
            echo "$p/devcontainer.json"
            return 0
        fi
        if [ -f "$p/.devcontainer/devcontainer.json" ]; then
            echo "$p/.devcontainer/devcontainer.json"
            return 0
        fi
    fi
    return 1
}

# Resolve a user-supplied Dockerfile path (file or directory) to the
# canonical Dockerfile. Echoes the resolved file path on stdout; returns
# non-zero if nothing matches. Lowercase / alternate names (Dockerfile.dev
# etc.) need to be passed as an explicit file path.
resolve_dockerfile_path() {
    local p="$1"
    if [ -f "$p" ]; then
        echo "$p"
        return 0
    fi
    if [ -d "$p" ]; then
        if [ -f "$p/Dockerfile" ]; then
            echo "$p/Dockerfile"
            return 0
        fi
    fi
    return 1
}

# ──── Build ───────────────────────────────────────────────────────────────
build_usage() {
    cat <<EOF
${C_BOLD}Usage:${C_RESET} $0 build [--devcontainer PATH | --no-devcontainer]
                [--dockerfile PATH   | --no-dockerfile]

Build the painapple-code container image (tagged \$IMAGE, default
$IMAGE_DEFAULT). Two mutually exclusive personalize options:

  --devcontainer PATH   layer OCI features from a devcontainer.json on top
                        of the painapple-code base (uses @devcontainers/cli)
  --dockerfile PATH     append your own Dockerfile's instructions on top of
                        painapple-code:base (final FROM rewritten,
                        CMD/ENTRYPOINT stripped)
  --no-devcontainer     one-off skip of a legacy-configured DEVCONTAINER_PATH
  --no-dockerfile       one-off skip of a legacy-configured DOCKERFILE_PATH
EOF
}

cmd_build() {
    load_config

    # Standalone-script guard. Someone who curled just this .sh into an
    # otherwise-empty directory hits `build` and gets a confusing
    # `docker build` error about a missing Dockerfile. Detect that case
    # up-front and point them at the two real options.
    if [ ! -f "$SCRIPT_DIR/Dockerfile" ]; then
        err "No Dockerfile next to $0 — can't run a local build."
        say ""
        say "Looks like you're running the script standalone (without the repo)."
        say "Two ways forward:"
        say ""
        say "  ${C_BOLD}1.${C_RESET} Use the pre-built image instead (no repo needed):"
        say "       pipx install painapple-code"
        say "       painapple pull && painapple --in-docker"
        say ""
        say "  ${C_BOLD}2.${C_RESET} Clone the repo, then build from there:"
        say "       git clone https://github.com/wrotek/painapple-code.git"
        say "       cd painapple-code"
        say "       ./painapple-docker.sh build"
        exit 1
    fi

    # Parse flags. Two personalize backends, each with the same shape of
    # knobs over the legacy-config defaults:
    #   --devcontainer PATH    layer features via @devcontainers/cli
    #   --no-devcontainer      one-off skip of a configured DEVCONTAINER_PATH
    #   --dockerfile PATH      append user's Dockerfile onto painapple-code:base
    #   --no-dockerfile        one-off skip of a configured DOCKERFILE_PATH
    # --devcontainer and --dockerfile are mutually exclusive — they
    # describe two different ways to extend the same base image.
    local one_off_devcontainer="" skip_devcontainer=0
    local one_off_dockerfile=""   skip_dockerfile=0
    while [ "$#" -gt 0 ]; do
        case "$1" in
            -h|--help)
                build_usage
                exit 0
                ;;
            --devcontainer)
                if [ "$#" -lt 2 ]; then
                    err "--devcontainer needs a PATH argument"
                    exit 1
                fi
                one_off_devcontainer="$2"
                case "$one_off_devcontainer" in
                    "~"|"~/"*) one_off_devcontainer="${HOME}${one_off_devcontainer#\~}" ;;
                esac
                shift 2
                ;;
            --no-devcontainer)
                skip_devcontainer=1
                shift
                ;;
            --dockerfile)
                if [ "$#" -lt 2 ]; then
                    err "--dockerfile needs a PATH argument"
                    exit 1
                fi
                one_off_dockerfile="$2"
                case "$one_off_dockerfile" in
                    "~"|"~/"*) one_off_dockerfile="${HOME}${one_off_dockerfile#\~}" ;;
                esac
                shift 2
                ;;
            --no-dockerfile)
                skip_dockerfile=1
                shift
                ;;
            -*)
                err "Unknown flag: $1"
                build_usage >&2
                exit 1
                ;;
            *)
                err "Unexpected argument: $1"
                exit 1
                ;;
        esac
    done

    if [ -n "$one_off_devcontainer" ] && [ -n "$one_off_dockerfile" ]; then
        err "--devcontainer and --dockerfile are mutually exclusive."
        exit 1
    fi

    # Resolve the effective devcontainer path for this run.
    local effective_devcontainer=""
    if [ "$skip_devcontainer" = 1 ]; then
        effective_devcontainer=""
    elif [ -n "$one_off_devcontainer" ]; then
        if ! effective_devcontainer="$(resolve_devcontainer_path "$one_off_devcontainer")"; then
            err "No devcontainer.json found at: $one_off_devcontainer"
            err "Expected: a file, or a dir containing devcontainer.json or .devcontainer/devcontainer.json"
            exit 1
        fi
    elif [ -n "$DEVCONTAINER_PATH" ]; then
        if ! effective_devcontainer="$(resolve_devcontainer_path "$DEVCONTAINER_PATH")"; then
            err "DEVCONTAINER_PATH from legacy $CONFIG_FILE no longer resolves: $DEVCONTAINER_PATH"
            err "Fix or remove it in that file (this script never writes it),"
            err "or skip with: $0 build --no-devcontainer"
            exit 1
        fi
    fi

    # Resolve the effective dockerfile path for this run. A one-off
    # --dockerfile overrides DEVCONTAINER_PATH (and vice versa via
    # --devcontainer) — explicit flag wins over saved config.
    local effective_dockerfile=""
    if [ "$skip_dockerfile" = 1 ]; then
        effective_dockerfile=""
    elif [ -n "$one_off_dockerfile" ]; then
        if ! effective_dockerfile="$(resolve_dockerfile_path "$one_off_dockerfile")"; then
            err "No Dockerfile found at: $one_off_dockerfile"
            err "Expected: a file, or a dir containing 'Dockerfile'"
            exit 1
        fi
        # Explicit --dockerfile silences any saved DEVCONTAINER_PATH for
        # this run so the two backends never collide.
        effective_devcontainer=""
    elif [ -n "$one_off_devcontainer" ]; then
        # Symmetric: explicit --devcontainer silences saved DOCKERFILE_PATH.
        effective_dockerfile=""
    elif [ -n "$DOCKERFILE_PATH" ] && [ -z "$effective_devcontainer" ]; then
        if ! effective_dockerfile="$(resolve_dockerfile_path "$DOCKERFILE_PATH")"; then
            err "DOCKERFILE_PATH from legacy $CONFIG_FILE no longer resolves: $DOCKERFILE_PATH"
            err "Fix or remove it in that file (this script never writes it),"
            err "or skip with: $0 build --no-dockerfile"
            exit 1
        fi
    fi

    cd "$SCRIPT_DIR"

    local build_args=(--build-arg "USER_UID=$(id -u)")
    if [ "$RUNTIME" = "docker" ]; then
        build_args+=(--build-arg "USER_GID=$(id -g)")
    fi

    if [ -z "$effective_devcontainer" ] && [ -z "$effective_dockerfile" ]; then
        # Standard build — nothing layered on top.
        info "Building $IMAGE with ${RUNTIME}…"
        R build "${build_args[@]}" -t "$IMAGE" .
        ok "Built $IMAGE"
        return 0
    fi

    if [ -n "$effective_devcontainer" ]; then
        # ─── Personalized build via devcontainer.json features ────────────
        # Stage 1: build the painapple-code base under a fixed local tag.
        # Stage 2: hand a wrapper devcontainer.json (image = that base,
        #          features = user's) to @devcontainers/cli.
        cmd_build_personalize "$effective_devcontainer" "${build_args[@]}"
    else
        # ─── Personalized build via user-supplied Dockerfile ──────────────
        # Stage 1: build painapple-code:base from our Dockerfile (untouched).
        # Stage 2: generate a wrapper Dockerfile whose final FROM is rewritten
        #          to FROM painapple-code:base, with CMD/ENTRYPOINT stripped,
        #          and build it against the user's project as the context.
        cmd_build_dockerfile_personalize "$effective_dockerfile" "${build_args[@]}"
    fi
}

# Personalized build path — invoked by cmd_build when a devcontainer path
# is in play. Kept separate so the standard build stays a one-liner.
cmd_build_personalize() {
    local user_devcontainer="$1"; shift
    local build_args=("$@")

    # @devcontainers/cli is the official tool — handles OCI feature
    # resolution, install ordering (installsAfter), and user/UID gymnastics
    # inside the build. We invoke via npx so the user doesn't need a
    # global install.
    if ! command -v node >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
        err "Personalized builds need Node.js + npx on the host."
        err "Install Node 18+ and re-run, or use --no-devcontainer to skip."
        exit 1
    fi

    # @devcontainers/cli currently drives Docker by default. Podman works
    # via --docker-path=podman, with the same UID/userns considerations
    # that apply to the rest of this script.
    #
    # Image-name quirk: when the CLI sees a bare `image: foo:tag` it tries
    # to ensure the image exists, which under podman triggers
    # `podman pull foo:tag` and resolves against docker.io/library/foo:tag
    # — failing for our locally-built base. Fully-qualifying the tag as
    # `localhost/foo:tag` makes podman skip the registry round-trip and
    # find the local image directly. Docker tolerates the same prefix.
    local base_tag="$PERSONALIZE_BASE_TAG"
    if [ "$RUNTIME" = "podman" ]; then
        base_tag="localhost/$PERSONALIZE_BASE_TAG"
        info "Note: @devcontainers/cli will be invoked with --docker-path=podman."
    fi

    info "Personalized build — base: $base_tag, image: $IMAGE"
    info "  features from: $user_devcontainer"

    # ── Stage 1: base image ──
    # Tag as $base_tag (not $IMAGE) so stage 2 has a stable FROM to layer
    # onto. Idempotent — caches like any other build.
    info "Stage 1/2: Building $base_tag…"
    R build "${build_args[@]}" -t "$base_tag" .
    ok "Built $base_tag"

    # ── Stage 2: layer features via @devcontainers/cli ──
    local tmpdir
    tmpdir="$(mktemp -d -t painapple-personalize.XXXXXX)"
    # Cleanup even on early exit — keeps stray copies of user devcontainer
    # configs out of /tmp.
    trap 'rm -rf "$tmpdir"' EXIT
    mkdir -p "$tmpdir/.devcontainer"

    info "Stage 2/2: Layering features via @devcontainers/cli…"
    if ! node "$SCRIPT_DIR/tools/personalize-devcontainer.js" \
            "$user_devcontainer" \
            "$tmpdir/.devcontainer/devcontainer.json" \
            "$base_tag"; then
        err "Failed to generate wrapper devcontainer.json"
        exit 1
    fi

    local cli_args=(
        --workspace-folder "$tmpdir"
        --image-name "$IMAGE"
    )
    if [ "$RUNTIME" = "podman" ]; then
        cli_args+=(--docker-path podman)
    fi

    # Use the npx-pinned current major; @devcontainers/cli is API-stable
    # within a major and Codespaces tracks the same baseline.
    if ! npx -y @devcontainers/cli@latest build "${cli_args[@]}"; then
        err "devcontainer build failed."
        err "  wrapper: $tmpdir/.devcontainer/devcontainer.json"
        err "Inspect, edit if needed, then re-run."
        # Defuse the cleanup trap so the user can post-mortem the wrapper.
        trap - EXIT
        exit 1
    fi

    ok "Built $IMAGE (personalized)"
    say "  Base:     $base_tag"
    say "  Features: $user_devcontainer"
}

# Personalized build via user-supplied Dockerfile. Mirrors the
# devcontainer flow's two-stage shape, but instead of features it
# appends the user's RUN/COPY/ENV/etc. on top of painapple-code:base.
#
# How the wrapper Dockerfile is synthesized:
#   - Every FROM line except the last is preserved verbatim. This keeps
#     multi-stage builders (e.g. `FROM golang AS builder`) working — they
#     run before the final stage and stay reachable via `COPY --from=`.
#   - The last FROM is replaced with `FROM <base_tag>` (preserving any
#     `AS <alias>` suffix the user had on it, just in case downstream
#     consumers reference it).
#   - CMD and ENTRYPOINT lines are stripped so painapple-code:base's
#     entrypoint (the bridge launcher) survives. If the user really needs
#     a different CMD they can re-add it after their build, but for the
#     common "I want my tools installed" use case stripping is correct.
#   - The user's project directory (= dirname of their Dockerfile) is the
#     build context, so `COPY` paths inside their file still resolve.
cmd_build_dockerfile_personalize() {
    local user_dockerfile="$1"; shift
    local build_args=("$@")

    # Same localhost/ prefix trick as the devcontainer flow under podman,
    # so the wrapper Dockerfile's FROM line doesn't trigger a docker.io
    # registry lookup for the locally-built base.
    local base_tag="$PERSONALIZE_BASE_TAG"
    if [ "$RUNTIME" = "podman" ]; then
        base_tag="localhost/$PERSONALIZE_BASE_TAG"
    fi

    info "Personalized build (Dockerfile) — base: $base_tag, image: $IMAGE"
    info "  appending: $user_dockerfile"

    # ── Stage 1: base image ──
    info "Stage 1/2: Building $base_tag…"
    R build "${build_args[@]}" -t "$base_tag" .
    ok "Built $base_tag"

    # ── Stage 2: generate wrapper Dockerfile + build ──
    local tmpdir
    tmpdir="$(mktemp -d -t painapple-personalize-dockerfile.XXXXXX)"
    trap 'rm -rf "$tmpdir"' EXIT

    # Count FROM lines so the rewriter knows which one is the "final"
    # stage. `|| true` keeps the script from tripping on `set -e` when the
    # user's Dockerfile has zero FROMs (we handle that case below).
    local n_from
    n_from=$(grep -c -E '^[[:space:]]*FROM[[:space:]]' "$user_dockerfile" || true)
    [ -z "$n_from" ] && n_from=0

    info "Stage 2/2: Synthesizing wrapper Dockerfile (rewriting final FROM, stripping CMD/ENTRYPOINT)…"
    {
        if [ "$n_from" = 0 ]; then
            # No FROM at all — treat the file as a pure overlay. Prepend
            # our base so the instructions have something to run on.
            echo "# painapple-code wrapper — user file had no FROM; prepended one."
            echo "FROM $base_tag"
            echo ""
            echo "# === begin: $user_dockerfile ==="
            cat "$user_dockerfile"
            echo "# === end: $user_dockerfile ==="
        else
            # Rewrite the Nth FROM (the last) to our base; preserve any
            # `AS <alias>` suffix in case downstream stages name-reference
            # the final stage (rare but legal).
            echo "# painapple-code wrapper — final FROM rewritten to painapple-code:base;"
            echo "# CMD/ENTRYPOINT dropped so the bridge's entrypoint stays intact."
            awk -v base="$base_tag" -v target="$n_from" '
                BEGIN { i = 0 }
                /^[[:space:]]*FROM[[:space:]]/ {
                    i++
                    if (i == target) {
                        if (match($0, /[[:space:]]+[Aa][Ss][[:space:]]+[A-Za-z0-9_.-]+[[:space:]]*$/)) {
                            print "FROM " base substr($0, RSTART, RLENGTH)
                        } else {
                            print "FROM " base
                        }
                        next
                    }
                    print
                    next
                }
                /^[[:space:]]*CMD([[:space:]]|\[)/  { next }
                /^[[:space:]]*ENTRYPOINT([[:space:]]|\[)/ { next }
                { print }
            ' "$user_dockerfile"
        fi
    } > "$tmpdir/Dockerfile"

    # Build context = the directory containing the user's Dockerfile, so
    # any `COPY src/ /app` inside their file resolves against their
    # project root. We pass -f to point at our wrapper in $tmpdir.
    local user_dockerfile_dir
    user_dockerfile_dir="$(cd "$(dirname "$user_dockerfile")" && pwd)"

    if ! R build "${build_args[@]}" -f "$tmpdir/Dockerfile" -t "$IMAGE" "$user_dockerfile_dir"; then
        err "Personalized build failed."
        err "  wrapper Dockerfile: $tmpdir/Dockerfile"
        err "  build context:      $user_dockerfile_dir"
        err "Inspect, hand-edit, and rerun the same '$RUNTIME build' if you want to iterate."
        # Leave the wrapper around for post-mortem.
        trap - EXIT
        exit 1
    fi

    ok "Built $IMAGE (personalized)"
    say "  Base:       $base_tag"
    say "  Dockerfile: $user_dockerfile"
}

# ──── Help ────────────────────────────────────────────────────────────────
cmd_help() {
    # Resolve $RUNTIME so the "Detected runtime:" footer reflects the
    # actual choice (env > legacy config > auto-detect), not just whatever
    # PATH happens to have first.
    load_config
    cat <<EOF
${C_BOLD}painapple-docker.sh${C_RESET} — image build companion for Painapple Code repo checkouts

${C_BOLD}Usage:${C_RESET}
  $0 ${C_GREEN}build${C_RESET} [--devcontainer PATH | --no-devcontainer]
       [--dockerfile PATH   | --no-dockerfile]
                           Build the container image (tag: $IMAGE_DEFAULT).
                           --devcontainer layers OCI features on top of the
                           painapple-code base (uses @devcontainers/cli);
                           --dockerfile appends your own project Dockerfile's
                           instructions on top of painapple-code:base (final
                           FROM rewritten, CMD/ENTRYPOINT stripped).
  $0 ${C_GREEN}help${C_RESET}                     This help

${C_BOLD}Everything else moved to the unified CLI${C_RESET} ${C_DIM}(pipx install painapple-code)${C_RESET}:
  painapple --in-docker                       ${C_DIM}run the bridge in a container${C_RESET}
  painapple setup NAME                        ${C_DIM}interactive setup (docker or host mode)${C_RESET}
  painapple start/stop/logs/password NAME     ${C_DIM}lifecycle + auth${C_RESET}
  painapple pull                              ${C_DIM}fetch the prebuilt image (no local build)${C_RESET}
  painapple list                              ${C_DIM}show all instances${C_RESET}

${C_BOLD}Build configuration${C_RESET} ${C_DIM}(flags > env > legacy wrapper.conf > defaults)${C_RESET}:
  IMAGE=name:tag          Image tag to build ${C_DIM}(default: $IMAGE_DEFAULT)${C_RESET}
  RUNTIME=docker|podman   Container runtime ${C_DIM}(default: auto-detect, docker first)${C_RESET}
  RUNTIME_FLAGS="..."     Extra flags injected before every runtime subcommand
                          ${C_DIM}(escape hatch — e.g. --storage-driver=vfs)${C_RESET}
  PAINAPPLE_HOME=PATH     Where the legacy wrapper.conf is looked up
  NO_COLOR=1              Disable color output

  ${C_DIM}Legacy: if $CONFIG_FILE exists, its
  IMAGE / DEVCONTAINER_PATH / DOCKERFILE_PATH / RUNTIME / RUNTIME_FLAGS keys
  are read as defaults. This script never writes that file.${C_RESET}

${C_BOLD}Detected runtime:${C_RESET} $RUNTIME${RUNTIME_FLAGS:+ ${C_DIM}(flags: $RUNTIME_FLAGS)${C_RESET}}
EOF
}

# ──── Moved commands ──────────────────────────────────────────────────────
# Run/lifecycle/config commands used to live here; they're in the unified
# `painapple` CLI now. Print a pointer and exit 2 so scripts notice.
cmd_moved() {
    err "'$1' moved to the unified CLI: painapple --in-docker · painapple setup NAME · painapple start/stop/logs/password NAME (pipx install painapple-code)"
    exit 2
}

# ──── Dispatch ────────────────────────────────────────────────────────────
case "${1:-help}" in
    build)                 shift; cmd_build "$@" ;;
    help|--help|-h)        cmd_help ;;
    setup|pull|up|start|quick|stop|down|rm|restart|reload|logs|log|shell|sh|exec|\
    claude-login|login|show-password|password|url|token|extract|export|status|ps|config)
        cmd_moved "$1"
        ;;
    *)
        err "Unknown command: ${1:-(none)}"
        say ""
        cmd_help
        exit 1
        ;;
esac
