# Profiles & container mode

A **profile** is a named, independent deployment — its own port, data, and settings — with a **run mode** that says *how* it runs:

- **`host`** — a local server process. The profile's directory is its entire data home (sessions, shadow DB, logs, config), isolated from every other instance.
- **`docker`** — a container sandbox (Docker or Podman) built from the prebuilt image. Only the config lives in the profile directory; data lives in the container's volume.

Docker is a *run mode*, not a separate tool: the same `setup` / `start` / `stop` / `status` / `logs` / `password` verbs work on both kinds, and `painapple --in-docker` runs an ad-hoc sandbox with no profile at all.

!!! note "Pull-only"
    The CLI fetches the prebuilt image (`wrotek/painapple-code`) from Docker Hub with `painapple pull` — there is intentionally no `build` verb. Building from source (and the personalize/devcontainer paths) requires a repo checkout and `./painapple-docker.sh build` (the wrapper is build-only).

## Ad-hoc container mode — `--in-docker`

The fastest way to sandbox a project — no profile, no wizard:

```bash
painapple pull            # fetch the prebuilt image (one time)
cd ~/code/my-project
painapple --in-docker     # current dir mounted, foreground, Ctrl-C stops
```

It's the containerized twin of a bare `painapple`: the current directory (or `--workspace PATH`) is mounted into the image, the workspace layout is auto-picked (`.git` present → single project, else a folder of projects), and explicit serve flags (`--host`, `--port`, `--tls`, `--instance-name`, `--accent`) forward into the container. The runtime and image come from the global defaults saved by [`painapple setup`](#global-defaults-vs-profiles). Foreground runs are ephemeral (`--rm`); for a durable, detached sandbox make it a profile and `painapple start` it.

## Global defaults vs profiles

`painapple setup` (no name) saves **global** defaults to `~/.painapple-code/serve.yaml`: the network bind (host/port/TLS) for a bare serve, and the container runtime for `--in-docker` — a chooser listing every runtime detected on the machine (with version and path), a custom binary path, and the image tag.

Workspace and cosmetics are deliberately **not** global: a bare `painapple` always serves the directory you launch it from, and a label/accent only makes sense on a named deployment. Those live in profiles.

## Creating a profile — `painapple setup NAME`

Creating **is** configuring: `painapple setup work` on a new name runs the wizard with fresh defaults; on an existing name it opens pre-filled. Steps:

1. **Run mode** — host or docker
2. **Workspace** — host: a fixed directory; docker: single project / folder of projects / multiple specific repos
3. **Network** — bind address, port (collision-checked against other profiles), TLS
4. **Cosmetics** — instance label (defaults to the profile name), accent color
5. *(docker only)* **Claude state** — isolated (default, with one-time credential seeding from your host login), shared with the host's `~/.claude`, or custom
6. *(docker only)* **Storage** — named volume or host directory

Nothing is written until the review screen's "Save & finish".

## Running & managing

Every verb takes the profile name and dispatches on its mode:

