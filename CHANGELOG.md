# Changelog

Notable changes are documented here per release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/), and the git tag is the single source of truth for the version (the PyPI wheel, the Docker image tag, and `__version__` all derive from it).

## 1.1.6 — 2026-10-02

### Fixed

- A message sent while a Codex `/compact` is running now waits and runs once the compaction finishes (as it does on Claude), instead of failing with "ActiveTurnNotSteerable … Failed to send message". Pressing Stop discards the waiting message.
- Default permission modes are now kept per provider: choosing **Set as default** on a Codex tab (e.g. Full access) saves it as Codex's default and new Codex sessions open with it, instead of always falling back to Workspace write. Claude keeps its own default. Each provider's default is also editable under Settings → Providers → New Session Defaults; an existing app-wide default carries over to the providers that support it.

## 1.1.5 — 2026-10-01

### Fixed

- `/compact` in a Codex session now actually compacts the conversation (with the usual "Conversation compacted" marker) instead of being sent to the model as a prompt. Codex's own automatic compactions now show up in the chat too.

## 1.1.4 — 2026-10-01

### Fixed

- Codex sessions get rich turn summaries and auto-generated session titles again on newer Codex CLIs (0.159+); the summary fork was being rejected, leaving only the raw journal. Summary-fork failures are now logged as warnings instead of disappearing.
- Markdown links to local files in chat — `[name](/abs/path/file.md)`, `./x.md`, `file://…`, optionally with `#L12` / `:12` line targets — open the file preview instead of navigating the browser to a dead server URL.

## 1.1.3 — 2026-10-01

### Fixed

- Codex sessions now ask for MCP tool approvals with the same in-chat permission card Claude sessions use — Allow / Deny, plus "always allow" for this session or for good. Previously Codex rejected every MCP tool call that needed approval (anything not marked read-only).
- Switching a Codex session's permission mode (e.g. to Full access, the equivalent of `codex --yolo`) now takes effect for the existing conversation; before, a resumed Codex thread kept the sandbox it was started with, even across server restarts.
- Failed `!` bang commands show the stderr explaining the failure instead of a bare "Exit code: N", and output written to both stdout and stderr is no longer cut down to stdout.

## 1.1.2 — 2026-09-30

### Added

- `pbcopy` in the built-in terminal on Linux and macOS servers: `git diff | pbcopy` copies to the clipboard of the device you're using (via OSC 52, so it needs Settings → Terminal → "Terminal apps may write to clipboard"; inside tmux also `set -g allow-passthrough on`). A server's native `pbcopy` still takes priority.

### Changed

- Claude Sonnet 5.5 replaces Sonnet 5 in the model catalog, and is the new default model for the shadow-git-helper subagent.

## 1.1.1 — 2026-09-23

### Added

- Claude Opus 5.5 (1M context) in the model catalog, replacing Opus 4.8.

### Fixed

- Fresh installs show the real app icon — in the browser tab, on the login page and as the installed PWA/home-screen icon — instead of a generic "P" tile, and the service worker no longer fails to install from the login page.
- `painapple setup` no longer forces a container-runtime choice: a **Skip** option (the default when nothing is configured yet) leaves the runtime and image untouched, and an existing custom runtime path is kept on Enter.

## 1.1.0 — 2026-09-08

Also ships everything listed under **1.0.5** below — that tag was cut but never published.

### Added

- Long option descriptions in AskUserQuestion cards no longer get silently clipped: a clamped description gets a **Show more** / **Show less** toggle, and the option you chose is shown in full on the answered card.

## 1.0.5 — 2026-09-05 (tagged, never published)

CI failed on the tag — a test pinned a model id the catalog change below had just removed — so no PyPI, Docker Hub or GitHub Release artifacts exist for 1.0.5. The tag stays; its changes ship in the next release.

### Added

- Turns now credit files that Claude edits or reads **through Bash** (`sed -i`, heredocs, `tee`, `mv`, …), not only through the Edit/Write/Read tools: the file pills, the Shadow DB `turn_files` table, recent-files ranking and the per-session `/changes` rescan all see them. The staged diff at commit time is used as a final catch-all for anything else that touched the tree (generators, `npm install`).

### Changed

- Model catalog: Fable 5 replaced by Fable 5.1.

### Fixed

- The self-signed TLS certificate now lists the actual bind address in its SAN, so browsers connecting by IP stop rejecting it.

## 1.0.4 — 2026-08-31

### Added

- Every container start logs the image version it is running (`org.opencontainers.image.version`), so a stuck `:latest` is never silent.
- "Port already in use" now offers a concrete free `--port` and a ready-made named profile; `painapple setup` no longer defaults to a port that is taken.

### Fixed

- `--project` / `--no-project` now also steer the mount mode picked by `--in-docker`.
- Raw `docker run` examples in the docs use the right scheme and pass `--tls off` explicitly; Podman example adds the missing `mkdir`.

## 1.0.3 — 2026-08-31

### Added

- `--project` / `--no-project` workspace mode with `.git` auto-detect: serve one repository as a single pickable project rather than as the workspace root.

### Fixed

- A wrong bind host is reported as such instead of masquerading as "port already in use".
- The annotate button in the image pan-zoom toolbar was rendered at the wrong size.

## 1.0.2 — 2026-08-31

### Changed

- "Engines" are now called **Providers** everywhere: Settings tab, status-bar chip, session setup panel, and the HTTP API — `/api/engines*` moved to `/api/providers*` and the `engine` fields/query parameters are now `provider`. Saved sessions and configs keep working.
- Slash-command autocomplete descriptions clamp to two lines and expand on hover/selection; the full text is available in the tooltip.

### Fixed

- Autocomplete descriptions no longer paint over the command name on long entries.
- Descriptions of skills embedded in the Claude CLI are extracted correctly when the name and description keys are not adjacent.
- A stale `fetchAgentCommands` call on the connected frame was removed.

## 1.0.1 — 2026-08-31

### Removed

- The two "plain CLI" fallback drivers: the `claude` line-protocol driver (superseded by the wire-identical `claude-sdk` provider) and the `codex` exec driver (`codex exec --json` had no stdin protocol — every prompt rode argv, readable via `ps` by any local account; see SECURITY.md). Saved configs keep working: the legacy provider names alias to `claude-sdk` and `codex-app-server`, and old Codex exec sessions resume natively through the same `$CODEX_HOME` thread store.

### Fixed

- Docs: TLS opt-in now points at the `[tls]` extra instead of a hardcoded dependency pin.

## 1.0.0 — 2026-08-26

First public release.
