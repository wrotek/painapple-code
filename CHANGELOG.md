# Changelog

Notable changes are documented here per release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/), and the git tag is the single source of truth for the version (the PyPI wheel, the Docker image tag, and `__version__` all derive from it).

## 1.0.1 — 2026-08-31

### Removed

- The two "plain CLI" fallback drivers: the `claude` line-protocol driver (superseded by the wire-identical `claude-sdk` provider) and the `codex` exec driver (`codex exec --json` had no stdin protocol — every prompt rode argv, readable via `ps` by any local account; see SECURITY.md). Saved configs keep working: the legacy provider names alias to `claude-sdk` and `codex-app-server`, and old Codex exec sessions resume natively through the same `$CODEX_HOME` thread store.

### Fixed

- Docs: TLS opt-in now points at the `[tls]` extra instead of a hardcoded dependency pin.

## 1.0.0 — 2026-08-26

First public release.
