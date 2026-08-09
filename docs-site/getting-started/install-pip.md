# Install with pip / pipx

Run the server directly on the host — no container. This path needs Python 3.12+ and the [Claude Code CLI](https://github.com/anthropics/claude-code) installed and authenticated (see [Requirements](requirements.md)).

!!! warning "No isolation"
    Running bare on the host means Claude — and the built-in terminal — run as your user, on your machine. Read the [security notes](security.md) before choosing this path; the [Docker install](install-docker.md) is the recommended default.

## pipx (recommended for direct installs)

```bash
pipx install painapple-code
painapple --workspace /path/to/your/projects
```

The package drops a `painapple` console script on your PATH. Bare `painapple` serves the current directory (the explicit form is `painapple serve`); add `--in-docker` to run the same thing in a container — see the [Docker install](install-docker.md) and [Profiles & container mode](../reference/profiles.md).

## pip (into a venv)

```bash
python3 -m venv venv
venv/bin/pip install painapple-code
venv/bin/painapple --workspace /path/to/your/projects
```

`python -m painapple_code` is equivalent to the console script:

```bash
venv/bin/python -m painapple_code --workspace /path/to/your/projects
```

## From a source checkout

```bash
git clone https://github.com/wrotek/painapple-code.git && cd painapple-code
python3 -m venv venv
venv/bin/pip install -e .
venv/bin/python -m painapple_code --workspace /path/to/your/projects
```

!!! note "fish / csh users"
    `source venv/bin/activate` is bash-only. On fish or csh, use `venv/bin/python` directly, or your shell's matching activate script (`activate.fish`, `activate.csh`).

### start.sh — self-bootstrapping launcher

A repo checkout also includes `./start.sh`, which creates the venv and installs dependencies on first run (or when `requirements.txt` changes), then launches the server. It's safe to run repeatedly, and unrecognized arguments are forwarded to `python -m painapple_code`:

```bash
./start.sh                                  # 127.0.0.1:8765
HTTP_PORT=8880 ./start.sh                   # pick the port via env
./start.sh --instance-name DEV --accent orange
./start.sh --no-install                     # skip the venv bootstrap step
./start.sh --reinstall                      # force a fresh `pip install -e .`
```

`HTTP_HOST` and `HTTP_PORT` environment variables set the bind address and port (defaults `127.0.0.1` and `8765`).

## Common flags

| Flag | Default | Description |
|------|---------|-------------|
| `--host` | `127.0.0.1` | Bind address |
| `--port` | `8765` | Listen port |
| `--workspace` | `.` | Workspace directory — the dir Claude operates in (`--cwd` is an alias) |
| `--instance-name` | — | Label for the PWA icon and header (e.g. `DEV`) |
| `--accent` | — | Accent color: preset name or hex |
| `--tls` | `auto` | TLS mode: `auto` (on for non-loopback binds), `on`, `off` |

Run `painapple --help` for the full list.

## Next step

Open `http://localhost:8765/` and follow the bootstrap URL printed on first run — see [First run & login](first-run.md).
