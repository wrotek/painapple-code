# pAInapple Code

A self-hosted UI for [Claude Code](https://github.com/anthropics/claude-code) — a Python server that runs the CLI as a subprocess and serves a vanilla-JS web client on top, over a WebSocket chat stream and a REST API. Every turn is recorded in the **Auto Journal**: a per-project shadow git repo with structured, searchable summaries written by a background Haiku fork of the conversation. It can drive the [OpenAI Codex CLI](guides/engines.md) too — pick the engine per session.

![The web client with a session on the left and the Auto Journal widget open on the right](assets/overview.png)

The goal is native apps for every platform; today the client is a web app that installs as a PWA on iOS, Android, and desktop. Roughly a third of this app was developed on an iPhone, and the rest on an iPad with a hardware keyboard.

!!! danger "Read the security notes first"
    This is an MVP and it is very YOLO-oriented: the embedded terminal is a real PTY running as the server user, and the best experience comes from permissive Claude permission modes. Run it isolated (Docker, VM) and read [Read this first](getting-started/security.md) before exposing it to anything.

!!! warning "These docs were written by AI — read them with caution"
    Like the rest of this project, the whole documentation site was written by AI (Claude) reading the source code, not by a human writing from experience. It was fact-checked against the code at the time of writing, but it has not been fully human-reviewed, and the code moves faster than the docs do.

    Expect the occasional stale flag, renamed button, or feature described more confidently than it deserves. When something matters — security settings, CLI flags, data locations — trust the [source](https://github.com/wrotek/painapple-code) and `painapple --help` over this site, and please [open an issue](https://github.com/wrotek/painapple-code/issues) when the two disagree.

## What it is — and what it isn't

**It is** a thin wrapper around Claude Code. Every prompt streams through the official **Agent SDK** (the classic `claude -p` line protocol is available as an alternate engine), and sessions you create here can be resumed in the regular CLI with `claude --resume <id>`.

**It is not** an AI agent of its own. It does not modify your prompts, inject planning steps, parallelize work, or change Claude's behavior. The one exception is the optional `shadow-git-helper` agent, which knows how to query the Shadow Git history.

## Get started

<div class="grid cards" markdown>

- **[Install with Docker / Podman](getting-started/install-docker.md)** — the recommended path: isolation included, one command to start.
- **[Install with pip / pipx](getting-started/install-pip.md)** — run directly on your machine if you know what you're doing.
- **[Dev Containers & Codespaces](getting-started/install-devcontainer.md)** — add it to any devcontainer as a Feature.
- **[First run & login](getting-started/first-run.md)** — the generated password, the login URL, and your first session.

</div>

## Highlights

- **[Shadow Git auto-journal](guides/shadow-git.md)** — every turn is committed to a parallel git repo with a Haiku-generated structured summary, searchable forever.
- **[Multi-session tabs](guides/sessions.md)** — several concurrent sessions, browser-style tabs, sessions survive page refresh and network drops.
- **[AI engines](guides/engines.md)** — Claude Code by default, OpenAI Codex when you want it, chosen per session — each with its own models, permission modes, and effort scale.
- **[Embedded terminal](guides/terminal.md)** — a real PTY with xterm.js, persistent across refresh, with a mobile keyboard extension bar.
- **[Comments stash & discussions](guides/stash-and-discussions.md)** — annotate any paragraph of a response and attach it to your next prompt, or fork a side-thread about it.
- **[Cost analytics & prompt history](guides/analytics-and-history.md)** — spend breakdowns per model/tool/session, and full-text search over every prompt you ever sent.
- **[Images & annotation](guides/images-and-annotation.md)** — paste screenshots, draw arrows and markers on them before sending.
- **[Installable PWA](guides/ipad-and-mobile.md)** — works as a standalone app on iPad, iPhone, Android, and desktop.

The full list lives in the [features overview](features.md).
