# Data storage & logs

Everything the bridge writes lives in two directories — data under `~/.painapple-code/`, credentials under `~/.config/painapple-code/` — never inside your project folders.

## Data directory: `~/.painapple-code/`

Override with `PAINAPPLE_CODE_HOME`. The Docker image sets it to `/data` (a named volume by default).

```
~/.painapple-code/
├── config.json              # Global settings
├── tab-state.json           # Open tabs + active tab (server-side, survives PWA quirks)
├── shortcuts.json           # Keyboard-shortcut overrides
├── favorites.json           # Favorited sessions
├── prompt-favorites.json    # Favorited prompts
├── presets/                 # Prompt/config presets (one JSON per preset)
├── shadow.duckdb            # Turn metadata database (DuckDB, + .wal sidecar)
├── logs/                    # Server logs (auto-rotating, see below)
└── projects/
    └── {hash}/              # 12-char SHA256 of the resolved project path
        ├── path             # Original project path (reverse lookup)
        ├── config.json      # Project-specific settings
        ├── sessions/
        │   └── {id}/
        │       ├── meta.json      # Session metadata (~350 bytes)
        │       ├── messages.jsonl # Parsed conversation + cost (append-only)
        │       ├── raw.jsonl      # Raw Claude I/O (debugging/audit)
        │       ├── tools/         # Large tool outputs (Read_xxx.txt, Bash_xxx.txt, …)
        │       ├── stash.json     # Comments-stash items
        │       └── uploads/       # Uploaded images/files
        └── shadow-git/      # Per-project shadow git repository (auto-journal)
```

Notes:

- **One project per path.** The `{hash}` is derived from the absolute project path, so two clones of the same repo at different paths are separate projects.
- **UI-state files are per-tier.** With `--state-suffix dev`, the top-level state files become `tab-state-dev.json`, `presets-dev/`, and so on; project and session history stays shared. See the [Server CLI reference](server-cli.md).
- **Uploads before a session exists** land in `uploads/tmp/` at the top level.

## What the shadow journal captures

`projects/{hash}/shadow-git/` is a private git repository that powers the timeline, undo, and per-file history. After each turn the bridge commits your **entire working tree — including files git itself doesn't track** — into that repo. Your project directory is never modified; the repo lives entirely under `~/.painapple-code/`.

It skips a default exclude set:

```
.git/  node_modules/  .venv/  venv/  __pycache__/  .npm/  .cache/
dist/  build/  out/  *.egg-info/
.env  .env.*  *.local
*.log  logs/
.idea/  .vscode/  *.swp  .DS_Store  Thumbs.db
*.img  *.qcow2  *.vmdk  *.iso  *.dmg  (and similar disk images)
```

…plus anything larger than 50 MB (`shadow_git.max_file_size_mb`; `0` disables the cap).

!!! warning "Secrets outside the exclude list get copied"
    A credential file that doesn't match those patterns — `credentials.json`, `secrets.yaml`, a stray `*.pem` — is committed into the shadow repo and stays in its history, even if you later delete it from the project. Before pointing the bridge at a directory holding production keys, either add those paths to `projects/{hash}/shadow-git/info/exclude` or turn the journal off for that project in **Settings → Auto-journal**.

Auto-journal also makes a small background model call after each turn (Haiku by default) to write the summaries and commit messages — real API usage, disabled in the same panel.

## Config directory: `~/.config/painapple-code/`

Override with `PAINAPPLE_CODE_CONFIG`. Kept separate so credentials survive wiping the data directory.

| Path | Purpose |
|------|---------|
| `config.yaml` | Auth password — owner-only (mode `0600`, parent `0700`; an equivalent NTFS ACL on Windows) |
| `tokens/` | Optional token-profile files (alternate API credentials selectable per session) |
| `cert.pem`, `key.pem` | Auto-generated self-signed TLS cert/key (when TLS is enabled) |
| `fingerprint` | Cert fingerprint sidecar (only with `--tls-fp-url`) |

## Log files

All in `~/.painapple-code/logs/` (override with `--log-dir`):

| File | Content | Rotation |
|------|---------|----------|
| `server.log` | All events, INFO and up | 10 MB, 5 backups |
| `access.log` | HTTP/WebSocket requests with timing | 10 MB, 3 backups |
| `error.log` | Errors with tracebacks | 5 MB, 10 backups |
| `crash.log` | Redirected stderr — uvicorn errors, unhandled exceptions | Append-only, no rotation |
| `server.pid` | PID of the running server (for post-mortem analysis) | Removed on clean exit |

```bash
cat ~/.painapple-code/logs/error.log
tail -f ~/.painapple-code/logs/access.log
```

## Docker

In the container, `PAINAPPLE_CODE_HOME=/data` and `/data` is a named volume (or a bind mount, depending on your `DATA_VOLUME` setting). To copy the volume out to the host:

```bash
painapple extract NAME ./painapple-data-export
```

See [Profiles & container mode](profiles.md).

## Backup, cleanup, and wipe

```bash
# Back up everything (sessions, journal, DB, settings)
tar czf painapple-backup.tgz -C ~ .painapple-code

# Find which project a hash belongs to
cat ~/.painapple-code/projects/{hash}/path

# Remove one project's history (sessions + shadow git)
rm -rf ~/.painapple-code/projects/{hash}

# Full wipe — auth config survives (it lives in ~/.config/painapple-code/)
rm -rf ~/.painapple-code
```

!!! warning "Stop the server before touching `shadow.duckdb`"
    DuckDB is single-writer and keeps a `.wal` sidecar. Back up or move the database only while the bridge is stopped, and copy the `.wal` file together with it.

Uninstalling the package removes neither directory — `pip uninstall` leaves `~/.painapple-code/` and `~/.config/painapple-code/` in place, so the two `rm -rf` lines above are the full cleanup. If you installed the [optional helpers](optional-helpers.md), `install-helpers.sh --uninstall` removes the two scripts from `~/.local/bin/` and the agent file from `~/.claude/agents/`. Nothing else on the system is touched: the bridge installs no service units, edits no shell rc files, and sends no telemetry — the only outbound request it makes on its own is the browser widget fetching a URL you asked it to open.

## Resuming sessions in the plain CLI

Sessions created through the bridge are regular Claude Code sessions. The provider session ID is stored in each session's `meta.json` (`provider_session_id`), and you can pick any conversation up from a terminal:

```bash
claude --resume <session-id>
```
