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
 the bridge can read and edit files.

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
    # to reconcile, a read-only mount) must not stop the bridge starting.
    # The user loses the seeded agent, not the server.
    mkdir -p /home/app/.claude/agents 2>/dev/null || true
    cp "$agent_src" "$agent_dst" 2>/dev/null || true
    if [ -n "$1" ]; then
        chown "$1" "$agent_dst" 2>/dev/null || true
    fi
    return 0
}

# ── Align the container user with whoever owns the mounts ───────────────
#
# The image bakes `app` at a fixed UID (1000 unless built with
# --build-arg USER_UID). Everything the bridge is mounted FOR is owned by
# the HOST user: the workspace it edits, ~/.claude, the bridge config
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
# The bridge NEVER runs as root: the root branch always ends in setpriv.
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
    # Aligning to it would just run the bridge as nobody, which can't
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

    # /data and the bridge config dir are usually named volumes, which
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
    exec setpriv --reuid="$want_uid" --regid="$want_gid" --init-groups "$@"
fi

seed_agent
exec "$@"
