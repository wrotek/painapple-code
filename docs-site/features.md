# Features overview

Everything pAInapple Code and the web client can do, in one place. Each area links to its guide.

## Chat & sessions

| Feature | What it does | Guide |
|---|---|---|
| Multi-session tabs | Several concurrent sessions in browser-style tabs; terminals and file previews can sit in the same tab strip | [Sessions & tabs](guides/sessions.md) |
| AI engines | Pick Claude Code or OpenAI Codex per session — per-engine models, permission vocabularies, effort scales, defaults, and in-app CLI login | [AI engines](guides/engines.md) |
| Session setup panel | One-tap engine / model / permissions / effort / account pills on every fresh session, gone after the first message | [AI engines](guides/engines.md) |
| Streaming chat | Live-rendered markdown, collapsible tool and thinking blocks, syntax highlighting, per-block line-wrap toggle, clickable file references | [Sessions & tabs](guides/sessions.md) |
| Per-turn summary bar | Context usage, token delta, files changed, tools used, duration, cost, and model after every turn | [Sessions & tabs](guides/sessions.md) |
| Reconnect & resume | Claude keeps running when the tab disconnects; page refresh reattaches; resume any session in the CLI with `claude --resume` | [Sessions & tabs](guides/sessions.md) |
| Quick switcher & command palette | Fuzzy-jump between sessions, files, and actions from the keyboard | [Sessions & tabs](guides/sessions.md) |
| Welcome screen | Recent-session cards with journal metadata, session families, search, favorites, CLI session import | [Welcome screen](guides/welcome-screen.md) |
| Session forks & threads | Fork a session, clone it, or graduate a discussion thread into a full tab | [Sessions & tabs](guides/sessions.md) |

## Input

| Feature | What it does | Guide |
|---|---|---|
| Pickers | `@` files, `#` snippets & agents, `/` commands, `$` skills — all from the chat input | [Writing prompts & commands](guides/input-and-commands.md) |
| Slash commands | Built-ins plus your own prompt-template and shell-template commands | [Slash & bang commands](reference/commands.md) |
| Bang commands | `!git status` runs locally, shows as a tool block, and rides along as context for your next prompt | [Slash & bang commands](reference/commands.md) |
| Draft autosave | In-progress messages persist per session across refreshes | [Writing prompts & commands](guides/input-and-commands.md) |
| Uploads & annotation | Paste/drag images and files; draw markers, arrows, and text on screenshots before sending | [Images & annotation](guides/images-and-annotation.md) |
| Permission modes | Plan / Ask / Don't Ask / Accept Edits / Auto / YOLO, per session — Codex sessions get sandbox tiers instead | [Permission modes & thinking](guides/permissions-and-thinking.md) |
| Thinking & effort | Extended-thinking budgets and effort cycling, per session | [Permission modes & thinking](guides/permissions-and-thinking.md) |

## Tool widgets

| Feature | What it does | Guide |
|---|---|---|
| Terminal | Real PTY (xterm.js), persistent, floating or docked, mobile keyboard bar and touch d-pad | [Embedded terminal](guides/terminal.md) |
| File explorer & preview | Tree/list/search/bookmarks views; preview with editing (CodeMirror), markdown quick-edit, CSV, images, Excalidraw, Vega-Lite charts | [Files, preview & editing](guides/files.md) |
| Search in files | Project-wide content search (ripgrep-backed, VS Code-style) — regex, globs, click-through to the exact line | [Files, preview & editing](guides/files.md#search-in-files) |
| Browser widget | Renders local HTML or proxies external URLs in a sandboxed iframe | [Files, preview & editing](guides/files.md) |
| Git widget & diff viewer | Status, history, side-by-side diffs, compare wizard, review workflow | [Git & diff viewer](guides/git-and-diffs.md) |
| Skills / commands / agents / plugins / snippets managers | Browse and edit Claude Code artifacts from the UI | [Skills, commands, agents & plugins](guides/claude-artifacts.md) |
| Zen mode | OLED focus overlay with Chat, Map, Review, and Act views *(experimental)* | [Zen mode](guides/zen-mode.md) |

## History & analytics

| Feature | What it does | Guide |
|---|---|---|
| Shadow Git auto-journal | Every turn committed to a parallel git repo with a Haiku-generated structured summary | [Shadow Git journal](guides/shadow-git.md) |
| Journal explorer | Timeline, per-file history, tags, decisions, problems, learnings — your development archaeology | [Shadow Git journal](guides/shadow-git.md) |
| Undo & restore | Roll back a turn's file changes or restore any file from any past turn | [Shadow Git journal](guides/shadow-git.md) |
| Cost analytics | Spend per project, session, model, and tool, with daily trends | [Cost analytics & prompt history](guides/analytics-and-history.md) |
| Prompt explorer | Search every prompt across all sessions and projects; favorites; re-run anywhere | [Cost analytics & prompt history](guides/analytics-and-history.md) |
| Turn database | Every turn recorded in DuckDB; read-only SQL endpoint for your own queries | [HTTP & WebSocket API](reference/api.md) |

## Collaboration with Claude

| Feature | What it does | Guide |
|---|---|---|
| Comments stash | Select text in a response, add a note, and it attaches to your next prompt as context | [Comments stash & discussions](guides/stash-and-discussions.md) |
| Discussion threads | Fork an instant side-session about selected text without derailing the main conversation | [Comments stash & discussions](guides/stash-and-discussions.md) |
| Chat search & navigator | Find-in-conversation and jump between your prompts | [Comments stash & discussions](guides/stash-and-discussions.md) |

## Platform

| Feature | What it does | Guide |
|---|---|---|
| Server platforms | Runs natively on Linux, macOS, and Windows 10/11 — no WSL. The terminal uses ConPTY on Windows | [Requirements](getting-started/requirements.md) |
| PWA | Installable on iPadOS, iOS, Android, and desktop; offline fallback; per-instance icons | [iPad & mobile](guides/ipad-and-mobile.md) |
| Touch UX | Swipe tab switching, long-press menus, selection bubbles, keyboard extension bar | [iPad & mobile](guides/ipad-and-mobile.md) |
| Customization | Layout density, font size, shortcuts editor, quick-actions radial menu, tool collapse modes | [Customization](guides/customization.md) |
| Keyboard-first | Nearly everything has a shortcut; the **?** button in the bottom-left corner (or `/help`) opens live help | [Keyboard shortcuts](reference/keyboard-shortcuts.md) |
| Multi-instance | Named instances with accent colors (DEV/STABLE/…), serve profiles with fully isolated state, docker sandbox profiles | [Server CLI & environment](reference/server-cli.md) |
| Auth | Single-password gate with cookie, query-token, and bearer paths | [First run & login](getting-started/first-run.md) |
