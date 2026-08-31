# AI providers (Claude & Codex)

Every session runs on an **provider** — the AI CLI pAInapple Code drives under the hood. The default is Claude Code via the official Agent SDK, but pAInapple Code can also drive the **OpenAI Codex CLI**, and you pick per session: a Claude tab and a Codex tab can sit side by side in the same strip, each with its own models, permission vocabulary, and effort scale.

!!! warning "The Codex path is experimental"
    Codex support is **newer and has had less testing** than the Claude path — it works, but expect rougher edges. Claude Code via the Agent SDK is the default and the well-trodden route.

## The providers

| Provider | What it is |
|--------|-----------|
| **Claude Code** | Claude Code via the Agent SDK — interactive permission cards, live mode/model switching mid-turn. The default. |
| **Codex** | OpenAI Codex over its persistent app-server protocol — native forking, server-reported context window, graceful interrupt. |

Earlier releases also shipped two "plain CLI" fallback drivers (line-protocol `claude -p`, and Codex `exec` mode — one process per turn). Both were removed: the SDK and app-server drivers supersede them on every axis, and the Codex `exec` mode had a real downside — it could only take the prompt as a command-line argument, which made prompts readable in the process list by other accounts on the same machine. Sessions created on the old drivers keep working; they resume on the matching current provider automatically. Enable or hide providers in **Settings → Providers**.

!!! note "What Codex needs"
    The Codex provider requires the [Codex CLI](https://github.com/openai/codex) (`@openai/codex`) installed on the *server* and logged in. A provider whose CLI is missing shows up greyed-out with a hint; a CLI that isn't logged in gets a **Log in** button right in Settings (see [below](#logging-in)). The Docker image doesn't bundle Codex, but it doesn't need to: the entrypoint installs it on first start alongside the Claude CLI, onto the `/data` volume. Override the set with `PAINAPPLE_AGENT_CLIS`, or skip it entirely with `PAINAPPLE_SKIP_AGENT_CLI=1`. See [container mode](../getting-started/install-docker.md).

## Picking a provider per session

Provider choice happens **in chat**, while a session is still fresh:

- **Session setup panel** — every new session (project picked, nothing sent yet) shows a card of one-tap pill rows directly above the input: **provider, model, permissions, effort, account**. Tap through your setup and start typing; the panel disappears with your first message.
- **Status-bar provider chip** — the provider name in the status bar opens the same picker at any time before the first message.

A session **locks to its provider with the first message** — the conversation history lives with that CLI. Picking a different provider on a locked session doesn't fail, though: it opens a **clone tab** in the same working directory running the provider you picked. **Clone** (++cmd+n++) also inherits the source session's provider.

The **default provider** for new sessions is set with the **Make default** button in Settings → Providers (or the `--default-provider` flag / `default_provider` config key — the flag pins the choice and hides the button).

## What changes with the provider

Each provider self-describes its capabilities, and the UI follows:

- **Models** — the model picker shows the *active provider's* catalog. Claude's comes from the server's editable `models.yaml`; Codex's mirrors the Codex CLI's own model list (so it updates when Codex does). Per-provider default models are configured in Settings → Providers.
- **Permission modes** — the Claude provider speaks Claude's modes (Plan / Ask / Don't Ask / Accept Edits / Auto / YOLO — see [Permission modes](permissions-and-thinking.md)); the Codex provider maps to Codex **sandbox tiers**: Read-only, Workspace write, and Full access.
- **Effort** — the effort gauge renders each provider's own scale. Claude has five levels (low → max); Codex levels come from its model catalog and can reach `xhigh` / `ultra` on recent models, with the picker narrowing to what the selected model supports.
- **Cost** — Codex reports tokens only, no dollar figure, so the `$` cost readouts hide on Codex sessions and the turn bar shows token counts.
- **Continue in the CLI** — the **Continue in CLI** quick action is provider-aware: a Claude session gives you `claude -r <id>`, a Codex session `codex exec resume <id>`.
- **Auto-journal** — the [Shadow Git journal](shadow-git.md) fork always runs on the session's own provider (only the owner of a conversation can fork it), and each provider has its own journal-summarizer model setting.

## Settings → Providers

**Settings → Providers** (++ctrl+comma++) is the control room:

- **Providers list** — a toggle per provider (the default provider is forced on), and a **Make default** button on every other available provider. Disabling a provider hides it from pickers; sessions already bound to it keep working.
- **One sub-tab per enabled provider**, all with the same layout:
    - **CLI status** — the resolved binary path and live `--version`, plus a path-override field per provider CLI.
    - <a id="logging-in"></a>**Login status** — whether the CLI is authenticated ("Logged in — email · plan" for Claude, exit status for Codex). When it isn't, a **Log in** button opens a terminal tab running the provider's login flow; the row polls and flips green when you finish. Codex uses device-code auth (`codex login --device-auth`) so the flow works even when the server is remote.
    - **Model catalog** — every model with a show/hide toggle (hidden models disappear from all pickers). Claude's catalog is fully editable (add/edit/delete, restore defaults); Codex's is read-only because the Codex CLI owns it.
    - **New Session Defaults** — that provider's default model, default effort (its own vocabulary), and default account/token profile where applicable.
    - **Auto-journal model** — which model writes the [Shadow Git](shadow-git.md) summaries for sessions on this provider.

## Related

- [Permission modes & thinking](permissions-and-thinking.md) — what the modes and effort levels mean.
- [Sessions & tabs](sessions.md) — cloning, forking, and continuing sessions in the CLI.
- [Server CLI](../reference/server-cli.md) — `--default-provider` and config keys.
