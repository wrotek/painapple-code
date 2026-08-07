# Slash & bang commands

Everything you can type into the message input that isn't a plain prompt: built-in `/` commands, your own custom commands, Claude CLI command passthrough, and `!` shell commands.

## Built-in slash commands

These are handled entirely by the web client — they never reach Claude as a prompt.

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
| `/login` | Sign in to Anthropic — opens an interactive terminal |
| `/logout` | Sign out of Anthropic — opens an interactive terminal |

## Resolution order

When you send something starting with `/`, the client resolves it in three steps:

1. **Built-in commands** (the table above) — highest priority.
2. **Custom commands** from your command store; a project-scoped command beats a global one with the same name.
3. **Claude CLI passthrough** — anything else starting with `/` is sent to Claude as a regular message, so CLI-side commands (built-ins like `/cost`, plus your own from `~/.claude/commands/`) work unchanged.

The `/` autocomplete popup lists all three groups in the same priority order, with duplicates shadowed by the higher-priority definition.

## Custom commands

You can define your own slash commands, stored per browser (localStorage). Two types:

| Type | What it does |
|------|--------------|
| **Prompt** | Expands a prompt template and sends it to Claude |
| **Shell** | Expands a command template and runs it via `/api/exec` (same machinery as [bang commands](#bang-commands)) |

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

Commands are **global** (all projects) or **project**-scoped (only when the session's working directory matches). Project commands take priority over a global command with the same name. The command store also supports JSON export/import for backing up or sharing definitions — duplicates are skipped on merge.

### Prebuilt templates

The client ships starter templates you can use as-is or adapt:

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
    The Commands panel (++alt+shift+k++) lists every command visible to the session — app built-ins, project and personal CLI commands, plugin commands, and your custom commands — but custom commands appear read-only there. Custom-command definitions live in the browser's command store.

## Bang commands

Prefix a line with `!` to run a shell command directly, without asking Claude:

```
!git status
```

- Runs via `POST /api/exec` in the **session's working directory**.
- Output appears in the chat as a collapsible tool block (truncated at 3,000 characters); a non-zero exit code is flagged.
- The output is also **buffered as context for your next prompt** — run a few commands, then type a normal message and Claude receives the commands and their output along with it. The input placeholder shows how many commands are buffered.
- Your last 10 bang commands are kept as a **recent-shell history**, offered as autocomplete when you type `!`.

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

Four trigger characters open inline pickers; ++tab++ in an empty input cycles through them so you can browse without committing:

| Trigger | Picker |
|---------|--------|
| `#` | Snippets & agents |
| `/` | Commands |
| `@` | Files (mention a file path) |
| `$` | Skills |

See [Writing prompts & commands](../guides/input-and-commands.md) for the full input walkthrough.
