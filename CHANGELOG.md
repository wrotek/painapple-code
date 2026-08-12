# Changelog

All notable changes to this project are documented in this file. It is
hand-curated at release time; the auto-generated notes on each
[GitHub Release](https://github.com/wrotek/painapple-code/releases) are the
raw per-tag feed.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [SemVer](https://semver.org/); the git tag is the single
source of truth for the version (PyPI wheel, Docker image, and
`__version__` all derive from it).

## [Unreleased]

### Security
- The startup box no longer prints the password / `?tkn=` login URL on
  non-loopback binds by default — a LAN or containerized server's stdout
  ends up in journald / `docker logs`, which outlive the terminal. Loopback
  binds keep printing (it's the onboarding step). New `--show-password`
  opts a non-loopback bind back in; `--no-password` still forces hiding
  anywhere; `painapple password` reveals credentials either way.

### Added
- CI now runs the security regression suite (~390 in-process tests) on every
  push and PR, plus a `pip-audit` dependency scan and Dependabot updates.
- Welcome screen search auto-selects the first result while typing.
- Community docs: CONTRIBUTING (with DCO), Code of Conduct, this changelog,
  and a bug-report issue form.

### Fixed
- Focus returns to the selection's origin widget when the comment bar
  closes.

## 1.0.0 release candidates — `v1.0.0-rc1` … `v1.0.0-rc34` (2026)

The first public release series, published to
[PyPI](https://pypi.org/project/painapple-code/) and
[Docker Hub](https://hub.docker.com/r/wrotek/painapple-code) from tag pushes.
Condensed highlights of what the RC era delivered:

- **The bridge itself** — FastAPI WebSocket server driving Claude Code in
  streaming-JSON mode; sessions bound to IDs (not sockets), multi-client
  broadcast, auto-reconnect, stale-session recovery, live permission-mode
  and model switching on the SDK driver.
- **Web/PWA client** — installable on iPad/desktop, multi-session tabs with
  server-side tab-state persistence, terminal (PTY), file browser & preview,
  git panel, cost analytics, comments stash, discussion forks, paste-to-
  annotate screenshots, keyboard extension bar.
- **Multi-engine providers** — pluggable provider seam with Claude
  (SDK + line-protocol) and OpenAI Codex (exec + app-server) drivers,
  per-engine model catalogs, defaults, permission vocabularies, and effort
  levels.
- **Journaling** — every turn recorded as a shadow-git commit with
  AI-generated summaries plus a queryable DuckDB turn store (tags, costs,
  tools, files touched) and a read-only SQL endpoint.
- **Deployment** — unified `painapple` CLI (serve, profiles, lifecycle,
  fleet view), Docker/Podman as a run mode with UID alignment, a Dev
  Container Feature, TLS auto-provisioning on non-loopback binds.
- **Hardening** — password gate on every endpoint (cookie / `?tkn=` /
  Bearer), CSRF/Origin fail-closed checks, login rate-limiting, CSP,
  DOMPurify-sanitized rendering, path-traversal fixes, short-lived signed
  download tokens, `SECURITY.md` threat model.
- **Windows** — native port (validated on ARM64) with CI smoke tests; WSL2
  recommended for the risk-averse.
