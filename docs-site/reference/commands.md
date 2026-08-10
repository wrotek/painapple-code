# Slash & bang commands

Everything you can type into the message input that isn't a plain prompt: built-in `/` commands, your own custom commands, Claude CLI command passthrough, and `!` shell commands.

## Built-in slash commands

The web client intercepts these instead of sending them as a plain prompt. Most are pure client actions, but four of them do end up sending text to the engine: `/compact` forwards the literal `/compact [instructions]` string, `/fork-compact` forwards it into the newly forked session, `/plan <text>` sends your text as a normal (plan-mode) prompt, and `/btw <question>` sends the question into a forked discussion thread. The rest never reach the engine at all.

| Command | Description |
|---------|-------------|
| `/help` | Show help and keyboard shortcuts |
| `/clear` | Archive the session and start fresh in the same project |
| `/compact [instructions]` | Ask Claude to summarize the conversation (optional focus instructions) |
| `/new` | Create a new session |
| `/fork` | Fork the session — branch the conversation |
| `/fork-compact [instructions]` | Fork the session, then compact the copy (branch + summarize) |
| `/clone [text]` | Clone the session (same project, fresh chat); add text to send it immediately |
| `/plan [text]` | Enter plan mode — explore and design before coding (see [input modes](#input-modes)) |
| `/btw [question]` | Side question — fork a quick discussion thread without selecting text |
| `/login` | Sign in to the **session's engine** — opens an interactive terminal |
| `/logout` | Sign out of Anthropic — opens an interactive terminal |

`/login` is engine-aware: it asks the registry for the active engine's own `login_command`, so on a Codex session it runs `codex login --device-auth`, and it only falls back to `claude auth login` when no engine is resolved. `/logout` is **not** — it always runs `claude auth logout`. Both need the embedded terminal, so on a server with no PTY backend (Windows without `pywinpty`) they show a toast telling you to run the command in your own console instead.

## Resolution order

When you send something starting with `/`, the client resolves it in three steps:

1. **Built-in commands** (the table above) — highest priority.
2. **Custom commands** from your command store; a project-scoped command beats a global one with the same name.
3. **Claude CLI passthrough** — anything else starting with `/` is sent to Claude as a regular message, so CLI-side commands (built-ins like `/cost`, plus your own from `~/.claude/commands/`) work unchanged.

The `/` autocomplete popup lists all three groups in the same priority order, with duplicates shadowed by the higher-priority definition.

## Custom commands

!!! warning "No in-app editor yet"
    Custom commands **resolve and run**, but there is currently no UI (and no import/export) for creating or editing them. Definitions live in the browser's `claude-code-custom-commands` localStorage key, and the only way to add one today is to write that key yourself. The Commands panel says as much when you open a custom command: *"Custom commands are managed in localStorage. Edit support coming soon."*

Custom slash commands are stored per browser (localStorage). Two types:

| Type | What it does |
|------|--------------|
| **Prompt** | Expands a prompt template and sends it to Claude |
| **Shell** | Expands a command template and runs it via `/api/exec` (same machinery as [bang commands](#bang-commands)) |

If you want project- or user-scoped commands you can actually manage, use the Claude CLI's own — files in `.claude/commands/` or `~/.claude/commands/`. Those reach you through [CLI passthrough](#resolution-order), show up in the `/` popup, and are editable in the Commands panel.

### Template variables

Both types support `{variable}` placeholders, expanded at run time:

| Variable | Expands to |
|----------|-----------|
| `{input}` | Everything you typed after the command name |
| `{cwd}` | The session's working directory |
| `{session}` | The session ID |
| `{date}` | Current date (`YYYY-MM-DD`) |
| `{time}` | Current time (`HH:MM`, 24-hour) |
| `{timestamp}` | Full ISO 8601 timestamp |

### Scope

Commands are **global** (all projects) or **project**-scoped (only when the session's working directory matches). Project commands take priority over a global command with the same name.

### Starter templates (defined in code, not yet surfaced)

A set of starter definitions ships in the client's command store, ready for the editor that doesn't exist yet. **Nothing in the UI offers them today** — they're listed here only so you know what's coming, and what shape a hand-written localStorage entry takes:

| Command | Type | Description |
|---------|------|-------------|
| `/explain` | Prompt | Explain code or a concept (`{input}`) |
| `/review` | Prompt | Code review for bugs, performance, security, style |
| `/test` | Prompt | Generate unit tests using the project's framework |
| `/fix` | Prompt | Fix an issue and explain the change |
| `/doc` | Prompt | Generate documentation with parameters and examples |
| `/simplify` | Prompt | Simplify code while preserving behavior |
| `/status` | Shell | `git status` |
| `/diff` | Shell | `git diff` |
| `/log` | Shell | `git log --oneline -10` |
| `/branches` | Shell | `git branch -a` |

!!! note
    The Commands panel (++alt+shift+k++) lists every command visible to the session — app built-ins, project and personal CLI commands, plugin commands, and your custom commands. CLI commands are fully editable there (edit, delete, upgrade to a skill); app built-ins and custom commands are read-only.

## Bang commands

Prefix a line with `!` to run a shell command directly, without asking Claude:

```
!git status
```

- Runs via `POST /api/exec` in the **session's working directory**.
- Output appears in the chat as a collapsible tool block (truncated at 3,000 characters); a non-zero exit code is flagged.
- The output is also **buffered as context for your next prompt** — run a few commands, then type a normal message and Claude receives the commands and their output along with it. The input placeholder shows how many commands are buffered.
- **30-second timeout.** A command that runs longer is killed and the request comes back `408`. For anything long-running, use the [embedded terminal](../guides/terminal.md) instead.
- Your last 10 bang commands are kept as a **recent-shell history**, offered as autocomplete when you type `!`. Before you've run anything, that list is seeded with five canned entries (`git status`, `git diff`, `ls -la`, `npm test`, `npm run build`) — they're placeholders, not commands the app ran.

!!! warning "`!` is not your login shell"
    On Linux and macOS bang commands run through `/bin/sh`, **not** `$SHELL`. The embedded terminal spawns `$SHELL` instead, so the two genuinely differ: if your interactive shell is fish or zsh, your aliases, functions, and shell-specific syntax are unavailable to `!` even though they work one tab over in the terminal. Write POSIX `sh` in bang commands. (On Windows both use PowerShell, so there's no divergence there.)

!!! danger
    Bang commands execute as the user running the server, with no permission gate. See [security](../getting-started/security.md).

## Input modes

Two prefixes switch the input into a dedicated compose mode (the input is restyled and the prefix is hidden while you type):

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Shell** | Type `!` at the start | Everything you type is treated as a shell command |
| **Plan** | Type `/plan ` at the start | The permission UI flips to plan mode; your text is sent as a planning prompt. A bare `/plan` just switches the session to plan permissions |

Press ++backspace++ on an empty input to exit the mode.

## Pickers

Four trigger characters open inline pickers:

| Trigger | Picker |
|---------|--------|
| `#` | Snippets & agents |
| `/` | Commands |
| `@` | Files (mention a file path) |
| `$` | Skills |

++tab++ cycles through them **at any cursor position**, not just in an empty input — it inserts the next trigger character right where you are (prefixed with a space if the preceding character isn't whitespace), so you can pull up the file picker mid-sentence. ++shift+tab++ cycles backwards, and ++escape++ cancels the cycle and removes the character it inserted. Typing anything else ends the cycle but leaves the trigger in place, so it keeps working as a normal trigger.

See [Writing prompts & commands](../guides/input-and-commands.md) for the full input walkthrough.
