#!/usr/bin/env bash
#
# pAInapple Code — Dev Container Feature install script.
#
# Runs as root during `devcontainer build` / Codespaces image bake. Installs:
#   - System deps Painapple Code needs at runtime (python3-venv, git, fd, rg, …)
#   - Node 20 + the `claude` CLI (only if not already present from another Feature)
#   - The Painapple Code source under /opt/painapple-code
#   - A Python venv with the server's requirements
#   - A `painapple-code-start` launcher script at /usr/local/bin
#   - (optional) a /etc/profile.d hook that auto-starts the server on shell entry
#   - (optional) the shadow-git + shadow-query + shadow-git-helper agent into the user's home
#
# Feature options come in as upper-snake-cased env vars:
#   VERSION, REPO, PORT, INSTANCENAME, ACCENT, AUTOSTART, INSTALLHELPERS

set -euo pipefail

# --- Options (with safe defaults if env wasn't set) ------------------------
VERSION="${VERSION:-main}"
REPO="${REPO:-https://github.com/wrotek/painapple-code.git}"
PORT="${PORT:-8765}"
INSTANCENAME="${INSTANCENAME:-CODESPACE}"
ACCENT="${ACCENT:-blue}"
AUTOSTART="${AUTOSTART:-true}"
INSTALLHELPERS="${INSTALLHELPERS:-true}"

INSTALL_DIR="/opt/painapple-code"
LAUNCHER="/usr/local/bin/painapple-code-start"

# --- Resolve the non-root container user ----------------------------------
# Dev Containers conventionally use `vscode`, but base images vary
# (`node`, `codespace`, `ubuntu`, etc.). Pick the first one that exists,
# fall back to the invoking user, then to root.
detect_user() {
    local candidate
    for candidate in "${_REMOTE_USER:-}" vscode codespace node ubuntu; do
        [ -n "$candidate" ] && id "$candidate" >/dev/null 2>&1 && {
            echo "$candidate"
            return
        }
    done
    # Last resort — run as root, which is fine for ephemeral codespaces.
    echo root
}

CONTAINER_USER="$(detect_user)"
CONTAINER_HOME="$(getent passwd "$CONTAINER_USER" | cut -d: -f6)"

echo "==> Installing pAInapple Code Feature"
echo "    version       = $VERSION"
echo "    repo          = $REPO"
echo "    port          = $PORT"
echo "    instance      = $INSTANCENAME"
echo "    accent        = $ACCENT"
echo "    autostart     = $AUTOSTART"
echo "    helpers       = $INSTALLHELPERS"
echo "    user          = $CONTAINER_USER ($CONTAINER_HOME)"

# --- 1. System dependencies ------------------------------------------------
# Mirror the apt sets the project's Dockerfile installs — including the
# developer-tools layer, so the in-container PTY (which the server exposes
# at /ws/terminal) feels the same as the standalone Docker image. Adds
# ~80 MB; anything bigger (compilers, language servers) is left to the
# consumer's own devcontainer.json.
#
# Disable apt's _apt sandbox user — required when building under rootless
# Docker with fuse-overlayfs (the unprivileged _apt UID can't write /tmp).
# Mirrors the same fix in painapple-code/Dockerfile.
echo 'APT::Sandbox::User "root";' > /etc/apt/apt.conf.d/00no-sandbox

export DEBIAN_FRONTEND=noninteractive
apt-get update
# Core runtime — what the server itself needs.
apt-get install -y --no-install-recommends \
    ca-certificates curl git tini fd-find \
    python3 python3-venv python3-pip \
    ripgrep less jq
# Developer tools — for the in-container terminal. See Dockerfile for the
# rationale on each group. Shell choice (fish/zsh/etc.) is left to the
# consuming devcontainer.json; we just install bash-completion + tmux as
# generally useful.
apt-get install -y --no-install-recommends \
    vim nano \
    htop lsof procps psmisc tree ncdu file \
    iproute2 iputils-ping dnsutils netcat-openbsd wget rsync openssh-client \
    zip unzip xz-utils \
    tmux bash-completion \
    make \
    git-lfs gettext-base
