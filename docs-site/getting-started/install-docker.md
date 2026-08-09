# Install with Docker / Podman

The recommended way to run pAInapple Code is in a container — it gives you the isolation the [security notes](security.md) call for, and the image bundles everything it needs.

The image ships Python 3.13, Node 20, `git`, and a baseline dev toolkit (ripgrep, fd, jq, tmux, vim, and more). The agent CLIs — `@anthropic-ai/claude-code` and `@openai/codex` — are **not** baked into the image; the entrypoint installs them from npm into the `/data` volume on first start, so the download happens under your own agreement with the vendor. That costs a few seconds once and needs npm-registry access on that first boot; see [Agent CLIs](#agent-clis) below to change or skip it. Application state persists in named volumes; your project and an isolated Claude CLI home are bind-mounted from the host. The Dockerfile is OCI-compliant, so it works with Docker, Podman, nerdctl, or any other OCI runtime.

## Option A — built-in container mode (pipx, no clone needed)

Docker is a **run mode** of the unified `painapple` CLI — no separate command group. Two shapes:

```bash
pipx install painapple-code
# The image is pulled automatically on the first containerized run.
# `painapple pull` re-fetches wrotek/painapple-code:latest and prints the
# version it landed on. `painapple pull rc` tracks the newest pre-release;
# `painapple pull v1.0.0` pins an exact one.

# Ad-hoc: sandbox the current directory, foreground, Ctrl-C stops
cd ~/code/my-project
painapple --in-docker

# Durable: a named docker-mode profile
painapple setup myapp      # interactive TUI wizard — pick "Docker" as the run mode
painapple start myapp      # detached (--restart unless-stopped), prints the login URL
```

The wizard has arrow-key menus, a browsable directory picker (type to filter, ++left++ / ++right++ to climb or enter folders), back navigation on every step, and a final review screen that jumps back into any section. It configures an **isolated `.claude` home** by default — the container doesn't share state with your host CLI — and offers to seed it from your host login once.

Manage a sandbox with the same verbs as any deployment: `stop`, `restart`, `status`, `logs`, `password` (reveal the login URL), plus the docker-only `shell`, `claude-login`, `extract`, and the scripted `painapple profile get/set`. Full reference: [Profiles & container mode](../reference/profiles.md).

Named profiles are selected by name (`painapple password myapp`). The **ad-hoc** run has no name, so it takes the mode flag instead — `painapple password --in-docker`, `painapple logs --in-docker` — otherwise those verbs would report on your *host* deployment. The container's login page shows the exact command for its own deployment.

Docker and Podman are auto-detected (pick one — or a custom binary path — in `painapple setup`). Container mode is **pull-only**: building the image from source needs a repo checkout (Option C below).

## Option B — raw `docker run` (one-liner, no clone needed)

```bash
docker run -d --name painapple-code \
    -p 127.0.0.1:8765:8765 \
    -v "$PWD:/workspace" \
    -v "$HOME/.painapple-code/.claude:/home/app/.claude" \
    -v painapple-data:/data \
    wrotek/painapple-code:latest
docker logs painapple-code 2>&1 | grep -E 'http(s)?://' | head -1   # bootstrap URL
```

**Image tags:**

| Tag | Meaning |
|-----|---------|
| `:latest` | Newest stable release |
| `:vX.Y.Z` | Pinned to a specific release |
| `:edge` | Manual builds off `main` |

!!! note "Published image and UIDs (Linux)"
    The published image bakes in `USER_UID=1000`, but it doesn't have to stay there: started through `painapple` (or with `PAINAPPLE_UID`/`PAINAPPLE_GID` set), the entrypoint re-stamps its `app` user to whoever owns your mounts and drops privileges before the bridge starts, and Podman gets the host user remapped straight onto that UID. So a pulled image works on any host UID without a rebuild. Building locally (Option C) skips the step entirely by baking your own UID in.

## Option C — build from source with `painapple-docker.sh` (clone the repo)

The Bash wrapper is the **build companion** — local image builds, including personalized builds layered from your own `devcontainer.json` or Dockerfile. Running and managing the container is Option A's job (the unified CLI picks the locally-built image up automatically — it uses the same `painapple-code:latest` tag).

```bash
git clone https://github.com/wrotek/painapple-code.git
cd painapple-code
./painapple-docker.sh build     # build the image locally (~2-3 min, once)
painapple --in-docker           # then run it like any other sandbox
```

The wrapper auto-detects the OCI runtime (force with `RUNTIME=docker` / `RUNTIME=podman`) and passes your `USER_UID`/`USER_GID` build args automatically so bind mounts stay writable. The runtime side of the CLI auto-applies the Podman-specific flags (`--userns=keep-id`, SELinux `:Z`).

To layer your own tooling on top of the base image:

```bash
# Layer Dev Container Features from a devcontainer.json
./painapple-docker.sh build --devcontainer ~/my-project/.devcontainer

# Or append your project's existing Dockerfile
./painapple-docker.sh build --dockerfile ~/my-project/Dockerfile
```

Open `http://localhost:8765/` in a browser. The first run logs a bootstrap URL with the auth password embedded as `?tkn=…` — open that link once and the cookie keeps you logged in. See [First run & login](first-run.md).

## Manual Compose / Podman (no wrapper)

=== "Docker Compose"

    ```bash
    docker compose build --build-arg USER_UID=$(id -u) --build-arg USER_GID=$(id -g)
    WORKSPACE=/absolute/path/to/your/project docker compose up
    ```

    The `WORKSPACE` env var is **required** — compose refuses to start without it. For convenience, drop it into a `.env` file next to `docker-compose.yml`:

    ```bash
    # .env
    WORKSPACE=/Users/me/code/some-repo
    BRIDGE_PORT=18765   # optional: custom host port
    ```

    By default the compose file mounts `~/.painapple-code/claude-home/` as the container's `.claude`. To seed it with your existing login:

    ```bash
    mkdir -p ~/.painapple-code/claude-home
    cp ~/.claude/.credentials.json ~/.painapple-code/claude-home/
    ```

=== "Podman"

    Podman is daemonless, rootless-by-default, and CLI-compatible with Docker:

    ```bash
    podman build --build-arg USER_UID=$(id -u) -t painapple-code:latest .
    podman run --rm -it --userns=keep-id \
        -p 8765:8765 \
        -v painapple-data:/data \
        -v "$HOME/.painapple-code/claude-home:/home/app/.claude:Z" \
        -v "/absolute/path/to/your/project:/workspace:Z" \
        painapple-code:latest
    ```

    Podman-specific flags:

    - **`--userns=keep-id`** — maps your host UID directly into the container. Without it, rootless Podman remaps UIDs through `/etc/subuid` and bind-mounted files appear as `nobody`. Note that plain `keep-id` maps your host user to its *own* id, which still isn't the image's `app` user — so unless your host UID is 1000 (or you built with `--build-arg USER_UID=$(id -u)`, as above), use `--userns=keep-id:uid=1000,gid=1000` to land *on* `app` instead. `painapple start` works this out for you.
    - **`:Z` mount suffix** — applies a private SELinux label so the container can read/write the bind mount. Required on Fedora/RHEL/CentOS/Rocky; a harmless no-op on Debian/Ubuntu/Arch. Use `:z` (lowercase) if the same volume is shared between containers.

## Volumes

| Mount target in container | Purpose |
|---------------------------|---------|
| `/data` | Bridge state (sessions, shadow DB, logs, presets, uploads) via `PAINAPPLE_CODE_HOME=/data`. Back up this one volume to back up everything. |
| `/home/app/.config/painapple-code` | Auth config — the generated password. Persist it so stop/start keeps the same login. |
| `/home/app/.claude` | Container-local Claude CLI state (OAuth, history). Defaults to an isolated host path so the container never writes into your host's `~/.claude`. Mount `$HOME/.claude` instead to share state with your host CLI, or drop the mount and set `ANTHROPIC_API_KEY` for headless deploys. |
| `/workspace` | **Required.** Your project directory — where Claude reads and edits files. Mount a single repo or a parent directory of many. |

!!! warning "The workspace mount is mandatory"
    The entrypoint checks that a real host directory is mounted at `/workspace` and exits with a configuration error (exit code 78) if it isn't. Compose refuses to start with `WORKSPACE` unset. This catches the common "I forgot to mount my project" mistake.

## Agent CLIs

The image deliberately ships **no** agent CLI. `@anthropic-ai/claude-code` is proprietary — its licence reads "© Anthropic PBC. All rights reserved" — and nothing in Anthropic's terms grants the right to redistribute it inside a published image. So the entrypoint installs it on first boot instead, which makes the download yours under your own agreement with Anthropic, exactly as `npm i -g` on your laptop would be. `@openai/codex` is Apache-2.0 and could legally have been baked in; it takes the same path so there's one mechanism rather than two.

They land in `/data/npm-global`, on the persistent volume, owned by the unprivileged `app` user — so only the very first start pays for it. This also means **pulling a newer image no longer updates the CLIs**; to upgrade one, run `npm install -g --prefix /data/npm-global @anthropic-ai/claude-code@2` from the container's terminal.

| Variable | Effect |
|---|---|
| `PAINAPPLE_SKIP_AGENT_CLI=1` | Install nothing — for a UI/terminal-only instance, or when you bring your own. |
| `PAINAPPLE_AGENT_CLIS` | Override the set: space-separated `binary=npm-spec` pairs. Default `claude=@anthropic-ai/claude-code@2 codex=@openai/codex@latest`. Drop one to skip it, or pin an exact version. |
| `PAINAPPLE_AGENT_CLI_PREFIX` | Install location. Default `/data/npm-global`. |

A CLI already on `PATH` is left alone, checked per binary — so a baked-in `claude` doesn't suppress the `codex` install. A failed install is **not** fatal: the bridge still starts and serves the UI, terminal, git panel and history; only prompting that engine fails, with an explanation in the container log.

!!! tip "Air-gapped hosts"
    Bake the CLIs into a derived image — the already-on-`PATH` check then leaves them alone:

    ```dockerfile
    FROM wrotek/painapple-code
    RUN npm install -g @anthropic-ai/claude-code@2 @openai/codex@latest
    ```

    Don't end a derived image with `USER app`: the entrypoint needs root to align UIDs before it drops privileges.

## Authenticating the in-container Claude CLI

The `claude` subprocess inside the container needs to authenticate to Anthropic. Three paths:

1. **Isolated `.claude` home (default)** — seed it once with `cp ~/.claude/.credentials.json <claude-home>/` (the setup wizard offers this), or run `painapple claude-login [NAME]` to log in inside the container.
2. **Share the host's `~/.claude`** — mount it directly. Easiest, but the container can mutate your host state.
3. **API key** — set `ANTHROPIC_API_KEY` and remove the `.claude` mount. Cleanest for headless servers and CI.

## Next step

Continue to [First run & login](first-run.md) to get the bootstrap URL and open your first session.
