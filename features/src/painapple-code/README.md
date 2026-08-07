# pAInapple Code (Dev Container Feature)

Installs the [pAInapple Code](https://github.com/wrotek/painapple-code) bridge
inside any Dev Container or GitHub Codespace, so you can drive `claude` from
a browser (including iPad PWA) on a remote VM.

## Usage

Add the Feature to your project's `.devcontainer/devcontainer.json`:

```json
{
    "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
    "features": {
        "ghcr.io/wrotek/painapple-code/painapple-code:1": {}
    },
    "forwardPorts": [8765],
    "portsAttributes": {
        "8765": {
            "label": "pAInapple Code",
            "onAutoForward": "notify"
        }
    },
    "secrets": {
        "ANTHROPIC_API_KEY": {
            "description": "Anthropic API key — used by the in-container `claude` CLI."
        }
    }
}
```

On container start, an interactive-shell hook prints the login URL with the
auth token already embedded:

```
==> pAInapple Code is ready. Ctrl+Click the URL or paste the token:
https://your-codespace-8765.app.github.dev/?tkn=abc123…
token: abc123…
```

Ctrl+Click the URL in the integrated terminal, or open the forwarded port
from the Codespaces "Ports" tab and append `?tkn=<password>`.

## Install on an existing Codespace (no devcontainer.json change)

If you don't want to modify the project's `devcontainer.json` — for example
when sharing a sandbox with a tester whose repo you don't control — run the
Feature's `install.sh` directly:

```bash
curl -fsSL https://raw.githubusercontent.com/wrotek/painapple-code/main/features/src/painapple-code/install.sh \
    | sudo bash
```

This is the same script the OCI Feature runs at build time; all options
have sensible defaults. To override, pass them as env vars (sudo strips env,
so pass them after `sudo`):

```bash
curl -fsSL https://raw.githubusercontent.com/wrotek/painapple-code/main/features/src/painapple-code/install.sh \
    | sudo PORT=9000 INSTANCENAME=TESTER ACCENT=orange bash
```

Caveats:

- Does **not** survive a "Rebuild Container" — for persistent installs use
  the `features` block above.
- After the script finishes, open a fresh terminal (auto-starts via
  `/etc/profile.d/painapple-code.sh`) or run `painapple-code-start` to
  print the login URL.

## Options

| Option | Default | Description |
|---|---|---|
| `version` | `main` | Git ref of painapple-code to install (branch, tag, SHA). |
| `repo` | `https://github.com/wrotek/painapple-code.git` | Override to install from a fork. |
| `port` | `8765` | Listen port. Match this in `forwardPorts`. |
| `instanceName` | `CODESPACE` | Label in the PWA header. |
| `accent` | `blue` | Accent color: `blue`, `green`, `red`, `orange`, `purple`, `cyan`. |
| `autostart` | `true` | Start the bridge on first interactive shell. Disable to launch manually with `painapple-code-start`. |
| `installHelpers` | `true` | Install `shadow-git`, `shadow-query`, and the `shadow-git-helper` agent. |

Example with options:

```json
"features": {
    "ghcr.io/wrotek/painapple-code/painapple-code:1": {
        "version": "v1.0.0",
        "port": "8765",
        "instanceName": "MYPROJ",
        "accent": "purple"
    }
}
```

## Authentication

The in-container `claude` CLI needs to talk to Anthropic. Two paths:

1. **`ANTHROPIC_API_KEY` secret** (recommended for Codespaces) — set it as
   a Codespaces user/repo secret. The CLI picks it up automatically.
2. **OAuth login inside the container** — once the codespace is running,
   open a terminal and run `claude login` once; the credential is stored
   under `$HOME/.claude/` and persists for the life of the codespace.

The bridge's own password (separate from Claude auth) is generated on
first start. Codespaces stores it at
`/workspaces/.painapple-code/auth.yaml` (so it survives "Rebuild
Container"); other environments use `~/.config/painapple-code/config.yaml`.

```bash
# Reveal it later (Codespaces)
awk '/^password:/ {print $2}' /workspaces/.painapple-code/auth.yaml

# Reveal it later (other)
awk '/^password:/ {print $2}' ~/.config/painapple-code/config.yaml
```

The launcher prints a Codespaces-aware login URL on every interactive
shell — `https://<codespace>-<port>.<domain>/?tkn=<password>` inside a
codespace, `http://localhost:<port>/?tkn=<password>` elsewhere.

## What gets installed

| Path | Purpose |
|---|---|
| `/opt/painapple-code/` | Cloned source + Python venv |
| State dir † | Bridge state (sessions, logs, shadow DB, launcher PID + log) |
| Auth config † | Password file the server reads / writes |
| `/usr/local/bin/painapple-code-start` | Idempotent launcher script |
| `/etc/profile.d/painapple-code.sh` | Bash/sh autostart hook (when `autostart=true`) |
| `/etc/fish/conf.d/painapple-code.fish` | Fish autostart hook — fires only if fish is the user's login shell |
| `/etc/fish/conf.d/painapple-code-path.fish` | Adds `~/.local/bin` to PATH under fish |
| `~/.local/bin/shadow-git`, `shadow-query` | Optional helpers (when `installHelpers=true`) |
| `~/.claude/agents/shadow-git-helper.md` | Optional agent template |

**† State and auth path:** in **Codespaces** the launcher anchors both
under `/workspaces/.painapple-code/` (state) and
`/workspaces/.painapple-code/auth.yaml` (auth). `/workspaces` is the
only path that survives a "Rebuild Container" — `$HOME` gets wiped —
so sessions, shadow DB, and the bridge password all carry across
rebuilds. **Elsewhere** (plain Docker, host install) the conventional
`$HOME/.painapple-code/` + `$HOME/.config/painapple-code/config.yaml`
layout is used. Override with `PAINAPPLE_CODE_HOME` and
`PAINAPPLE_AUTH_CONFIG` env vars before starting.

This Feature does **not** change the container user's login shell. If you
want a particular shell (fish, zsh) in your devcontainer, configure that
in `devcontainer.json` — e.g. via `postCreateCommand` or a community shell
Feature like `ghcr.io/meaningful-ooo/devcontainer-features/fish:1`.

## Managing the bridge

```bash
# Start (idempotent — no-op if already running, but always prints the login URL)
painapple-code-start

# Stop / Logs — substitute the state dir for your environment.
# Codespaces: /workspaces/.painapple-code
# Elsewhere : ~/.painapple-code
kill "$(cat /workspaces/.painapple-code/launcher.pid)"
tail -f /workspaces/.painapple-code/launcher.log
```

## Troubleshooting

- **Port not forwarded / iPad can't connect:** check the Codespaces "Ports"
  tab. The `forwardPorts` array in `devcontainer.json` controls visibility;
  the token in the URL gates access regardless of public/private setting.
- **`claude` exits with auth error:** set `ANTHROPIC_API_KEY` or run
  `claude login` in the container terminal.
- **Workspace path:** the launcher uses `/workspaces` (the Codespaces
  default — the bridge shows each subdirectory as a separate project).
  Override with `PAINAPPLE_WORKSPACE=/path/to/root` before calling
  `painapple-code-start`.
- **Want to update painapple-code:** rebuild the dev container
  (Codespaces: "Rebuild Container" command). The Feature re-runs and pulls
  the requested ref.
