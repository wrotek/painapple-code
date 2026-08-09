# pAInapple Code

A self-hosted web UI for [Claude Code](https://github.com/anthropics/claude-code) sessions — a Python server that runs the CLI as a subprocess and serves a vanilla-JS PWA on top. Inspired by [code-server](https://github.com/coder/code-server).

The image bundles Python 3.13, Node 20, and `@anthropic-ai/claude-code`. Multi-arch (`linux/amd64`, `linux/arm64`).

> **GitHub repo:** <https://github.com/wrotek/painapple-code> — full docs, source, issues, screenshots.

---

## ⚠️ Read this before you run it

**pAInapple Code effectively gives whoever holds its password a remote shell on the host.** Claude Code can execute commands, edit files, and reach the network on the user that started the container. The built-in auth is a single-password gate — useful, but not a substitute for proper network controls.

- The default `docker run` example below binds **`127.0.0.1:8765`**. Don't change that to `0.0.0.0` (or a public IP) without putting a reverse proxy with TLS and ideally a VPN / Tailscale / SSH-tunnel layer in front.
- The first run logs a bootstrap URL with the auth password embedded as `?tkn=…`. Capture it from `docker logs` and open it once — the cookie keeps you logged in afterwards.
- The terminal widget is a real PTY running as the container user. In `YOLO` permission mode anyone with the password can run arbitrary commands.

**Claude CLI bundling.** This image bundles `@anthropic-ai/claude-code` (proprietary, © Anthropic PBC, all rights reserved) and Node.js so the server can spawn `claude` as a subprocess. By using the image you accept [Anthropic's Commercial Terms](https://www.anthropic.com/legal/commercial-terms) and must supply your own credentials (`ANTHROPIC_API_KEY` env var, or an OAuth login persisted via the `~/.claude` volume).

---

## Quick start

```bash
docker run -d --name painapple-code \
    -p 127.0.0.1:8765:8765 \
    -v "$PWD:/workspace" \
    -v "$HOME/.painapple-code/.claude:/home/app/.claude" \
    -v painapple-data:/data \
    wrotek/painapple-code:latest

# Capture the bootstrap URL (contains the auto-generated password)
docker logs painapple-code 2>&1 | grep -E 'http(s)?://' | head -1
```

Open the printed URL in any modern browser. The auth cookie persists across reloads.

To seed the bundled CLI with an existing Anthropic OAuth login, copy your host credentials in before first start:

```bash
mkdir -p ~/.painapple-code/.claude
cp ~/.claude/.credentials.json ~/.painapple-code/.claude/
```

Or pass an API key instead of OAuth:

```bash
docker run -d ... -e ANTHROPIC_API_KEY=sk-ant-... wrotek/painapple-code:latest
```

## Prefer a guided setup?

The pip package manages this image for you — docker is a built-in run mode of the unified `painapple` CLI: an interactive setup wizard (workspace, credentials, network/TLS), pull, lifecycle, logs, and password reveal. Docker and Podman are auto-detected:

```bash
pipx install painapple-code
painapple --in-docker       # sandbox the current directory (image auto-pulled on first run)

painapple setup myapp       # or a durable named sandbox (pick "Docker" in the wizard)
painapple start myapp       # detached, --restart unless-stopped
painapple password myapp    # show the login URL + password
```

Everything below works without it — the CLI just generates the same `docker run` for you and remembers your answers in `~/.painapple-code/profiles/NAME/profile.yaml`.

## docker-compose

```yaml
services:
    painapple:
        image: wrotek/painapple-code:latest
        init: true
        restart: unless-stopped
        ports: ["127.0.0.1:8765:8765"]
        environment:
            ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
        volumes:
            - painapple-data:/data
            - painapple-config:/home/app/.config/painapple-code
            - ${HOME}/.painapple-code/.claude:/home/app/.claude
            - ${WORKSPACE:?set WORKSPACE to your project dir}:/workspace
volumes:
    painapple-data: {}
    painapple-config: {}
```

## Tags

| Tag | When |
|---|---|
| `vX.Y.Z` | Pinned to a specific release. Recommended for production. |
| `latest` | Newest stable SemVer release. Pre-releases (`-rc1`, `-beta`) do **not** move `latest`. |
| `edge` | Manual builds off `main`. May be broken. Do not use in production. |

SemVer tags are **immutable** — once `v0.1.0` is published it will not be re-pushed. If a release has a bug, the next patch (`v0.1.1`) ships the fix.

For the strongest guarantee, pin by digest: `wrotek/painapple-code@sha256:…`.

## Volumes

| Path | Purpose | Required? |
|---|---|---|
| `/workspace` | The project directory Claude operates on. Bind-mount your repo here. | **Yes** — the entrypoint refuses to start without it. |
| `/data` | All application state (sessions, logs, Shadow Git, DuckDB, uploads). Use a named volume. | Recommended |
| `/home/app/.claude` | Claude CLI state (OAuth login, settings). Bind-mount from host to reuse your login. | Optional |
| `/home/app/.config/painapple-code` | Auth config file (`config.yaml` with the login password). | Recommended — survives data wipes |

## Environment variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key (alternative to OAuth via `~/.claude` mount). |
| `PAINAPPLE_CODE_HOME` | Override the state directory. Defaults to `/data` in the image. |
| `BRIDGE_ALLOWED_ORIGINS` | Comma-separated extra trusted browser origins (CSRF/Origin gate + CORS). Rarely needed — same-origin traffic (any proxied hostname or LAN IP) is accepted automatically; set this only for a genuinely cross-origin front-end. |
| `DISABLE_AUTOUPDATER` | Pre-set to `1` — the bundled Claude CLI won't try to overwrite itself inside the immutable image layer. |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Pre-set to `1` — suppresses CLI update-check / telemetry calls. |

## Ports

| Port | Protocol | Purpose |
|---|---|---|
| `8765` | HTTP + WebSocket | Bridge UI and API. The image listens on `0.0.0.0:8765` inside the container; the host port mapping is what gates network exposure. |

## Authentication

Every HTTP and WebSocket request needs a password. The server generates one on first start, stores it in `~/.config/painapple-code/config.yaml` (inside the container that's under `/home/app/`; mode 0600 either way), and logs a bootstrap URL with the token embedded as `?tkn=…` — open it once, the cookie does the rest.

```bash
# Reveal the password — prints ready-to-open login URLs
painapple password                # add a profile name for named deployments
# …or read the config file directly
awk '/^password:/ {print $2}' ~/.config/painapple-code/config.yaml
# …or in a container not managed by the CLI
docker exec painapple-code awk '/^password:/ {print $2}' \
    /home/app/.config/painapple-code/config.yaml

# Rotate: delete the config, restart, and a new password is generated
rm ~/.config/painapple-code/config.yaml   # then restart the server
# …or when running in a container
docker exec painapple-code rm /home/app/.config/painapple-code/config.yaml \
    && docker restart painapple-code
```

Three auth paths: the `bridge_auth` cookie (set automatically after first login), `?tkn=<password>` in any URL, or `Authorization: Bearer <password>` for `curl` and scripts.

## Architectures

| Platform | Status |
|---|---|
| `linux/amd64` | Native build, smoke-tested in CI |
| `linux/arm64` | Native build (Apple Silicon, Raspberry Pi 4/5, AWS Graviton) |

Verify the platform after pull:

```bash
docker buildx imagetools inspect wrotek/painapple-code:latest
```

## What it is, and what it isn't

**It is** a thin wrapper around Claude Code — every prompt streams through the official CLI/Agent SDK, and any session started here can be resumed in the plain CLI with `claude --resume <id>`. It never modifies Claude's system prompt, tool policy, or behavior — no injected planning steps, no hidden instructions. What it does add to a prompt is the context you attached: the output of `!bang` commands you ran, paths of files you uploaded, and snippets from the comments stash are prepended as plain text. The same wrapper can drive the [OpenAI Codex CLI](https://painapple.ai/guides/engines/), selected per session, resumable with `codex exec resume <id>` — the Codex path is newer and has had less testing than the Claude path.

**It is not** a hosted service. You run it, on your hardware, with your own Claude account.

**It is not zero-config "code from anywhere".** The client works as a PWA on a phone or iPad, but the networking between them is yours to wire up. The practical path: keep the default `127.0.0.1` bind and add a reverse proxy (Caddy, nginx) or a VPN for remote access — mobile browsers handle self-signed certificates poorly.

## Highlighted features

Full list on [GitHub](https://github.com/wrotek/painapple-code):

- **Shadow Git auto-journal** — after each turn, a Haiku background fork summarizes the work and commits all file changes to a per-project shadow git repo. Queryable via DuckDB.
- **Multi-session tabs**, real PTY terminal, cost analytics, prompt history search, comments stash, discussion threads.
- **PWA** — installable on iPad / Android / desktop, offline fallback.
- **Permission modes** per session: `Plan` (read-only), `Accept-Edits`, `Don't Ask`, `Auto` (Claude's AI classifier), `YOLO`.

## Source & support

- **Source:** <https://github.com/wrotek/painapple-code>
- **Issues:** <https://github.com/wrotek/painapple-code/issues>
- **License:** [AGPL-3.0-or-later](https://github.com/wrotek/painapple-code/blob/main/LICENSE)
- **Author:** Michal Booth-Wrotkowski

This is an MVP. Run it in a sandbox (container, VM, LXC, BSD jail). Do not expose it to the public internet without a reverse proxy with TLS, and ideally a VPN layer.
