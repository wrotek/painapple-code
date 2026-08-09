# Requirements

Here's what you need before installing pAInapple Code, and a frank note on what the tool is — and isn't.

## What you need

Running the bridge directly on a host (pip / pipx / source checkout):

- **Python 3.12+**
- **[Claude Code CLI](https://github.com/anthropics/claude-code)** installed and authenticated — either a Claude subscription (`claude login`) or an Anthropic API key
- **Network access between client and server** — any modern browser works as a client
- *Optional:* the **[OpenAI Codex CLI](https://github.com/openai/codex)** if you want sessions on the Codex [engine](../guides/engines.md) — you can even log it in from inside the app

!!! tip "Docker skips most of this"
    The [Docker / Podman path](install-docker.md) is the recommended install. The image ships Python 3.13 and Node 20, and installs the Claude Code and Codex CLIs itself on first start — so the only host requirement is a container runtime.

### Client devices

The desktop browser is the primary target, but the UI is mobile-friendly and installable as a PWA on iOS and Android. A large part of this app was developed from an iPad with a hardware keyboard.

## What it is, and what it isn't

**It is** a thin wrapper around Claude Code — every prompt streams through the official **Agent SDK** (the classic `claude -p` line protocol is available as an alternate engine). Sessions you create here can be resumed in the regular CLI with `claude --resume <id>`.

**It is not** an AI agent of its own. It does not modify your prompts, inject planning steps, parallelize work, or change Claude's behavior. The one exception is the optional `shadow-git-helper` agent, which knows how to query the Shadow Git history.

**It is not yet an easy "develop from anywhere" mobile setup.** Working from a phone or tablet as a PWA is entirely possible, but you have to wire up the networking yourself. By default the server listens on `127.0.0.1`; you can change that with `--host x.x.x.x`, or via `painapple setup` (the network step applies to `--in-docker` and docker-mode profiles too). In the default auto-TLS mode, non-loopback interfaces get a self-signed certificate, which some mobile browsers handle poorly.

!!! tip "Recommended network setup"
    Keep the server listening on `127.0.0.1` and put a reverse proxy (Caddy, for example) in front of it for TLS, exposed only on a trusted interface — your home network or a personal VPN.

## Next step

Before installing anything, read the [security notes](security.md) — this is an MVP built around permissive permission modes, and you should understand the trade-offs first.
