#!/bin/sh
# Fail loudly if /workspace wasn't populated from the host.
#
# At image-build time a sentinel file is dropped at /workspace/.painapple-not-mounted.
# Two valid mount patterns clear the failure:
#   1. -v /host/dir:/workspace                          → sentinel hidden by overlay
#   2. -v /host/dir:/workspace/subdir                   → sentinel still visible,
#                                                         but /workspace has other entries
# Failure means the user mounted nothing — the only entry is the sentinel itself.
set -e

contents=$(ls -A /workspace 2>/dev/null | grep -v '^\.painapple-not-mounted$' || true)
if [ -z "$contents" ]; then
    cat <<'EOF' >&2

═══════════════════════════════════════════════════════════════════════
 ERROR: /workspace is not bind-mounted from the host.

 Painapple Code needs your project directory mounted at /workspace so
 the server can read and edit files.

 docker run:
   docker run ... -v "/absolute/path/to/your/project:/workspace" painapple-code

 docker compose / podman compose:
   WORKSPACE=/absolute/path/to/your/project docker compose up

 podman run:
   podman run ... --userns=keep-id \
     -v "/absolute/path/to/your/project:/workspace:Z" painapple-code

═══════════════════════════════════════════════════════════════════════
EOF
    exit 78  # EX_CONFIG: configuration error
fi

# Seed the shadow-git-helper agent template into ~/.claude/agents/ on first
# run. The Dockerfile already installs it at build time, but ~/.claude is
# bind-mounted from the host so the build-layer copy gets overlaid. Only
# copy when missing — user-managed agent files in the host directory are
# left alone.
#
# $1, when given, is the uid:gid to hand the copy to — the bind mount is
# the user's own ~/.claude, so a root-created file there would be a
# root-owned turd in their home directory.
seed_agent() {
    agent_src=/app/src/painapple_code/tools/agents/shadow-git-helper.md
    agent_dst=/home/app/.claude/agents/shadow-git-helper.md
    [ -f "$agent_src" ] && [ ! -f "$agent_dst" ] || return 0
    # Best-effort: a host bind-mount we can't write (ownership we failed
    # to reconcile, a read-only mount) must not stop the server starting.
    # The user loses the seeded agent, not the server.
    mkdir -p /home/app/.claude/agents 2>/dev/null || true
    cp "$agent_src" "$agent_dst" 2>/dev/null || true
    if [ -n "$1" ]; then
        chown "$1" "$agent_dst" 2>/dev/null || true
    fi
    return 0
}

# ── Agent CLIs, installed on first run ──────────────────────────────────
#
# The image ships WITHOUT the agent CLIs on purpose.
# @anthropic-ai/claude-code is proprietary software — "© Anthropic PBC.
# All rights reserved", use governed by Anthropic's Commercial/Consumer
# terms — so baking a copy into a published image is redistribution, and
# nothing in those terms grants it. Pulling it here instead makes the
# download the user's own, under their own agreement with Anthropic,
# exactly as `npm i -g` on a host would be.
#
# @openai/codex is Apache-2.0, so THAT one we could legally ship. It goes
# through the same path anyway: one mechanism beats two, and both engines
# then upgrade the same way without a rebuild.
#
# They install into $AGENT_CLI_PREFIX, which lives on the /data volume, so
# only the very first boot pays for it — restarts and image upgrades find
# them already there. Ways to opt out, in the order they're checked:
#
#   PAINAPPLE_SKIP_AGENT_CLI=1   — install nothing (bring your own, or run
#                                  a UI/terminal-only instance)
#   the binary is already on PATH — a derived image that baked one in, or a
#                                  bind-mounted install. Air-gapped hosts
#                                  want this. Checked per CLI, so a baked
#                                  `claude` doesn't suppress `codex`.
#   PAINAPPLE_AGENT_CLIS=<list>  — override the set entirely, as
#                                  space-separated `binary=npm-spec` pairs.
#                                  Drop one to skip it; pin a version; add
#                                  your own.
#
# Version pins differ because the projects do: claude-code is on a stable
# 2.x, so `@2` is a real breaking-change ceiling. codex is pre-1.0, where
# SemVer puts breaking changes in the minor — `@0` would buy nothing, so
# it tracks latest and you pin explicitly via PAINAPPLE_AGENT_CLIS if you
# need reproducibility.
#
# Failure here is NOT fatal. No network, a down registry, a read-only
# /data: the server still starts and still serves the UI, terminal, git
# panel and history. Only sending a prompt to that engine breaks, and it
# says so. Dying on boot instead would turn a degraded instance into no
# instance.
AGENT_CLIS=${PAINAPPLE_AGENT_CLIS:-"claude=@anthropic-ai/claude-code@2 codex=@openai/codex@latest"}
AGENT_CLI_PREFIX=${PAINAPPLE_AGENT_CLI_PREFIX:-/data/npm-global}
PATH="$AGENT_CLI_PREFIX/bin:$PATH"
export PATH

