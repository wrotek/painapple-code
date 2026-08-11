# Read this first

**Whoever can authenticate to pAInapple Code gets the shell and filesystem authority of the OS user that runs it.** It exists to run a coding agent on your behalf — `/api/exec`, the embedded terminal, and every approved tool call execute as that user. Treat the password like an SSH key, and read this page before you run it anywhere that matters.

**This is an MVP, and heavily "vibe-coded".** All of the code was written by AI. I try to keep the security hygiene tight, but I can't promise there isn't an RCE hiding somewhere — one more reason to take the isolation advice below seriously.

## Permissions

The default engine drives Claude through the official **Agent SDK**, and the default permission mode is **Ask**: reads run freely, but every edit and command pauses the turn on an approve/deny card in the chat — with a preview of the edit or command — until you decide. That's the safe out-of-the-box posture. The more permissive modes are opt-in, per session, and they're also where the app is most fun — which is exactly why the isolation advice below matters.

The permission modes on the default engine (configurable per session via the button next to the input):

| Mode | Behavior |
|------|----------|
| **Plan** | Read-only |
| **Ask** *(default)* | Reads auto-allowed; every edit/command waits on an approval card |
| **Don't Ask** | Auto-deny unless pre-approved by your allow rules |
| **Accept Edits** | Auto-approve workspace edits plus in-scope file commands like `cp` or `mv`; ask for the rest |
| **Auto** | Claude's AI classifier gates each tool call |
| **YOLO** | `bypassPermissions` — full access |

Two caveats. First, the approval cards only protect you while you're the one clicking them — in **YOLO** and **Auto** nothing asks, and those are the modes that give Claude the most freedom. Second, the cards exist only on the default SDK engine: the classic line-protocol Claude engine runs headless (`claude -p`), where anything that would ask is auto-denied instead, and Codex engines use their own sandbox tiers. See the [permissions guide](../guides/permissions-and-thinking.md) for the full story, and the [Claude Code permission-modes docs](https://code.claude.com/docs/en/permission-modes#available-modes) for the underlying modes.

## Terminal

!!! danger "The terminal widget is a real shell"
    The terminal widget is a real PTY running as the user that started the server. Any prompt injection or other attack (including a compromised npm package pulled in during a task) can run arbitrary commands as that user.

This risk isn't unique to this project, but it's worth restating the consequences of running non-isolated AI agents that can fetch and execute arbitrary code from the internet — via npm, pip, or even this project itself.

## Isolation

!!! warning "Always run in isolation"
    Run your Claude environment — especially in the permissive modes — inside isolation: Docker, a VM, LXC, BSD jails, or similar. Container mode is built into the CLI: `painapple --in-docker` sandboxes the current directory ad-hoc, and `painapple setup NAME` creates a durable docker-mode profile. See the [Docker setup](install-docker.md) for both.

    On Windows, isolate with Hyper-V or a WSL2 distro, and run the bridge *inside* it — a separate, non-Administrator Windows account is the bare minimum, and Windows Sandbox is too ephemeral to hold a working setup. Note that the CLI's own container mode is **untested on native Windows**: we have never had a Windows host with a working Docker daemon to validate it against, so `--in-docker` and docker-mode profiles are unsupported there. Isolation on Windows means putting the whole thing in a VM, not `--in-docker`.

    **If these concepts are unfamiliar, this MVP is probably not for you yet.**

## Network exposure

By default the server binds `127.0.0.1` over plain HTTP. Bind it to a non-loopback host and it auto-enables TLS with a self-signed certificate (browsers show a one-time certificate warning — see the `--tls` flag).

!!! warning "The password gate is not a firewall"
    Either way, the built-in auth is a single-password gate — adequate on a home network or behind a personal VPN, and not a substitute for proper network controls. **I strongly discourage exposing it on a public interface.** If you must reach it from outside, keep pAInapple Code on loopback and put your own reverse proxy — with real TLS and its own auth — in front.

## Single-user, not multi-tenant

It is **single-user, not multi-tenant**. Don't share one instance between people who shouldn't have each other's shell access; run separate instances as separate OS users instead.

## What it touches on your machine

pAInapple Code runs a coding agent, so it is not a light-touch program. Two defaults are worth knowing before you point it at a directory:

- **Shadow git copies your project into the data home — on by default.** After each turn it commits the whole working tree, *including untracked files*, into a private repo under `~/.painapple-code/`. It skips `.git`, `node_modules`, virtualenvs, build output, logs, `.env` files, and anything over 50 MB — but a secret in a file that *doesn't* match those exclusions (say `credentials.json`) gets copied there and kept in that repo's history.
- **Auto-journal spends tokens in the background — on by default.** After each turn a second, short model call summarizes what happened. It's cheap, but it is real API usage you didn't explicitly trigger.

Both are per-project toggles in the Auto-journal settings. **Nothing phones home** — no telemetry, no update checks, no analytics. Full inventory: [Data storage & logs](../reference/data-storage.md).

## Reporting a vulnerability

**Found one?** Please report it privately — see [`SECURITY.md`](https://github.com/wrotek/painapple-code/blob/main/SECURITY.md) in the repo.
