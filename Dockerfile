# syntax=docker/dockerfile:1.7
# Fully-qualified registry path — podman has no default registry and otherwise
# prompts to pick one when ~/.config/containers/registries.conf lists multiple
# unqualified-search-registries (quay.io / ghcr.io / docker.io). Docker ignores
# the prefix, so the same Dockerfile works on both runtimes.
FROM docker.io/library/python:3.13-slim-bookworm

# OCI image metadata — surfaces on Docker Hub / GHCR as the image's title,
# description, license, and "Source" link. The CI workflow overrides
# `revision` / `created` / `version` per build via --label.
LABEL org.opencontainers.image.title="painapple-code" \
      org.opencontainers.image.description="WebSocket bridge that serves a vanilla-JS PWA for Claude Code sessions" \
      org.opencontainers.image.source="https://github.com/wrotek/painapple-code" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.vendor="wrotek"

# Disable apt's _apt sandbox user — required when building under rootless
# Docker with fuse-overlayfs (the unprivileged _apt UID can't write /tmp).
RUN echo 'APT::Sandbox::User "root";' > /etc/apt/apt.conf.d/00no-sandbox

# System deps:
#   git     — used by api_git.py and shadow_git.py
#   curl    — NodeSource bootstrap
#   tini    — clean PID 1 / signal forwarding so SIGTERM kills child claude procs
#   fd-find — fast file enumeration for /api/files/list (.gitignore-aware).
#             Debian ships the binary as `fdfind`; symlink to `fd` so
#             routes/api_files.py finds it without a fallback shim.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git tini fd-find \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# Developer tools for the in-container terminal. The bridge exposes a PTY
# the user runs commands in, so a base slim image with no editor / pager /
# search / multiplexer is painful. Adds ~80 MB. Anything bigger (compilers,
# language toolchains, language servers) belongs in a user-built derived
# image, not the base.
#
#   editors          — vim, nano
#   pagers/text      — less, jq
#   search           — ripgrep (`rg`); `fd` is already installed above
#   process/system   — htop, lsof, procps (ps/top), psmisc (killall/pstree)
#   files/inspection — tree, ncdu, file
#   network          — iproute2 (ip), iputils-ping, dnsutils (dig/nslookup),
#                      netcat-openbsd, wget, rsync, openssh-client
#   compression      — zip, unzip, xz-utils
#   shell            — zsh (default user shell), tmux, bash-completion
#   build            — make
#   misc             — git-lfs, gettext-base (envsubst)
RUN apt-get update && apt-get install -y --no-install-recommends \
        vim nano \
        less jq ripgrep \
        htop lsof procps psmisc tree ncdu file \
        iproute2 iputils-ping dnsutils netcat-openbsd wget rsync openssh-client \
        zip unzip xz-utils \
        zsh tmux bash-completion \
        make \
        git-lfs gettext-base \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 LTS. Needed by the bridge itself (the vega-lite / excalidraw
# render helpers in src/painapple_code/tools/ are node scripts) and by the
# agent CLI the entrypoint installs on first run.
#
# The agent CLI is deliberately NOT baked in here. @anthropic-ai/claude-code
# is proprietary — "© Anthropic PBC. All rights reserved" — so shipping a
# copy inside a published image would be redistribution we have no written
# grant for. docker-entrypoint.sh installs it into /data on first boot
# instead, which makes the download the user's own under their own
# agreement with Anthropic, exactly like `npm i -g` on a host. See
# THIRD_PARTY_NOTICES.md → "Agent CLIs the bridge drives".
#
# DISABLE_AUTOUPDATER keeps the CLI on the version the entrypoint pinned
# (it now lives on a writable volume, so left alone it *would* update
# itself past the 2.x ceiling), and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
# suppresses the update-check / telemetry calls that go with it.
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm cache clean --force

# Non-root user. The build-time UID/GID is only a starting point — the
# entrypoint re-stamps `app` to whoever owns the mounts and drops
# privileges, so a pulled image works on a host with any UID. Building
# with --build-arg USER_UID=$(id -u) still saves it the work.
ARG USER_UID=1000
ARG USER_GID=1000
RUN groupadd --gid ${USER_GID} app \
    && useradd --uid ${USER_UID} --gid ${USER_GID} --create-home --shell /usr/bin/zsh app

# Read by the launcher (cli/deploy/runtime.py) to decide the uid story
# before it starts anything: which uid the bridge ends up as, and whether
# this image can align itself (older tags can't — podman remaps them via
# --userns=keep-id:uid=…, docker gets a real error instead of a crash loop).
LABEL io.painapple.app-uid="${USER_UID}" \
      io.painapple.app-gid="${USER_GID}" \
      io.painapple.uid-adapt="1"

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# --chown collapses what used to be COPY + a separate `RUN chown -R app:app`
# layer that duplicated every file (~1GB rewritten just to flip metadata).
COPY --chown=app:app . /app

# Package version — setuptools-scm normally derives this from `git describe`,
# but .git is excluded from the build context (see .dockerignore), so we
# pass it in as a build arg and let setuptools-scm read it from the env.
# CI populates it from the git tag; local builds without --build-arg fall
# back to "0.0.0+docker".
ARG SCM_VERSION=0.0.0+docker
ENV SETUPTOOLS_SCM_PRETEND_VERSION_FOR_PAINAPPLE_CODE=${SCM_VERSION}

# Editable install registers the painapple_code package against /app/src so
# `python -m painapple_code` resolves correctly without setting PYTHONPATH.
RUN pip install --no-cache-dir -e .

# Mountpoints — created up-front so volume mounts inherit the right ownership.
# /workspace gets a sentinel file that the entrypoint script checks for: any
# real bind mount overlays it, so its presence means the user forgot to mount.
RUN mkdir -p /data /workspace /home/app/.claude /home/app/.config/painapple-code \
    && touch /workspace/.painapple-not-mounted \
    && chown -R app:app /data /workspace /home/app/.claude /home/app/.config

# Entrypoint guard — refuses to start if /workspace isn't bind-mounted.
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

USER app

# Install user-scoped helpers — same script a host install would run.
# Drops tools/shadow-git and tools/shadow-query into ~/.local/bin and the
# shadow-git-helper agent template into ~/.claude/agents, so users get
# `shadow-git` / `shadow-query` in the in-container terminal and the agent shows
# up inside Claude Code without a separate setup step.
RUN /app/src/painapple_code/tools/install-helpers.sh

# zsh config — the bridge spawns its PTY via $SHELL (see
# routes/api_terminal.py), so an interactive terminal opened in the web UI
# lands in zsh. Bake a couple of conveniences in.
RUN printf '%s\n' \
        'alias ll="ls -lahtr"' \
        'autoload -Uz promptinit && promptinit && prompt adam1 2>/dev/null || PROMPT="%n@%m %~ %# "' \
        'setopt HIST_IGNORE_DUPS SHARE_HISTORY' \
        'HISTFILE=~/.zsh_history HISTSIZE=10000 SAVEHIST=10000' \
        > /home/app/.zshrc

# Mirror the alias for bash too, in case a script or `docker exec` lands
# the user there explicitly.
RUN echo "alias ll='ls -lahtr'" >> /home/app/.bashrc

# Back to root for the entrypoint ONLY: it re-stamps `app` to match the
# ownership of the mounts (nothing else can — usermod/chown need root),
# then hands over via setpriv. The bridge itself always runs as `app`;
# see docker-entrypoint.sh. `docker exec` lands as root, so use
# `exec --user app` (what `painapple shell` does) for a user shell.
USER root

# PAINAPPLE_CODE_HOME relocates all bridge state (logs, shadow DB, sessions,
# uploads, presets) to /data so a single named volume covers everything.
# SHELL is read by the bridge's PTY spawn (routes/api_terminal.py) — set it
# explicitly so the web terminal opens zsh even though the bridge process
# itself wasn't started via login(1).
# PAINAPPLE_IN_CONTAINER marks "running containerized" — a build-time constant
# (the image only ever runs in a container). It's a last-resort fallback in
# bridge_paths.detect_environment(); the docker-vs-podman decision is made at
# runtime from /.dockerenv vs /run/.containerenv, NOT from this marker — a baked
# ENV can't tell the two apart since the same image runs on both engines.
# HOME must be pinned: the image's last USER is root (for the entrypoint),
# and setpriv doesn't rewrite the environment when it drops to `app` — so
# without this the bridge and the `claude` CLI it spawns would look for
# ~/.claude in /root instead of the bind-mounted /home/app/.claude.
#
# PATH picks up /data/npm-global/bin — where the entrypoint installs the
# agent CLI on first run (see docker-entrypoint.sh). Baked in ENV rather
# than only exported by the entrypoint so `docker exec` shells and the
# web terminal find `claude` too. A custom PAINAPPLE_AGENT_CLI_PREFIX is
# prepended by the entrypoint at runtime.
ENV PAINAPPLE_CODE_HOME=/data \
    PYTHONUNBUFFERED=1 \
    SHELL=/usr/bin/zsh \
    HOME=/home/app \
    PATH=/data/npm-global/bin:${PATH} \
    PAINAPPLE_IN_CONTAINER=1

EXPOSE 8765

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "-m", "painapple_code", "--host", "0.0.0.0", "--port", "8765", "--workspace", "/workspace"]
