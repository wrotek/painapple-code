# Install with pip / pipx

This is the recommended way to **install** pAInapple Code. It needs Python 3.12+, `git` on `PATH`, and — for host-mode sessions — the [Claude Code CLI](https://github.com/anthropics/claude-code) installed and authenticated (see [Requirements](requirements.md)).

Installing on the host doesn't commit you to *running* on the host. The same `painapple` command runs sessions either way: bare for the simplest setup, or `painapple --in-docker` to put each instance in its own container — which is the recommended way to run it, and needs no separate install. See [container mode](install-docker.md).

!!! warning "Running bare means no isolation"
    Without `--in-docker`, Claude — and the built-in terminal — run as your user, on your machine, with your filesystem. That's fine for a throwaway VM or a project you'd trust with a shell, but read the [security notes](security.md) first, and prefer `--in-docker` for anything else.

## pipx (recommended)

No pipx yet? It's two lines (or `brew install pipx` on macOS):

=== "Linux / macOS"

    ```bash
    python3 -m pip install --user pipx
    python3 -m pipx ensurepath
    ```

=== "Windows (PowerShell)"

    ```powershell
    python -m pip install --user pipx
    python -m pipx ensurepath
    ```

Then:

=== "Linux / macOS"

    ```bash
    pipx install painapple-code
    painapple --workspace /path/to/your/projects
    ```

=== "Windows (PowerShell)"

    ```powershell
    pipx install painapple-code
    painapple --workspace C:\Users\you\projects
    ```

!!! warning "Windows on ARM needs one extra flag"
    On ARM64 Windows (Surface, Snapdragon X), install with:

    ```powershell
    pipx install painapple-code --pip-args="--only-binary=cryptography"
    ```

    `cryptography` publishes no ARM64 Windows wheel past 46.0.3. Without the flag pip picks a newer version, finds no wheel, falls back to building it from Rust source, and fails unless you have the MSVC build tools installed. The flag holds it at the newest version that *does* ship a wheel. Keep it scoped to `cryptography` — `--only-binary=:all:` also rules out `claude-agent-sdk`, which is source-only, and breaks the install a different way. x64 needs none of this.

The package drops a `painapple` console script on your PATH. Bare `painapple` serves the current directory (the explicit form is `painapple serve`); add `--in-docker` to run the same thing in a container — see [container mode](install-docker.md) and [Profiles & container mode](../reference/profiles.md).

## pip (into a venv)

=== "Linux / macOS"

    ```bash
    python3 -m venv venv
    venv/bin/pip install painapple-code
    venv/bin/painapple --workspace /path/to/your/projects
    ```

    `python -m painapple_code` is equivalent to the console script:

    ```bash
    venv/bin/python -m painapple_code --workspace /path/to/your/projects
    ```

=== "Windows (PowerShell)"

    ```powershell
    py -m venv venv
    venv\Scripts\pip install painapple-code
    venv\Scripts\painapple --workspace C:\Users\you\projects
    ```

    `python -m painapple_code` is equivalent to the console script:

    ```powershell
    venv\Scripts\python -m painapple_code --workspace C:\Users\you\projects
    ```

## From a source checkout

=== "Linux / macOS"

    ```bash
    git clone https://github.com/wrotek/painapple-code.git && cd painapple-code
    python3 -m venv venv
    venv/bin/pip install -e .
    venv/bin/python -m painapple_code --workspace /path/to/your/projects
    ```

=== "Windows (PowerShell)"

    ```powershell
    git clone https://github.com/wrotek/painapple-code.git; cd painapple-code
    py -m venv venv
    venv\Scripts\pip install -e .
    venv\Scripts\python -m painapple_code --workspace C:\Users\you\projects
    ```

!!! note "Activating the venv"
    None of the commands above need an activated venv — calling the interpreter by path is enough. If you do want to activate: `source venv/bin/activate` is bash-only, so use `activate.fish` / `activate.csh` on those shells, and `venv\Scripts\Activate.ps1` on PowerShell. If PowerShell refuses that script, it's the execution policy: `Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned`.

### start.sh — self-bootstrapping launcher

!!! note "Unix only"
    `start.sh` is a bash script — it needs Linux, macOS, or a bash on Windows (Git Bash / WSL). On native Windows use the venv commands above; there is nothing `start.sh` does that they don't, it just does it in one step.

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