# Debian ships `fd` as `fdfind`; the server's api_files.py looks for `fd`.
[ -e /usr/local/bin/fd ] || ln -s /usr/bin/fdfind /usr/local/bin/fd
rm -rf /var/lib/apt/lists/*

# --- 2. Node + claude CLI --------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
    echo "==> Installing Node 20"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y --no-install-recommends nodejs
    rm -rf /var/lib/apt/lists/*
fi

if ! command -v claude >/dev/null 2>&1; then
    echo "==> Installing @anthropic-ai/claude-code"
    npm install -g @anthropic-ai/claude-code@latest
    npm cache clean --force
fi

# --- 3. Painapple Code source ---------------------------------------------
# Source resolution order:
#   1. Local checkout — script invoked from inside a painapple-code repo
#      (e.g. `sudo ./features/src/painapple-code/install.sh` while iterating
#      on the Feature, or running install.sh inside a codespace that already
#      has the repo checked out).
#   2. Bundled `painapple-source/` next to the script — populated by
#      tools/bundle-feature-source.sh for OCI-published Features. Lets the
#      Feature work for private repos and offline builds without needing a
#      GitHub token in the build context.
#   3. Existing `$INSTALL_DIR/.git` — re-run on a container that already
#      installed once; just fetch the requested $VERSION.
#   4. Fresh `git clone $REPO` — first-run default.
FEATURE_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLED_SOURCE="$FEATURE_DIR/painapple-source"
# Repo root assuming layout features/src/painapple-code/install.sh.
LOCAL_CHECKOUT="$(cd "$FEATURE_DIR/../../.." 2>/dev/null && pwd || true)"

is_painapple_checkout() {
    local dir="$1"
    [ -n "$dir" ] \
        && [ -f "$dir/pyproject.toml" ] \
        && grep -q '^name = "painapple-code"' "$dir/pyproject.toml" \
        && [ -d "$dir/src/painapple_code" ]
}

if [ "$LOCAL_CHECKOUT" != "$INSTALL_DIR" ] && is_painapple_checkout "$LOCAL_CHECKOUT"; then
    echo "==> Installing from local checkout ($LOCAL_CHECKOUT → $INSTALL_DIR)"
    rm -rf "$INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"
    # Step 4 rebuilds the venv; skip copying any local venv / node_modules /
    # caches to keep this fast.
    if command -v rsync >/dev/null 2>&1; then
        rsync -a \
            --exclude=venv --exclude=.venv \
            --exclude=node_modules \
            --exclude=__pycache__ \
            --exclude='*.pyc' \
            "$LOCAL_CHECKOUT/" "$INSTALL_DIR/"
    else
        cp -a "$LOCAL_CHECKOUT"/. "$INSTALL_DIR/"
        rm -rf "$INSTALL_DIR/venv" "$INSTALL_DIR/.venv" \
               "$INSTALL_DIR/node_modules"
    fi
elif [ -d "$BUNDLED_SOURCE" ] && [ -f "$BUNDLED_SOURCE/pyproject.toml" ]; then
    echo "==> Installing from bundled source ($BUNDLED_SOURCE → $INSTALL_DIR)"
    mkdir -p "$INSTALL_DIR"
    cp -a "$BUNDLED_SOURCE"/. "$INSTALL_DIR/"
elif [ -d "$INSTALL_DIR/.git" ]; then
    echo "==> $INSTALL_DIR already cloned; fetching $VERSION"
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$VERSION"
    git -C "$INSTALL_DIR" checkout -B "$VERSION" "origin/$VERSION" \
        || git -C "$INSTALL_DIR" checkout "$VERSION"
else
    echo "==> Cloning $REPO @ $VERSION → $INSTALL_DIR"
    # Try a shallow ref clone first (works for branches & tags); fall back to
    # a full clone + checkout if VERSION is a commit SHA (depth-1 doesn't
    # accept arbitrary commits without server-side allowReachableSHA1InWant).
    if ! git clone --depth 1 --branch "$VERSION" "$REPO" "$INSTALL_DIR" 2>/dev/null; then
        git clone "$REPO" "$INSTALL_DIR"
        git -C "$INSTALL_DIR" checkout "$VERSION"
    fi
fi

# --- 4. Python venv --------------------------------------------------------
echo "==> Setting up Python venv"
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --no-cache-dir --upgrade pip
"$INSTALL_DIR/venv/bin/pip" install --no-cache-dir -e "$INSTALL_DIR"

# --- 5. Ownership ----------------------------------------------------------
# The server's state dir (PAINAPPLE_CODE_HOME) lives under the container
# user's $HOME — set by the launcher at runtime — so we don't need a
# system-wide /var path. Two reasons:
#   1. $HOME is always writable by the user, regardless of any UID remap
#      the devcontainer CLI does (`--update-remote-user-uid-default on`).
#   2. The path matches host installs (~/.painapple-code), making
#      docs / `shadow-query` / shadow-git commands work identically in both.
chown -R "$CONTAINER_USER:$CONTAINER_USER" "$INSTALL_DIR"

# --- 6. Launcher script ----------------------------------------------------
# The Feature spec has no native "run on container start" hook. We install a
# launcher and (when AUTOSTART=true) a /etc/profile.d snippet that fires it
# on first interactive shell. Codespaces always opens a shell at startup, so
# this is effectively auto-start. Idempotent: re-running is a no-op if the
# server is already serving on $PORT.
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
# Launch the pAInapple Code server in the background.
# Generated by the painapple-code Dev Container Feature.
set -e

PORT="\${PAINAPPLE_PORT:-$PORT}"
WORKSPACE="\${PAINAPPLE_WORKSPACE:-/workspaces}"
INSTANCE="\${PAINAPPLE_INSTANCE_NAME:-$INSTANCENAME}"
ACCENT="\${PAINAPPLE_ACCENT:-$ACCENT}"
INSTALL_DIR="$INSTALL_DIR"
# In Codespaces, /workspaces is a bind mount from the VM's persistent
# disk — it's the only path that survives "Rebuild Container" (\$HOME
# gets wiped). Anchor state there so sessions / shadow DB / auth
# password all carry across rebuilds. Elsewhere (plain Docker, host
# install) fall back to the conventional ~/.painapple-code layout.
if [ -n "\${CODESPACES:-}" ] && [ -d /workspaces ]; then
    DEFAULT_STATE="/workspaces/.painapple-code"
    DEFAULT_AUTH="/workspaces/.painapple-code/auth.yaml"
else
    DEFAULT_STATE="\$HOME/.painapple-code"
    DEFAULT_AUTH="\$HOME/.config/painapple-code/config.yaml"
fi
export PAINAPPLE_CODE_HOME="\${PAINAPPLE_CODE_HOME:-\$DEFAULT_STATE}"
AUTH_CFG="\${PAINAPPLE_AUTH_CONFIG:-\$DEFAULT_AUTH}"
mkdir -p "\$PAINAPPLE_CODE_HOME" "\$PAINAPPLE_CODE_HOME/tmp" "\$(dirname "\$AUTH_CFG")"
LOG="\$PAINAPPLE_CODE_HOME/launcher.log"
PIDFILE="\$PAINAPPLE_CODE_HOME/launcher.pid"
# Point tempfile/mkdtemp/etc. at a user-writable location too — defensive
# in case install.sh's chmod on /tmp didn't take effect (BuildKit quirk).
export TMPDIR="\$PAINAPPLE_CODE_HOME/tmp"
# The server's PTY spawner (routes/api_terminal.py) reads \$SHELL; whatever
# the user's login shell is, the launcher inherits it. We don't force a
# specific shell here — that's a devcontainer.json decision.

# Print the login URL — Codespaces-flavoured when those env vars are set,
# plain localhost otherwise. Pulls the password from the YAML config the
# server writes on first start. Runs on every invocation so a second shell
# (where the server is already up) still gets the URL.
print_login_url() {
    local pw url
    # Wait up to ~3s for the config to appear on a fresh start.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        [ -f "\$AUTH_CFG" ] && break
        sleep 0.3
    done
    [ -f "\$AUTH_CFG" ] || { echo "pAInapple Code: config not written yet — tail \$LOG"; return; }
    # The api_token, not the password: ?tkn= links carry the derived,
    # separately-revocable credential. The server writes it on start.
    pw="\$(awk '/^api_token:/ {print \$2}' "\$AUTH_CFG")"
    if [ -z "\$pw" ]; then
        echo "pAInapple Code: api_token missing from \$AUTH_CFG"
        return
    fi
    if [ -n "\${CODESPACE_NAME:-}" ] && [ -n "\${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
        url="https://\${CODESPACE_NAME}-\${PORT}.\${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}/?tkn=\${pw}"
    else
        url="http://localhost:\${PORT}/?tkn=\${pw}"
    fi
    # URL and token each on their own line, no leading text — so VS Code's
    # terminal link detector picks the URL up cleanly even if the line wraps,
    # and the token is trivial to copy without selecting surrounding noise.
    echo "==> pAInapple Code is ready. Ctrl+Click the URL or paste the token:"
    echo "\$url"
    echo "token: \$pw"
}

# Already running? Skip the start, but still print the login URL.
if [ -f "\$PIDFILE" ] && kill -0 "\$(cat "\$PIDFILE")" 2>/dev/null; then
    print_login_url
    exit 0
fi

# --tls off: the server binds 0.0.0.0 inside the container, but the only
# externally-reachable hop is via the Codespaces port-forwarding proxy
# (which terminates HTTPS at *.app.github.dev) or a user-managed reverse
# proxy. Double-wrapping TLS inside the container adds a self-signed cert
# the proxy has to trust and changes the login URL scheme. Plain HTTP
# keeps print_login_url simple and matches what painapple-docker.sh does
# for loopback LISTEN_HOST.
cd "\$INSTALL_DIR"
nohup ./venv/bin/python -m painapple_code \\
    --host 0.0.0.0 \\
    --port "\$PORT" \\
    --tls off \\
    --workspace "\$WORKSPACE" \\
    --instance-name "\$INSTANCE" \\
    --accent "\$ACCENT" \\
    --auth-config-file "\$AUTH_CFG" \\
    > "\$LOG" 2>&1 &
echo \$! > "\$PIDFILE"

print_login_url
EOF
chmod 755 "$LAUNCHER"

# --- 7. Auto-start hook ----------------------------------------------------
# Two hooks because login shells differ:
#   - bash/zsh/sh read /etc/profile.d/*.sh (the default path in Codespaces)
#   - fish reads /etc/fish/conf.d/*.fish (defensive — only fires if the
#     consuming devcontainer chose fish as the user's login shell; we
#     don't make that choice here)
# Both are guarded by an env flag to prevent re-entry inside the same shell,
# and `[ -t 1 ]` / `status is-interactive` so non-interactive shells stay
# silent.
if [ "$AUTOSTART" = "true" ]; then
    cat > /etc/profile.d/painapple-code.sh <<EOF
# Auto-start the pAInapple Code server on first interactive shell.
# Generated by the painapple-code Dev Container Feature.
if [ -z "\${PAINAPPLE_AUTOSTART_DONE:-}" ] && [ -x $LAUNCHER ] && [ -t 1 ]; then
    export PAINAPPLE_AUTOSTART_DONE=1
    $LAUNCHER 2>/dev/null || true
fi
EOF
    chmod 644 /etc/profile.d/painapple-code.sh

    mkdir -p /etc/fish/conf.d
    cat > /etc/fish/conf.d/painapple-code.fish <<EOF
# Auto-start the pAInapple Code server on first interactive fish session.
# Generated by the painapple-code Dev Container Feature.
if status is-interactive
    and not set -q PAINAPPLE_AUTOSTART_DONE
    and test -x $LAUNCHER
    set -gx PAINAPPLE_AUTOSTART_DONE 1
    $LAUNCHER 2>/dev/null
    or true
end
EOF
    chmod 644 /etc/fish/conf.d/painapple-code.fish
fi

# Defensive: fish doesn't read /etc/profile or ~/.profile, so the
# Ubuntu-base default of "if ~/.local/bin exists, prepend it to PATH" never
# fires under fish. If the consuming devcontainer chshes to fish, that hides
# install-helpers.sh's shadow-git / shadow-query drops — so we put them on PATH
# system-wide for any fish user via /etc/fish/conf.d/. Harmless if fish
# is never installed.
mkdir -p /etc/fish/conf.d
cat > /etc/fish/conf.d/painapple-code-path.fish <<'EOF'
# Mirror the Ubuntu base image's bash behaviour for ~/.local/bin.
# fish_add_path is the canonical helper — idempotent, persists session-wide.
if test -d $HOME/.local/bin
    fish_add_path -gP $HOME/.local/bin
end
EOF
chmod 644 /etc/fish/conf.d/painapple-code-path.fish

# --- 8. Bash alias convenience --------------------------------------------
# Tiny QoL: Dockerfile bakes in an `ll` alias; mirror that here for the
# bash login shell that Codespaces ships by default. Shell choice itself
# (fish/zsh/etc.) is left to the consuming devcontainer.
BASHRC="$CONTAINER_HOME/.bashrc"
if [ -f "$BASHRC" ] && ! grep -q "alias ll=" "$BASHRC" 2>/dev/null; then
    echo "alias ll='ls -lahtr'" >> "$BASHRC"
    chown "$CONTAINER_USER:$CONTAINER_USER" "$BASHRC"
fi

# --- 9. Helpers (shadow-git, shadow-query, agent template) -------------------------
if [ "$INSTALLHELPERS" = "true" ] && [ -x "$INSTALL_DIR/tools/install-helpers.sh" ]; then
    echo "==> Installing helpers as $CONTAINER_USER"
    # install-helpers.sh is user-scoped (writes to ~/.local/bin and ~/.claude),
    # so it must run as the container user, not root. Use `runuser` not `su -`
    # because `su -` loads /etc/profile.d/*.sh — and our own profile.d hook
    # would then auto-start the server during the image build, baking the
    # PID/log files into the image with the wrong ownership.
    if [ "$CONTAINER_USER" = "root" ]; then
        "$INSTALL_DIR/tools/install-helpers.sh" || true
    elif command -v runuser >/dev/null 2>&1; then
        runuser -u "$CONTAINER_USER" -- "$INSTALL_DIR/tools/install-helpers.sh" || true
    else
        # `su` without `-` skips the login-shell profile.d processing.
        su "$CONTAINER_USER" -c "$INSTALL_DIR/tools/install-helpers.sh" || true
    fi
fi

# Belt-and-braces — clear any launcher state that snuck in during the
# image build (e.g., from a sub-script that loaded /etc/profile.d/*),
# so a stale PIDFILE doesn't make `painapple-code-start` think the
# server is already up on the first real container start. The
# user-home path is the canonical one; the /tmp legacy is from an
# earlier draft of this Feature.
home="$(getent passwd "$CONTAINER_USER" | cut -d: -f6)"
rm -f "$home/.painapple-code/launcher.log" "$home/.painapple-code/launcher.pid" \
      /tmp/painapple-code.log /tmp/painapple-code.pid

# Restore /tmp and /var/tmp to the standard 1777 (sticky world-writable).
# The devcontainer CLI's `RUN --mount=type=bind` step leaves /tmp at mode
# 1755 root-owned in some configurations (BuildKit overlay cleanup quirk),
# which breaks any non-root process that uses Python's tempfile, mktemp,
# editor swapfiles, etc. Run last so the chmod isn't undone by a
# subsequent mount in this same RUN layer.
chmod 1777 /tmp /var/tmp 2>/dev/null || true

echo "==> pAInapple Code Feature install complete."
echo "    Source:    $INSTALL_DIR"
echo "    State:     \$PAINAPPLE_CODE_HOME (created by the launcher at run time)"
echo "    Launcher:  $LAUNCHER"
echo "    Port:      $PORT (forward in devcontainer.json to expose)"
