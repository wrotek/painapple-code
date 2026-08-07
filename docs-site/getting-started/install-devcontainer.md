# Dev Containers & Codespaces

pAInapple Code ships a [Dev Container Feature](https://containers.dev/features) — one line in a project's `devcontainer.json` and every Codespace (or local dev container) you open on that project boots with the bridge installed, started, and port-forwarded, ready to connect from an iPad or any browser.

## Add the Feature

Minimal `.devcontainer/devcontainer.json`:

```jsonc
{
    "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
    "features": {
        "ghcr.io/wrotek/painapple-code/painapple-code:1": {}
    },
    "forwardPorts": [8765]
}
```

The Feature works on top of any Debian/Ubuntu-based image — the official `mcr.microsoft.com/devcontainers/...` images, your team's custom image, anything with apt. If your project already has a `devcontainer.json`, merge in the `features` and `forwardPorts` keys.

A more complete example, with port labels and an API-key secret:

```jsonc
{
    "name": "My Project + pAInapple Code",
    "image": "mcr.microsoft.com/devcontainers/base:ubuntu",

    "features": {
        "ghcr.io/wrotek/painapple-code/painapple-code:1": {
            "version": "main",
            "port": "8765",
            "instanceName": "CODESPACE",
            "accent": "blue"
        }
    },

    "forwardPorts": [8765],
    "portsAttributes": {
        "8765": {
            "label": "pAInapple Code",
            "onAutoForward": "notify",
            "visibility": "private"
        }
    },

    "secrets": {
        "ANTHROPIC_API_KEY": {
            "description": "Used by the in-container `claude` CLI. Set as a Codespaces user or repo secret."
        }
    },

    "postAttachCommand": "echo 'pAInapple Code UI:' && grep -m1 'Log in once via' /tmp/painapple-code.log 2>/dev/null || echo '  (starting — tail /tmp/painapple-code.log)'"
}
```

## What the Feature does

The Feature installs system dependencies, Node 20 and the `@anthropic-ai/claude-code` CLI (skipped if a sibling Feature already provides them), clones pAInapple Code at the requested ref into `/opt/painapple-code`, and sets up a Python venv. It also:

- Sets `PAINAPPLE_CODE_HOME=/var/painapple-code` so bridge state survives shell exits.
- Writes an idempotent launcher at `/usr/local/bin/painapple-code-start`.
- Adds an `/etc/profile.d` hook (when `autostart` is on) that starts the bridge on the first interactive shell — Codespaces opens a shell on attach, so this is effectively container-start.
- Optionally installs the `shadow-git` / `shadow-query` helpers and the `shadow-git-helper` agent for the container user.

The launcher logs to `/tmp/painapple-code.log` and serves `/workspaces` as the workspace root by default, so the welcome screen lists every project directory in the container. To pin a single repo, set `PAINAPPLE_WORKSPACE` before the launcher runs:

```jsonc
"containerEnv": {
    "PAINAPPLE_WORKSPACE": "/workspaces/my-repo"
}
```

`PAINAPPLE_PORT` overrides the port at runtime the same way.

## Feature options

| Option | Default | Description |
|--------|---------|-------------|
| `version` | `main` | Git ref to install: branch, tag, or commit SHA (e.g. `v1.0.0`) |
| `repo` | upstream GitHub URL | Repository to install from — override for a fork or mirror |
| `port` | `8765` | Port the bridge listens on (HTTP + WebSocket) |
| `instanceName` | `CODESPACE` | Label shown in the PWA header — useful with multiple codespaces |
| `accent` | `blue` | Accent color preset: `blue`, `green`, `red`, `orange`, `purple`, `cyan` |
| `autostart` | `true` | Start the bridge automatically on container start; disable to launch manually with `painapple-code-start` |
| `installHelpers` | `true` | Install `shadow-git`, `shadow-query`, and the `shadow-git-helper` agent into the container user's home |

Pin a release instead of tracking `main`:

```jsonc
"features": {
    "ghcr.io/wrotek/painapple-code/painapple-code:1": {
        "version": "v1.0.0"
    }
}
```

!!! tip "Multiple codespaces on the same iPad"
    Give each one a distinct `instanceName` and `accent` so the PWA headers and icons tell them apart at a glance.

## Port forwarding

Forward the bridge port in `devcontainer.json` (`"forwardPorts": [8765]`, matching the `port` option). In Codespaces, the **Ports** tab then shows a forwarded URL your browser — including an iPad — can reach.

To log in, you need the bootstrap URL with the password embedded as `?tkn=…`. Inside a Codespace the launcher prints it using the public forwarding domain (`https://<codespace>-8765.<forwarding-domain>/?tkn=…`); grab it from `/tmp/painapple-code.log`, or let the `postAttachCommand` from the example print it whenever you open a terminal. See [First run & login](first-run.md) for how auth works from there.

!!! note "Port visibility"
    Keep the port `private` (the default) — the forwarded URL then also requires your GitHub login on top of the bridge password. Making it public leaves the bridge password as the only gate; read the [security notes](security.md) first.

## Codespaces specifics

- **Authenticate the in-container `claude` CLI** one of two ways: set `ANTHROPIC_API_KEY` as a Codespaces secret (GitHub → Settings → Codespaces → New secret, or per-repo under repo Settings → Secrets → Codespaces), or skip the secret and run `claude login` once in the codespace terminal — the OAuth credential persists for the life of the codespace.
- **First boot takes a few minutes** (the Feature install pulls Python deps and the Claude CLI). Subsequent restarts are fast.
- **Install the PWA** on first visit from your iPad; the auth cookie keeps you logged in on later visits.

### Drop into an already-running Codespace

To try pAInapple Code in a live codespace without touching `devcontainer.json`, run the Feature's install script directly:

```bash
curl -fsSL https://raw.githubusercontent.com/wrotek/painapple-code/main/features/src/painapple-code/install.sh \
    | sudo bash
```

This won't survive a "Rebuild Container" — for persistent installs use the `features` block above.

## The reverse direction: personalized images

The Feature drops pAInapple Code *into your project's* dev container. The Docker install supports the mirror image of that: point `./painapple-docker.sh build --devcontainer PATH` at a `devcontainer.json` full of Features you want (Go, Terraform, AWS CLI, …) and they get baked *onto the pAInapple Code image*. See [Install with Docker / Podman](install-docker.md) and the `examples/personalize/` directory in the repo.

## Next step

Continue to [First run & login](first-run.md) to log in and open your first session.
