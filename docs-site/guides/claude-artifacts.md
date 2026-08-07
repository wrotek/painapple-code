# Skills, commands, agents & plugins

Five manager widgets let you browse, create, and edit every reusable Claude Code artifact — folder-form skills, slash commands, agent definitions, plugins, and text snippets — without leaving the browser.

All five share the same shape: a search box that matches names, descriptions, and body text; scope filter pills with live counts; and expandable cards. The file-backed managers (skills, commands, agents) add a grid/list view toggle, a "this project" switch, and an inline raw-Markdown editor on every editable card. Saves are mtime-guarded — if the file changed on disk since you opened it, the save fails loudly instead of silently clobbering the other edit.

## Scopes: project, personal, plugin

Every artifact lives in one of three scopes, and each widget groups its cards accordingly:

| Scope | Where it lives | Notes |
|-------|----------------|-------|
| **Project** | `<project>/.claude/` (`skills/`, `commands/`, `agents/`) | Ships with the repo; visible to everyone who clones it |
| **Personal** | `~/.claude/` | Follows you across projects on this server |
| **Plugin** | Installed [plugins](#plugins-manager) | Read-only — edit by duplicating into project or personal scope |

The **this project** toggle hides everything except project-scope artifacts, and the pills filter one scope at a time. Right-click any card for a context menu with **Copy path**, **Duplicate to Project / Personal** (also how you make an editable copy of a read-only plugin artifact), and **Delete** where the file is editable.

## Invoking artifacts from chat

Each artifact type has a trigger character in the message box:

- `/` at the start of the input — **commands and skills**, autocompleted from the whole catalog. Skills are invoked as `/skill-name` too.
- `#` — **snippets and agents**. Selecting a snippet inserts its text; selecting an agent inserts an invocation phrase.
- `$` anywhere in the prompt — **skills picker**, which inserts the skill's `/slash-name` invocation into your sentence.

The pickers, their keyboard behavior, and the `@` file picker are covered in [Writing prompts & commands](input-and-commands.md); the full command catalog is in the [command reference](../reference/commands.md).

## Skills manager

Open with ++alt+k++. Lists folder-form skills — directories containing a `SKILL.md` — from all three scopes.

Each card shows the skill's `/name`, its description, and meta chips: tool count (from the `allowed-tools` frontmatter), supporting-file count, and the invocation mode (*auto + manual*, *manual only*, *auto only*, or *disabled*). Badges mark plugin skills, read-only files, and skills that run in a forked subagent (`context: fork`). A ⚠ marker appears on a skill that is shadowed by another skill with the same name in a higher-priority scope.

Click a card to expand the inline editor for the raw `SKILL.md` — **Save** stays disabled until you change something, and **Open in full editor** hands the file to the file-preview widget for a proper CodeMirror session. Plugin skills open the same view read-only.

**New Skill** opens a creation dialog: pick a scope (project or personal), a name (lowercase letters, numbers, hyphens — it becomes the `/slash-command`), a description ("Claude uses this to decide when to auto-invoke"), and a starting template:

- **Blank** — empty `SKILL.md`
- **Task workflow** — manual-invocation workflow with numbered steps
- **Reference content** — standing conventions Claude auto-applies
- **Subagent fork** — runs in an isolated Explore subagent
- **Visual output** — bundles a script that generates visual output

The header has two extra buttons: a wrench that jumps to the [Plugins manager](#plugins-manager) and a refresh that re-scans the disk.

## Commands manager

Open with ++alt+shift+k++. This is the full slash-command catalog — everything the `/` picker can complete — grouped into five origins:

- **Built-in (Claude CLI)** — the CLI's own commands plus the bridge's client-side commands (`/help`, `/fork`, …). Read-only.
- **Project** — legacy single-file commands at `.claude/commands/<name>.md` in the project.
- **Personal** — the same, in `~/.claude/commands/`.
- **Plugin** — commands shipped by installed plugins. Read-only.
- **Custom (saved on this device)** — prompt and shell commands you saved in the browser. Shown here read-only; they are managed where you created them.

Project and personal command files get the same inline editor as skills. Right-click an editable file command for two extra actions: **Upgrade to skill folder**, which converts the flat `.md` into a folder-form skill (it then moves to the Skills manager), and **Delete**.

!!! note "Commands vs. skills"
    Flat `commands/<name>.md` files are the legacy single-file format; folder-form skills with a `SKILL.md` are the richer replacement (frontmatter, supporting files, invocation modes). The two widgets split along exactly that line, and "Upgrade to skill folder" is the migration path.

## Agents manager

No default shortcut — open it from the command palette (++ctrl+shift+p++ / ++cmd+shift+p++, search "agents") or the quick-actions menu. It manages agent *definition* files: flat `<name>.md` files in `.claude/agents/` (project) and `~/.claude/agents/` (personal).

Cards show the agent's description plus chips for its tool list and model (both from frontmatter), with the same shadowing marker as skills. The inline editor, creation dialog, duplicate/delete context-menu actions all work like the Skills manager; creation templates are **Blank**, **Researcher** (read-only research), **Reviewer** (code review with severity-grouped findings), and **Implementer** (makes a change and verifies it).

Two agent-specific extras:

- **Eye toggle** — each card has an eye button that hides the agent from the `#` picker's suggestions (and shows it again). Handy for agents Claude should be able to use but you never invoke by hand.
- **Invocation pattern** — a collapsible settings section at the top sets the phrase inserted when you pick an agent from `#`. Default: `Consult with agent {agent}`, with `{agent}` as the name placeholder.

!!! note "Not the Sub-agents widget"
    The separate **Sub-agents** widget is a *runtime* monitor of Task-tool sub-agents spawned during the current session — see [Cost analytics & history](analytics-and-history.md). This widget manages the definition files those agents are built from.

## Plugins manager

No default shortcut — open it from the Skills manager's header, the command palette, or quick actions. It browses the Claude Code plugin marketplace and manages what's installed, shelling out to the `claude plugins` CLI under the hood.

Filter pills split the list into **All / Installed / Available / Enabled / Disabled**. Each card shows the plugin's status badge, description (click to un-clamp), source marketplace, install count, author, and a breakdown of what it ships — skills, agents, commands, hooks, MCP servers. The buttons on the card do the work: **Install** for available plugins; **Enable/Disable** and **Uninstall** for installed ones.

Plugins are the install unit; their components are not. Once a plugin is installed, its skills, agents, and commands appear automatically in the other managers (marked with a plugin badge, read-only).

## Snippets

No default shortcut — open it from the command palette or quick actions, or via the **Edit** link in the `#` picker itself. Snippets are reusable text fragments inserted by typing `#` in chat; they are stored server-side, so they follow you across browsers and devices.

Each row shows the snippet's name, its `#name` trigger, and a preview of the text, with four actions: **insert into chat**, **send now** (inserts and sends in one click), **edit**, and **delete** — plus the same eye toggle as agents to hide a snippet from `#` suggestions without deleting it. Drag the handle on the left to reorder; the `#` picker follows your order. Click anywhere else on a row to edit it.

A snippet is just a name and an optional text body — if you leave the text empty, the name itself is what gets inserted.