# Set per branch below (empty when we're already unprivileged). Initialized
# here so the function is never at the mercy of its call site.
RUNAS=''

# $RUNAS, when set, is the "setpriv …" prefix that runs npm as the target
# user — a root-owned tree under /data would be unwritable by the server
# on the next upgrade. Deliberately unquoted so it word-splits into argv;
# the values are numeric ids, so there's nothing to quote around.
#
# $1, when given, is the uid:gid the prefix dir should belong to.
install_agent_clis() {
    [ "${PAINAPPLE_SKIP_AGENT_CLI:-0}" = "1" ] && return 0

    # Resolve the whole set first, then install what's missing in ONE npm
    # call: first boot is a user staring at a container that isn't serving
    # yet, and two sequential installs are two registry sessions.
    specs=''
    names=''
    for entry in $AGENT_CLIS; do
        # Both MUST stay quoted. dash mis-parses the unquoted form of a
        # ${var#pattern} whose pattern contains `=` inside an assignment
        # word, and hands back the string unstripped — so `spec` would come
        # out as the whole `claude=@anthropic-ai/claude-code@2` pair and npm
        # would be asked to install a package literally named "claude=...".
        # bash strips it correctly either way, which is what makes this the
        # kind of thing that only shows up in the container.
        bin="${entry%%=*}"
        spec="${entry#*=}"
        [ -x "$AGENT_CLI_PREFIX/bin/$bin" ] && continue
        command -v "$bin" >/dev/null 2>&1 && continue
        specs="$specs $spec"
        names="$names $bin"
    done
    [ -z "$specs" ] && return 0

    echo "painapple: installing$names into $AGENT_CLI_PREFIX (first run, one time)…" >&2
    mkdir -p "$AGENT_CLI_PREFIX" 2>/dev/null || true
    [ -n "$1" ] && chown "$1" "$AGENT_CLI_PREFIX" 2>/dev/null

    # --no-fund/--no-audit: nothing here is actionable in a container boot
    # log, and audit adds a second registry round-trip to first start.
    if $RUNAS npm install -g --prefix "$AGENT_CLI_PREFIX" \
            --no-fund --no-audit $specs >&2; then
        for bin in $names; do
            echo "painapple: $bin ready ($("$AGENT_CLI_PREFIX/bin/$bin" --version 2>/dev/null || echo 'version unknown'))" >&2
        done
    else
        cat <<EOF >&2

painapple: could not install$names.

  The server will start, but sending a prompt to those engines will fail
  until their binaries are on PATH. This is usually no network access
  from the container, or a read-only /data.

  Fix it from the container's own terminal:
    npm install -g --prefix $AGENT_CLI_PREFIX$specs

  Or bake them into a derived image (air-gapped hosts):
    FROM wrotek/painapple-code
    RUN npm install -g$specs

  Or set PAINAPPLE_SKIP_AGENT_CLI=1 to stop trying.

EOF
    fi
    return 0
}

