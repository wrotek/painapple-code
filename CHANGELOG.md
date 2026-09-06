# Changelog

Notable changes are documented here per release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/), and the git tag is the single source of truth for the version (the PyPI wheel, the Docker image tag, and `__version__` all derive from it).

## Unreleased

Also ships everything listed under **1.0.5** below — that tag was cut but never published.

### Added

- Long option descriptions in AskUserQuestion cards are shown in full instead of being clipped.

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
