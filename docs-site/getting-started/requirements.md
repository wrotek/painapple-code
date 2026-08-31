# Requirements

Here's what you need before installing pAInapple Code, and a frank note on what the tool is — and isn't.

## What you need

Running the server directly on a host (pip / pipx / source checkout):

- **Python 3.12+**
- **[Claude Code CLI](https://github.com/anthropics/claude-code)** installed and authenticated — either a Claude subscription (`claude login`) or an Anthropic API key
- **Git** on `PATH` — the [auto-journal](../guides/shadow-git.md) records every turn as a commit in a shadow repository, and the Git panel shells out to it for diffs. Without git the server still runs, but it journals nothing and the Git panel stays empty; you'll get a warning in the log at startup.
- **Network access between client and server** — any modern browser works as a client
- *Optional:* the **[OpenAI Codex CLI](https://github.com/openai/codex)** if you want sessions on the Codex [provider](../guides/providers.md) — you can even log it in from inside the app. **Codex support is experimental** — newer and less exercised than the Claude path.

### Server platforms

pAInapple Code runs natively on all three desktop platforms. No WSL required.

| Platform | Status | Notes |
|---|---|---|
| **Linux** | Fully supported | The primary development and deployment target. |
| **macOS** | Fully supported | Intel and Apple Silicon. On Intel, TLS needs [one extra package](install-pip.md) — `cryptography` is Apple-Silicon-only from 49.0.0. |
| **Windows 10/11** | Fully supported | Native — no WSL required. WSL2 also works: inside the distro it's the Linux build. See the Windows notes below. |

#### Windows notes

- **Install the Claude CLI with the native installer**, not npm: `irm https://claude.ai/install.ps1 | iex`. The Agent SDK that the default provider uses refuses to execute npm's `claude.cmd` shim (batch files are a command-injection vector — the same class as CVE-2024-27980), and will tell you so with a link to this fix. If you already logged in via the npm install, your credentials carry over.
- **Get git from [Git for Windows](https://git-scm.com/download/win)**, which is what `winget install Git.Git` installs too. Besides `git.exe` it ships a `bash.exe`, and the optional `shadow-git` / `shadow-query` [helpers](../reference/optional-helpers.md) are shell scripts that run under it — the installer generates a small `.cmd` wrapper so you can still call them by name from PowerShell. (It deliberately does *not* use `C:\Windows\System32\bash.exe`; that one is the WSL launcher, which would look for your data inside the Linux filesystem.)
- **The terminal tab runs PowerShell** through ConPTY. `pwsh` (PowerShell 7) is preferred when present, otherwise Windows PowerShell; override with `PAINAPPLE_CODE_SHELL`.
- **`!bang` commands are PowerShell-flavored** on Windows, not `sh`.
- **WSL2 is a fully valid alternative, not a fallback** — inside the distro this is simply the Linux build, so use the Linux instructions verbatim, container mode included (native Windows can't run `--in-docker`). Keep projects on the Linux filesystem rather than `/mnt/c/…`, and open the printed `localhost` URL in your Windows browser — WSL2 forwards the port through.
- **File permissions** are enforced with NTFS ACLs (owner-only, applied via `icacls`) rather than POSIX mode bits — see [security](security.md).
- **Windows on ARM** (Surface, Snapdragon X) installs with no extra flags, with two wheel caveats — both handled automatically, neither needing anything from you. The HTTP stack is slightly slower: the optional `httptools` parser publishes no ARM64 wheel, so those machines use uvicorn's pure-Python parser. And TLS is opt-in: `cryptography` stopped publishing ARM64 Windows wheels after 46.0.3, so it isn't installed by default and `--tls` needs one extra package. See [pip install](install-pip.md). Use a **64-bit** Python — `cryptography` dropped 32-bit Windows builds in 49.0.0.
- Data lives in `%USERPROFILE%\.painapple-code` — the same `~/.painapple-code` layout as the other platforms, deliberately, so the docs and support answers match everywhere.

!!! tip "Docker skips most of this"
    Running in a container is the recommended way to start instances on Linux and macOS, and it moves most of this list off your host: the image ships Python 3.13 and Node 20, and installs the Claude Code and Codex CLIs itself on first start. You still install pAInapple Code on the host with pipx — you just add `--in-docker` when you run it — so the host needs Python 3.12+ and a container runtime, and nothing else above. See [container mode](install-docker.md).

    On Windows, use the native install above — container mode is **unsupported** there. It has never been validated against a Docker daemon on a Windows host, so the bind-mount assembly, path translation and credential handling are all unverified. Beyond that it would run the server inside a **Linux** container, bind-mounting your projects across the Windows/Linux boundary, which brings back the path translation, line-ending and file-watching problems that running natively avoids.

### Client devices

The desktop browser is the primary target, but the UI is mobile-friendly and installable as a PWA on iOS and Android. A large part of this app was developed from an iPad with a hardware keyboard.

## What it is, and what it isn't

**It is** a thin wrapper around Claude Code — every prompt streams through the official **Agent SDK** (the classic `claude -p` line protocol is available as an alternate provider). Sessions you create here can be resumed in the regular CLI with `claude --resume <id>`.

**It is not** an AI agent of its own. It never modifies Claude's system prompt, tool policy, or behavior — no injected planning steps, no hidden instructions, no parallelized work. What it *does* add to a prompt is the context **you** attached: the output of `!bang` commands you ran, paths of files you uploaded, and snippets from the comments stash are prepended as plain text. The one other exception is the optional `shadow-git-helper` agent, which knows how to query the Shadow Git history.

**It is not yet an easy "develop from anywhere" mobile setup.** Working from a phone or tablet as a PWA is entirely possible, but you have to wire up the networking yourself. By default the server listens on `127.0.0.1`; you can change that with `--host x.x.x.x`, or via `painapple setup` (the network step applies to `--in-docker` and docker-mode profiles too). In the default auto-TLS mode, non-loopback interfaces get a self-signed certificate, which some mobile browsers handle poorly.

!!! tip "Recommended network setup"
    Keep the server listening on `127.0.0.1` and put a reverse proxy (Caddy, for example) in front of it for TLS, exposed only on a trusted interface — your home network or a personal VPN.

## Next step

Before installing anything, read the [security notes](security.md). Short version: this is an MVP, all of its code was written by AI, and whoever can authenticate gets the shell authority of the user running it — understand that trade-off first.
