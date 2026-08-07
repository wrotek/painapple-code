# Security Policy

## Deployment security model — read this first

painapple-code is a **single-user** bridge that runs Claude Code (and other
CLI agents) on your behalf. **Anyone who can authenticate to the server gains
the full shell and filesystem authority of the OS user the server runs as** —
it can read and write that user's files and execute arbitrary commands
(`/api/exec`, the terminal, and any agent tool). Treat the password like an
SSH key.

Because of that:

- The server binds to **loopback (`127.0.0.1`) by default**. Keep it there.
- For remote access, put it behind a **VPN, SSH tunnel, or an authenticating
  reverse proxy** — do not expose it directly to the internet or a shared LAN.
- It is **not hardened for untrusted multi-user hosting.** Do not run one
  instance shared between people who should not have each other's shell
  access. Run separate instances as separate OS users instead.
- Prefer a **dedicated unprivileged user**, minimal bind mounts, and no Docker
  socket when containerized.

## Supported versions

This project is pre-1.0 (Beta). Security fixes land on the latest released
version only; there are no long-term support branches yet.

| Version | Supported |
|---------|-----------|
| Latest release (`:latest` / newest PyPI) | ✅ |
| Older releases | ❌ — upgrade to the latest |

## Reporting a vulnerability

**Please report privately — do not open a public issue for security bugs.**

- Preferred: **GitHub private vulnerability reporting** — the *Report a
  vulnerability* button under the repository's **Security** tab
  (`https://github.com/wrotek/painapple-code/security/advisories/new`).
- This opens a private advisory thread visible only to the maintainer and you.

Please include: affected version/commit, deployment mode (host / Docker / Dev
Container Feature), reproduction steps or a proof of concept, and the impact
you observed.

## Scope

In scope: the bridge server, its HTTP/WebSocket API, the web client, the
packaging/release artifacts (PyPI wheel/sdist, Docker image, Dev Container
Feature).

Out of scope: vulnerabilities in Claude Code itself or other third-party CLI
agents (report those to their vendors); issues that require an attacker to
already hold the server's password or OS-user shell (that is the documented
authority model above, not a privilege boundary); and native/Tauri desktop
builds, which are development-only and not a supported release surface.
