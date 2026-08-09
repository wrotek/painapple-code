# Server CLI & environment

Flags and environment variables for the default server invocation — `painapple [flags]` (or explicitly `painapple serve [flags]`, or `python -m painapple_code [flags]` from a repo checkout).

`painapple help` (or a leading `-h`/`--help`) prints a curated command overview — serve, `setup`, `list`, `start`/`stop`/`restart`, `status`/`logs`/`password`, container verbs — with the most common flags; `painapple serve --help` prints the full flag reference below. A bare `painapple` **always serves the directory you launch it from** (`--workspace` overrides). `painapple list` (or a bare `painapple status`) shows [every deployment on the machine](#the-fleet-view-painapple-list) — the root one, every saved [profile](profiles.md) host or docker, and any unmanaged server processes. `painapple start`/`stop`/`restart` manage instances [in the background](#background-lifecycle-painapple-startstoprestart).

## Saved defaults — `painapple setup`

`painapple setup` is an interactive wizard that saves **global** defaults to `~/.painapple-code/serve.yaml`: the network bind (host/port/TLS) a bare `painapple` starts with, and the container runtime + image used by [`--in-docker`](profiles.md#ad-hoc-container-mode-in-docker). Explicit flags always override the saved values. Two quick sections plus a review screen; nothing is written until you confirm.

Workspace and cosmetics are **profile-only** since the CLI unification — a bare `painapple` serves the cwd, and a label/accent belongs to a named deployment. `painapple setup NAME` creates/edits that [profile](profiles.md) instead (host or docker mode).

```yaml
# ~/.painapple-code/serve.yaml — written by `painapple setup`, editable by hand
host: 127.0.0.1
port: 8765
tls: auto
runtime: docker         # --in-docker: docker | podman | /path/to/binary
image: painapple-code:latest
```

Recognized keys: `host`, `port`, `tls` (serve defaults — each maps 1:1 onto the flag of the same name below) plus `runtime`, `runtime_flags`, `image` (read only by the `--in-docker` launch path). Unknown keys, invalid values, and leftover pre-unification keys (`workspace`, `instance_name`, `accent`) are skipped with a warning in the server log. The file lives under `PAINAPPLE_CODE_HOME` (default `~/.painapple-code`). Precedence: built-in default &lt; `serve.yaml` &lt; explicit flag — so systemd units and the Docker entrypoint, which pass everything explicitly, are unaffected.

!!! note "Container mode is a flag, not a command group"
    `painapple --in-docker` runs the same invocation in a Docker/Podman container, and profiles carry a `mode: host | docker` — see [Profiles & container mode](profiles.md). The old `painapple docker` command group is gone.

## Flags

Defaults shown are the built-ins — values saved by [`painapple setup`](#saved-defaults-painapple-setup) replace them; explicit flags override both.

### Server — where it listens and what it works on

| Flag | Default | Description |
|------|---------|-------------|
| `--host` | `127.0.0.1` | Host interface to bind — `127.0.0.1` = this machine only, `0.0.0.0` = every interface (reachable on your LAN) |
| `--port` | `8765` | Port to bind to |
| `--workspace` | `.` | Workspace **root** — the directory holding your projects. You pick the actual project in-app from the welcome screen, and each session's files/git/terminal follow its own directory; this anchors the file explorer and the welcome screen's "Unvisited" project chips. Mapped to `/workspace` inside Docker. (`--cwd` is an alias.) |
| `--instance-name` | — | Instance label for the PWA icon and UI (e.g. `DEV`, `STABLE`) |
| `--accent` | — | Accent color: a preset name (see below) or a hex value like `#f87171` |
| `--profile` | — | Run a named [profile](profiles.md) in the foreground (host: its own isolated data home; docker: its container) |
| `--in-docker` | off | Run this same invocation inside a container instead — see [Profiles & container mode](profiles.md#ad-hoc-container-mode-in-docker) |

### Network security

| Flag | Default | Description |
|------|---------|-------------|
| `--tls` | `auto` | TLS mode: `auto`, `on`, or `off` (see below) |
| `--tls-cert` | `<config-dir>/cert.pem` | TLS certificate path (auto-generated if missing) |
| `--tls-key` | `<config-dir>/key.pem` | TLS key path (auto-generated if missing) |
| `--public-origin` | — | Extra trusted browser origin for the CSRF/Origin gate, e.g. `https://claude.example.com`. Repeatable. **Usually unnecessary** — the server already accepts any request whose `Origin` matches the host it was reached on (proxied hostname or LAN IP, zero config). Only needed for a *genuinely cross-origin* front-end served from a different host than the server. |

See [Origin/CSRF boundary](#origincsrf-boundary) below for how the trusted-origin
set is built and when you need this flag.

### Advanced

| Flag | Default | Description |
|------|---------|-------------|
| `--default-provider` | `claude-sdk` | Default [AI engine](../guides/engines.md) for new sessions (existing sessions keep their recorded engine). Pinning it here also hides the UI's "Make default" button |
| `--enable-eruda` | off | Enable the Eruda mobile-devtools quick action (loads from a CDN) |
| `--enable-renderers` | off | Enable **server-side** chart/diagram rendering (Vega-Lite / Excalidraw). Off by default because a model-authored spec is rendered through a Node subprocess whose data loader can fetch external/`file:` URLs (SSRF / local-file read). Client-side rendering is unaffected. Also settable via `PAINAPPLE_ENABLE_RENDERERS=1`. |
| `-v`, `--version` | — | Print version and exit |

### Multi-instance — isolate state when several servers share one user

| Flag | Default | Description |
|------|---------|-------------|
| `--shadow-db` | `~/.painapple-code/shadow.duckdb` | DuckDB path for the shadow turn store |
| `--log-dir` | `~/.painapple-code/logs/` | Log directory |
| `--state-suffix` | — | Per-tier suffix for UI-state files (tab-state, shortcuts, presets, favorites, global config) so co-located instances don't share them. `--state-suffix dev` gives `tab-state-dev.json`; a leading `-` is added automatically. Project and session history stays shared. |
| `--auth-config-file` | `~/.config/painapple-code/config.yaml` | Auth config file path |

## TLS behavior

- `--tls auto` (the default) enables TLS **only when binding to a non-loopback host**. On `127.0.0.1`, `::1`, or `localhost` the server stays plain HTTP.
- `--tls on` forces TLS; `--tls off` disables it even on non-loopback binds (the server logs a loud warning — your auth token and chat contents travel the LAN unencrypted).
- When TLS is enabled, a self-signed certificate is auto-generated at `<config-dir>/cert.pem` / `key.pem` (next to the auth config file). There is no OS trust-store install; browsers show a one-time certificate warning.

!!! warning "Non-loopback binds"
    Binding to a non-loopback host also makes the server trust `X-Forwarded-Proto` from any client (`forwarded_allow_ips` is `*`). For real exposure, put the server behind a reverse proxy that sets that header itself — see [Read this first](../getting-started/security.md).

## Filesystem access

pAInapple Code browses, reads and **writes** anywhere its OS user can — your home
directory, `/data`, `/srv`, a NAS mount, Docker's `/workspace`, wherever. There
is no path allowlist. The only exclusions are `/proc`, `/sys` and `/dev`, which
are skipped for practical reasons (kernel-special files like the 128 TB
`/proc/kcore` make the file browser hang, and editing them is meaningless).

That's deliberate, not an oversight: everyone reaching these endpoints is already
past the [password gate](../getting-started/security.md), and an authenticated
session comes with a full PTY terminal, `!bang` shell commands, and an agent
running as the same user. A path allowlist on the editor would stop nothing that
isn't one shell line away, while breaking legitimate edits to projects outside
`$HOME`. **Unix file permissions are the real boundary** — run the server as a
user that can only touch what you're willing to expose, and don't run it as root.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `PAINAPPLE_CODE_HOME` | Override the data directory (default `~/.painapple-code`). Set to `/data` in the Docker image. |
| `PAINAPPLE_PROFILE` | Default [profile](profiles.md) when `--profile` isn't given. |
| `PAINAPPLE_CODE_CONFIG` | Override the config directory (default `~/.config/painapple-code`) — where `config.yaml` and the auto-generated TLS cert/key live. |
| `BRIDGE_ALLOWED_ORIGINS` | Comma-separated list of extra trusted browser origins for the CSRF/Origin gate **and** the CORS allow-list (see [Origin/CSRF boundary](#origincsrf-boundary)). Unlike `--public-origin`, this also drives CORS and `TrustedHostMiddleware`. Rarely needed — same-origin traffic is accepted with no config. |
| `PAINAPPLE_ENABLE_RENDERERS` | Set to `1`/`true` to enable server-side chart/diagram rendering (same as `--enable-renderers`; off by default — see the flag). |
| `FORWARDED_ALLOW_IPS` | Comma-separated peers whose `X-Forwarded-*` headers uvicorn trusts. Defaults to `127.0.0.1,::1` (a local reverse proxy). Set to your proxy's address if it isn't loopback; only set `*` if the server is never directly reachable. |
| `PAINAPPLE_REVEAL_CMD` | Exact "reveal password" command shown verbatim on the login page. Launchers (the Docker wrapper) set this because they know the host-side container name and engine; unset, the page falls back to a per-environment guess. |
| `PAINAPPLE_IN_CONTAINER` | Set to `1` inside the official image. Gates the filesystem probes that distinguish Docker from Podman for the login page's environment detection — never set this on a bare-metal host. |

## Origin/CSRF boundary

Any authenticated client can reach `/api/exec` (arbitrary shell as the server
user), so the server guards state-changing requests that carry an **ambient**
credential (the `bridge_auth` cookie or a `?tkn=`) against cross-site forgery.
A `Authorization: Bearer` request sets its credential explicitly and is exempt.

A request is accepted when **any** of these hold:

1. The browser reports `Sec-Fetch-Site: same-origin` (or `none`).
2. Its `Origin` matches the host it was reached on — the request's own `Host`
   (or `X-Forwarded-Host` from a trusted proxy). **This is automatic**: a
   reverse-proxied hostname or a `0.0.0.0` LAN bind is genuinely same-origin, so
   it works with zero configuration.
3. Its `Origin` is in the configured trusted set (`--public-origin` /
   `BRIDGE_ALLOWED_ORIGINS`).

You only need `--public-origin`/`BRIDGE_ALLOWED_ORIGINS` for a **genuinely
cross-origin** front-end — a page served from a *different* host than the server
that must call it with credentials. `BRIDGE_ALLOWED_ORIGINS` additionally
configures the CORS allow-list and (when set) the `Host`-header allow-list;
`--public-origin` affects only the Origin gate.

WebSocket handshakes are checked the same way (browsers always send `Origin` on
a WS upgrade); a missing `Origin` — a non-browser script/native client — is
allowed and still gated by the password check.

## Accent color presets

`--accent` accepts any of these preset names, or an arbitrary hex color (`--accent '#e11d48'`):

| Preset | Hex |
|--------|-----|
| `blue` | `#58a6ff` |
| `green` | `#22c55e` |
| `red` | `#f87171` |
| `orange` | `#fb923c` |
| `purple` | `#c084fc` |
| `cyan` | `#06b6d4` |
| `gray` (or `grey`) | `#9ca3af` |
| `yellow` | `#facc15` |
| `pink` | `#f472b6` |
| `teal` | `#14b8a6` |
| `indigo` | `#818cf8` |
| `lime` | `#a3e635` |

## Profiles — multiple deployments

`painapple --profile NAME` (or `PAINAPPLE_PROFILE=NAME` in the environment) runs a named, fully independent deployment in the foreground. A **host-mode** profile gets its own data home at `~/.painapple-code/profiles/NAME/`: sessions, shadow DB, logs, global config, and its `profile.yaml`, all isolated from the default instance (this isn't cosmetic — the DuckDB turn store is single-writer, so two servers can never share one data home). A **docker-mode** profile runs as its container instead. Full reference: [Profiles & container mode](profiles.md).

```bash
painapple setup work               # create/edit the profile (mode, workspace, port, …)
painapple start work               # run it in the background — alongside the default instance
painapple --profile work           # …or run it in the foreground
painapple list                     # everything shows up, host and docker alike
```

Profile names are letters, digits, `.`, `_`, `-` (max 32); `default` is reserved for the flag-less root deployment (the classic `~/.painapple-code` home). If a profile doesn't set an `instance_name`, the profile name is used as the UI label, so co-running instances stay distinguishable.

## Background lifecycle — `painapple start`/`stop`/`restart`

There is no daemon — a painapple server process *is* the instance — so these commands find their target the same way `painapple list` does (process scan; exact data-home match first, port match only when the home can't be read) and manage it with plain signals. The name resolves in order: **saved profile → instance label → PID → port** — anything `painapple list` prints is a valid target:

```bash
painapple start work               # spawn detached, wait for the port, print the login URL
painapple stop work                # SIGTERM, escalate to SIGKILL after 10s
painapple restart work             # stop (if running) + start
painapple restart STAGING          # by instance label (case-insensitive) …
painapple restart 16187            # …or by pid …
painapple stop 8766                # …or by port
painapple start                    # no name = the flag-less default deployment
painapple start work --port 9001   # extra serve flags apply to THIS start only (not saved)
```

`start` targets a **saved** profile (`painapple setup NAME` first) — an unknown name is refused rather than silently spawning an empty deployment, and a port already occupied by a *different* instance is refused up front. A **docker-mode** profile delegates to the container runtime instead: `start` = `docker run -d --restart unless-stopped` (durable across reboots), `stop` = `docker stop`. A label/pid/port target has no saved config (it was launched ad hoc with flags), so `restart` recaptures the live process's own command line, working directory, and environment (`/proc` on Linux; a lossier `ps`-based fallback elsewhere) and respawns it verbatim. Console output goes to `<data-home>/logs/console.log`; the regular `server.log` lives next to it. A failed startup prints the tail of the console log. For an always-on host instance prefer a service manager (systemd, launchd) that restarts on exit — host `start` spawns once and does not supervise.

`painapple status NAME`, `painapple logs NAME`, and `painapple password [NAME]` inspect any deployment — host or docker — without touching it. `status` also takes an unmanaged process's label, PID, or port, and a bare `painapple status` is the [fleet view](#the-fleet-view-painapple-list) (`painapple status default` is the root deployment's own detail block).

With no NAME `logs`/`password` target the **root** deployment, which is the host one. The ad-hoc `painapple --in-docker` sandbox has no name to select it by, so it takes the mode flag instead: `painapple password --in-docker`, `painapple logs --in-docker`. (Its own login page prints the right command for you.) If no host server has ever run and the sandbox is up, a bare `painapple password` answers for the sandbox rather than reporting nothing.

## Running multiple instances (manual flags)

Prefer [profiles](profiles.md) for full isolation. Alternatively, `--instance-name`, `--accent`, `--state-suffix`, `--shadow-db`, and `--log-dir` together run several tiers side by side under one user *sharing* project/session history, without stepping on each other's state:

```bash
painapple --port 8880 --instance-name DEV --accent red \
  --state-suffix dev \
  --shadow-db ~/.painapple-code/shadow-dev.duckdb \
  --log-dir ~/.painapple-code/logs-dev
```

Each instance needs its own shadow DB — DuckDB is single-writer.

## The fleet view — `painapple list`

`painapple list` (aliases `ls`, `ps`, `instances`, `profiles`) and a bare `painapple status` render the same overview, in two sections:

- **Deployments** — everything a NAME verb targets: the root `default` deployment first, then every saved [profile](profiles.md), each with a `[host]`/`[docker]` badge, its address, and its running state. A running server is matched to its deployment by data home (exact) and port, so the process behind `default` is shown *as* `default` — with its `--instance-name` label alongside the PID when it has one.
- **Unmanaged processes** — painapple servers in the process table that belong to no deployment: launched by hand or by a service unit with their own flags. Their name is just their `--instance-name` label, and `stop`/`restart`/`status`/`logs` accept it (or their PID or port).

The ad-hoc `painapple --in-docker` container, when one exists, gets its own line below.

## Known limitations

This is an MVP; some corners are honestly rough:

1. **Windowing system** — works, but doesn't support multiple instances of the same widget and could use a rethink.
2. **Code editor** — currently a notepad with syntax highlighting. The plan is a review-driven workflow rather than a VSCode-grade editor; the markdown inline editor is the exception and works well for plan and doc tweaks.
3. **GUI for OS-level features** — the git widget and file explorer exist, but the embedded terminal is often the better tool for `grep` / `sed` / `find` / `du`, so these widgets haven't been a priority.