# ── Align the container user with whoever owns the mounts ───────────────
#
# The image bakes `app` at a fixed UID (1000 unless built with
# --build-arg USER_UID). Everything the server is mounted FOR is owned by
# the HOST user: the workspace it edits, ~/.claude, the server config
# dir, and /data itself when a host profile rides along as a bind. So on
# any host whose UID isn't the baked one, the container can't write a
# single one of them — it dies on boot with
# `PermissionError: /data/logs/server.log`, or (with /data on a named
# volume) starts fine and then silently can't edit your project.
#
# When we start as root we can just fix it: re-stamp `app` to the host's
# ids, chown what the image owns, drop privileges. When we start as
# non-root there's nothing to do and nothing we could do — either the
# ids already match, podman's `--userns=keep-id:uid=…` already landed
# the host user on `app`, or an explicit --user was passed. Either way,
# exec straight through.
#
# The server NEVER runs as root: the root branch always ends in setpriv.
if [ "$(id -u)" = "0" ]; then
    app_uid=$(id -u app 2>/dev/null || echo 1000)
    app_gid=$(id -g app 2>/dev/null || echo 1000)

    # The launcher tells us outright; a hand-rolled `docker run` doesn't,
    # so fall back to whoever owns the first thing mounted under
    # /workspace (the bind itself in parent mode, the project dir in
    # project/multi mode — /workspace is an image dir in the latter, so
    # statting it directly would just read back the baked UID).
    first_ws=$(echo "$contents" | head -1)
    want_uid=${PAINAPPLE_UID:-$(stat -c %u "/workspace/$first_ws" 2>/dev/null)}
    want_gid=${PAINAPPLE_GID:-$(stat -c %g "/workspace/$first_ws" 2>/dev/null)}

    # Unreadable, non-numeric, root, or 65534 → no usable answer, leave
    # `app` alone. 65534 is the kernel's overflow id: what an owner that
    # ISN'T mapped into this user namespace reads back as (rootless
    # podman without --userns=keep-id shows every host file as `nobody`).
    # Aligning to it would just run the server as nobody, which can't
    # write those files either.
    case "$want_uid" in ''|*[!0-9]*|0|65534) want_uid=$app_uid ;; esac
    case "$want_gid" in ''|*[!0-9]*|0|65534) want_gid=$app_gid ;; esac

    if [ "$want_uid" != "$app_uid" ] || [ "$want_gid" != "$app_gid" ]; then
        echo "painapple: aligning user app → ${want_uid}:${want_gid} (host ownership)" >&2
        # -o: the host id may already belong to a system account in the
        # image; the collision is harmless and refusing to start is not.
        if [ "$want_gid" != "$app_gid" ]; then
            groupmod -o -g "$want_gid" app
        fi
        if [ "$want_uid" != "$app_uid" ]; then
            usermod -o -u "$want_uid" -g "$want_gid" app
        fi
        # -xdev keeps this inside the image layer: ~/.claude and
        # ~/.claude.json are separate mounts owned by the host user
        # already, and rewriting a bind mount's ownership is not ours to do.
        find /home/app -xdev -exec chown -h "$want_uid:$want_gid" {} + 2>/dev/null || true
    fi

    # /data and the server config dir are usually named volumes, which
    # keep the ownership of whichever container populated them — a
    # rebuilt/pulled image with a different UID inherits a data home it
    # can't write.
    #
    # Testing the top-level dir is NOT enough: a volume seeded from the
    # image has /data owned by `app` while everything a previous
    # container wrote under it (/data/logs/server.log, the classic) is
    # owned by that container's uid instead. `-print -quit` stops at the
    # first offender, so this is one cheap walk when there's nothing to
    # fix and returns immediately when there is — either way we only
    # pay for `chown -R` over a populated data home when it's warranted.
    for d in /data /home/app/.config/painapple-code; do
        [ -d "$d" ] || continue
        if [ -n "$(find "$d" \( ! -uid "$want_uid" -o ! -gid "$want_gid" \) \
                        -print -quit 2>/dev/null)" ]; then
            echo "painapple: taking ownership of $d for ${want_uid}:${want_gid}" >&2
            chown -R "$want_uid:$want_gid" "$d" 2>/dev/null || true
        fi
    done

    seed_agent "$want_uid:$want_gid"

    # npm runs as the unprivileged user, not as root — /data is the
    # server's own volume and it has to be able to upgrade the CLIs later.
    RUNAS="setpriv --reuid=$want_uid --regid=$want_gid --init-groups"
    install_agent_clis "$want_uid:$want_gid"

    exec setpriv --reuid="$want_uid" --regid="$want_gid" --init-groups "$@"
fi

seed_agent
RUNAS=''
install_agent_clis
exec "$@"
