# Permission modes & thinking

Two controls next to the message input decide how much rope Claude gets: the **permission mode** button (what it may do without asking) and the **effort** gauge (how hard it thinks). Both are per-session with a global default.

## Permission modes

The colored button beside the input shows the current mode; click it to pick a level, ordered least to most permissive. The list comes from the [engine](engines.md) the session runs on — the default engine (the Claude Code **SDK engine**) offers these six; Codex engines offer their own sandbox tiers instead (Read-only / Workspace write / Full access). The input border takes on the mode's color so you always know which session is armed and which is read-only.

| Mode | What it does |
|------|--------------|
| **Plan** | Read-only — explore and design, no writes |
| **Ask** *(default)* | Reads auto-allowed; every edit and command waits for your approval on a permission card |
| **Don't Ask** | Auto-deny anything not pre-approved by your allow rules |
| **Accept Edits** | Auto-approve edits in the workspace (plus in-scope file commands like `mkdir`/`mv`/`cp`); ask for the rest |
| **Auto** | An AI classifier reviews each tool call — reads and in-project edits sail through, riskier operations get blocked |
| **YOLO** | Skip all permission checks (`bypassPermissions`) |

### Interactive permission cards

On the default SDK engine, any mode that would *ask* pauses the turn on an approve/deny card right in the chat — the elapsed timer freezes, and background tabs get a badge plus a click-to-go toast so you notice the wait from another session. Deny with an optional note back to Claude, or approve. Cards also surface the engine's own **"always allow"** options — allow this exact command in this project, allow a directory, or switch mode — exactly like the CLI's "don't ask again" prompts; pick one and Claude Code persists the rule itself (into your project's `.claude/settings.local.json`, say), so it won't ask again.

The default mode is **Ask** — reads run freely, but every edit and command waits for your approval on a card. Prefer **Accept Edits** to wave edits through and only get carded for commands, **YOLO** or **Auto** to let Claude just work, or **Don't Ask** to auto-deny anything your allow rules don't already cover. **Plan** stays read-only.

!!! note "Other engines"
    Sessions can also run on the classic line-protocol Claude engine or on OpenAI Codex — see [AI engines](engines.md) for picking one per session (or pinning a server-wide default with `--default-provider`). The classic engine drives `claude -p` headless, where there is no interactive prompt: anything that would ask comes back to Claude as a denied tool call — Claude adapts (works around it or tells you what it wanted) — and an **explainer card** appears, *"Claude tried to use Bash (`git push`) but was blocked by Don't Ask permission mode"*, pointing you at the permission button to loosen the mode and retry. On that engine the permissive modes (YOLO, Auto, Accept Edits) are where it shines; Don't Ask and Plan just deny.

!!! note "Auto mode is a research preview"
    Auto maps to the CLI's `--permission-mode auto`, where a classifier model gates each call. It needs a recent CLI and model (Sonnet 4.6+/Opus 4.6+ on the Anthropic API; Team/Enterprise plans need an org owner to enable it). Also, headless auto sessions abort after 3 consecutive classifier blocks (or 20 total) — if Claude keeps getting blocked, the turn ends rather than looping.

!!! warning "Read the security notes before going YOLO"
    YOLO means Claude can run any command as the server user. That is the intended way to use this app — inside an isolated container or VM. See [Read this first](../getting-started/security.md).

### Per-session, with a default

Your chosen mode is saved with the session and restored when you reopen it. On the default SDK engine a mode switch applies **immediately, even mid-turn** — the running engine changes gear in place, so you can flip to Accept Edits while approval cards are stacking up and the rest of the turn follows the new mode (the system log confirms "applied to the running engine"). On the classic line-protocol engine — or whenever the live switch isn't possible — it takes effect on your next message instead, when the server respawns the idle Claude process with the new mode. The **Set as default** button in the popup makes the current mode the global default for new sessions (also editable in Settings).

### Plan mode and plan approval

In **Plan** mode Claude explores read-only and ends with a plan. The plan renders as an interactive approval card — approve it and the session drops out of plan mode to execute; reject it and you stay planning. Tabs show a *Plan ready for review* badge while a plan waits. You can also enter plan mode for a single message by typing `/plan ` in the input — see [input modes](input-and-commands.md#input-modes).

Related: when Claude asks a clarifying question mid-turn (AskUserQuestion), pAInapple Code by default stops it so you can answer — see [When Claude asks you a question](sessions.md#when-claude-asks-you-a-question).

## Effort levels

The circular gauge button next to the input controls Claude's effort — how many thinking tokens it spends — on a five-step scale: **low**, **medium**, **high** (the default), **xhigh**, **max**. The conic fill of the gauge shows the level at a glance (a fifth per step, glowing at max). It maps to the CLI's `--effort` flag. The scale is per-[engine](engines.md): Codex sessions render Codex's own reasoning levels (up to `ultra` on recent models), narrowed to what the selected model supports.

- **Click the gauge** (or ++cmd+apostrophe++ / ++ctrl+apostrophe++) to open the level picker. Like permission modes, effort is per-session, with **Set as default** to change the global fallback.
- **One-shot override:** ++cmd+shift+apostrophe++ / ++ctrl+shift+apostrophe++ arms a temporary level for the *next message only* — first press bumps one level above your persistent setting, further presses cycle through the rest (including below it), and landing back on the persistent level disarms. A badge on the gauge shows the armed level; it clears itself after one send. Perfect for "give this one question the max treatment" without re-configuring.

Changing effort applies on your next message by respawning the idle process (unlike permission mode there's no live-apply here — the engine has no mid-session effort control).

## Token profiles

If you have more than one Claude account (say, a personal Max plan and a work team seat), drop each OAuth token in a plain-text file under `~/.config/painapple-code/tokens/` — the filename becomes the profile name:

```
~/.config/painapple-code/tokens/
├── max      # contents: the OAuth token string
└── work
```

A profile chip then appears in the status bar next to the model name (it's hidden when the directory is empty). Click it to pick which account the *current session* bills to; the server sets `CLAUDE_CODE_OAUTH_TOKEN` accordingly when it spawns Claude. Each session remembers its profile, and a global default is available.

The killer feature: when a turn ends **rate-limited**, the turn summary bar replaces its context bar with a *Switch token:* strip — one tap on another profile and you keep working on the other account's quota.

## Choosing a model

The model name in the status bar is a selector — click it to switch the session's model. The catalog is the session [engine's](engines.md) own: for Claude it comes from the server's `models.yaml` (editable in **Settings → Engines** or by hand), including `[1m]` variants that run the same model with a 1M-token context window; for Codex it mirrors the Codex CLI's model list. A model switch applies from your next message onward, in the same conversation — on the default SDK engine the warm process changes model in place, so there's no respawn pause on your first message with the new model.

Optionally, a server-wide `fallback_model` key in `~/.painapple-code/config.json` names a model to fall back to automatically when the primary is overloaded or unavailable (the CLI's `--fallback-model`) — the turn completes on the fallback instead of dying with an overload error.