| Command | host mode | docker mode |
|---------|-----------|-------------|
| `painapple start NAME` | detached server spawn (logs to `<home>/logs/console.log`, waits for the port, prints the login URL) | `docker run -d --restart unless-stopped` (durable — survives reboots) |
| `painapple stop NAME` | SIGTERM → SIGKILL after 10 s | `docker stop` |
| `painapple restart NAME` | stop + start | recreate the container (config changes apply) |
| `painapple --profile NAME` | run in the foreground | run the container in the foreground (`--rm`) |
| `painapple status NAME` | config + running PID + URL | config + container state + URL + password |
| `painapple logs NAME` | tail `server.log` / `console.log` | follow container logs |
| `painapple password [NAME]` | login URL + password from the bridge config | same, read from the container/volume |
| `painapple shell NAME` | — (it's just this machine) | shell inside the container |
| `painapple claude-login NAME` | — | run `claude login` inside the container |
| `painapple extract NAME [DEST]` | — | copy the data volume to a host directory |

`painapple list` — or a bare `painapple status`, same view — shows everything at a glance in two sections: **Deployments** (the root `default` deployment plus every profile, with a `[host]`/`[docker]` badge and its running state) and **Unmanaged processes** (painapple servers started directly, by hand or by a service unit, that no saved deployment owns). The ad-hoc `--in-docker` container gets its own line when it exists.

The name `default` is reserved — it means the flag-less root deployment (`painapple stop` with no name stops it, `painapple status default` shows it in detail).

Unmanaged processes are targetable too: `stop`, `restart`, `status`, and `logs` accept an instance label, a PID, or a port, so anything the fleet view prints is a valid target.

## The profile store

```yaml
# ~/.painapple-code/profiles/work/profile.yaml — written by `painapple setup work`
mode: docker
workspace: /home/me/code/my-project
workspace_mode: project        # project | parent | multi (docker only)
port: 8766
host: 127.0.0.1                # the HOST bind the container publishes on
tls: auto
instance_name: WORK
accent: green
image: painapple-code:latest
container: painapple-code-work
data_volume: painapple-data-work
config_volume: ~/.config/painapple-code/docker-work
claude_home: ~/.painapple-code/shared/.claude
```

Shared keys use the serve vocabulary (`host` = bind, `tls`, `port`, `workspace`, `instance_name`, `accent`); docker mode adds its own. Docker profiles get **collision-free defaults** derived from the name — container `painapple-code-NAME`, volume `painapple-data-NAME`, bridge config `~/.config/painapple-code/docker-NAME` — while `claude_home` defaults to the shared isolated directory so one `claude login` serves every sandbox. Per-profile `runtime`/`runtime_flags` override the global ones when set.

For **host** profiles the directory is the whole data home — sessions, shadow DB, logs, everything. Isolation isn't cosmetic: the DuckDB turn store is single-writer, so two servers can never share one home. If the profile doesn't set an `instance_name`, the profile name becomes the UI label.

`host` in a docker profile is the **host-side** publish interface (`-p HOST:PORT:8765`), not the container's internal bind (always `0.0.0.0:8765`). `0.0.0.0` exposes the sandbox on your LAN; `127.0.0.1` keeps it local.

## Scripted access — `painapple profile`

The non-interactive channel (it's what the macOS desktop launcher uses):

```bash
painapple profile list                       # name<TAB>mode, one per line
painapple profile get work                   # mode= + key=value lines
painapple profile get work port              # one bare value
painapple profile set work PORT=9001 TLS_MODE=on   # validate + write
painapple profile set newbox WORKSPACE=~/code/app  # creates it (mode: docker)
painapple profile path work                  # profile.yaml location
painapple profile delete work                # config only — data stays
```

`set` accepts `KEY=VALUE` pairs (the classic uppercase vocabulary — `LISTEN_HOST`/`TLS_MODE` map onto `host`/`tls`) or `--kebab-case value` flags, with the same validation the wizard applies. Creating via `set` defaults to `mode: docker`; pass `--mode host` for a host profile.

## Migration from the old layout

Earlier releases had two separate stores — `serve-profiles/` (host) and `docker-profiles/` + a root `docker.yaml` (managed by the removed `painapple docker` command group). The first profile-aware command adopts them automatically, loudly, and idempotently:

- `serve-profiles/NAME/` moves wholesale to `profiles/NAME/` (data rides along; a compat symlink is left at the old path for hand-written service units)
- `docker-profiles/NAME/docker.yaml` becomes `profiles/NAME/profile.yaml` with `mode: docker` (a name collision renames it `NAME-docker`)
- the root `docker.yaml`'s runtime/image settings merge into `serve.yaml` as the `--in-docker` defaults, and the deployment itself becomes profile `docker` if its container or volume actually exists

`painapple docker …` itself prints a pointer to the new verbs and exits.

## Runtime auto-detection

When no runtime is configured, the CLI prefers `docker` and falls back to `podman` — skipping any runtime that's on `PATH` but not actually answering (a `docker` CLI with no reachable daemon), and erroring if neither works (configure a custom binary path in `painapple setup`). Podman gets `--userns=keep-id` applied automatically so bind mounts stay writable — remapped to the image's own user (`keep-id:uid=…,gid=…`) when your host UID differs from it, since otherwise nothing the container is mounted for would be writable. SELinux-enforcing hosts get `:Z`-labeled mounts.

## Typical flows

```bash
# Ad-hoc sandbox for the current project
painapple pull && painapple --in-docker

# A durable named sandbox
painapple setup myapp        # wizard: mode docker, pick the repo
painapple start myapp        # runs detached, prints the login URL
painapple password myapp     # reveal it again later

# A second host instance on its own port/data
painapple setup work         # wizard: mode host
painapple start work
```
