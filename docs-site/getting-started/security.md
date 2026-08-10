# Read this first

pAInapple Code is an MVP and is very YOLO-oriented — read this page before you run it anywhere that matters.

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
    Run your Claude environment — especially a YOLO-oriented one — inside isolation: Docker, a VM, LXC, BSD jails, or similar. On Windows the equivalents are Hyper-V or a WSL2 distro (with Docker Desktop on top if you want the container path); Windows Sandbox is too ephemeral to hold a working setup. A separate, non-Administrator Windows account is the minimum. Container mode is built into the CLI: `painapple --in-docker` sandboxes the current directory ad-hoc, and `painapple setup NAME` creates a durable docker-mode profile. See the [Docker setup](install-docker.md) for both.

    **If these concepts are unfamiliar, this MVP is probably not for you yet.**

## Network exposure

By default the server binds `127.0.0.1` over plain HTTP. Bind it to a non-loopback host and it auto-enables TLS with a self-signed certificate (browsers show a one-time certificate warning — see the `--tls` flag).

!!! warning "The password gate is not a firewall"
    Either way, the built-in auth is a single-password gate — not a substitute for proper network controls. For real public exposure, put the server behind your own reverse proxy and keep pAInapple Code itself on loopback.
