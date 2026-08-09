# Optional helpers

Three small helpers ship with the package to make the [Shadow Git journal](../guides/shadow-git.md) usable from a terminal and from Claude itself: two CLIs and one agent template.

| Helper | Installed to | What it does |
|--------|--------------|--------------|
| `shadow-git` | `~/.local/bin/shadow-git` | Git wrapper for the per-project shadow repositories — log, show, diff, blame, plus project/session listing and full-text search |
| `shadow-query` | `~/.local/bin/shadow-query` | Runs read-only SQL against the shadow DuckDB via the server's `/api/shadow-db/sql` endpoint (handles auth and formatting) |
| `shadow-git-helper` | `~/.claude/agents/shadow-git-helper.md` | Claude Code agent template — a "code archaeologist" that knows how to search the shadow repo |

All targets are user-scoped: no `sudo`, no `$PATH` edits, no shell-rc changes. The agent invokes the CLI via its absolute path (`~/.local/bin/shadow-git`), so it works the same in Docker, VMs, Codespaces, and WSL. The Docker image installs all three at build time.

!!! note "On native Windows"
    `shadow-git` and `shadow-query` are bash scripts, so they are **not** installed on native Windows — copying them there would just put unrunnable files on disk. Only the `shadow-git-helper` agent installs, which is the part that matters in `#` autocomplete; the Settings panel marks the other two unsupported rather than nagging that they're out of date. Run them from WSL or a Git Bash shell if you want the CLIs themselves.

## Installing

### From the UI

The status bar shows an auto-journal pill when helpers are missing or outdated — click it to open the **helpers-install widget** (the auto-journal control center). It shows per-file install/freshness state, installs or updates all three with one click (`POST /api/bridge/helpers/install`, which runs the install script server-side), and also holds the per-project journal toggles.

### From the script

On a host install, run the bundled script yourself (path shown for a repo checkout; on a pip install it lives in the installed package's `tools/` directory):

```bash
src/painapple_code/tools/install-helpers.sh             # install (skip files already present)
src/painapple_code/tools/install-helpers.sh --update    # overwrite with the packaged version (alias: --force)
src/painapple_code/tools/install-helpers.sh --uninstall # remove installed files
src/painapple_code/tools/install-helpers.sh --dry-run   # preview without changing anything
```

The server tracks freshness by content hash (`GET /api/bridge/helpers/status`), so after an upgrade the UI pill reappears when the installed copies are stale.

## `shadow-git`

Wraps `git` pointed at the current project's shadow repository (`~/.painapple-code/projects/{hash}/shadow-git/`). Any git command passes through; a few extras are built in:

```bash
shadow-git log --oneline -20        # last 20 journal commits
shadow-git log --grep="auth"        # search commit messages
shadow-git log -- src/app.js        # history of one file
shadow-git show HEAD~2              # inspect a commit
shadow-git diff HEAD~3..HEAD        # compare changes

shadow-git projects                 # all projects that have a shadow repo
shadow-git sessions                 # sessions in the current project
shadow-git branches                 # shadow branches with commit counts
shadow-git search <pattern>         # full-text search across all commits
shadow-git snapshot [msg]           # commit a baseline of all files
```

Project detection uses the current directory; override with `SHADOW_PROJECT=/path/to/project`.

## `shadow-query`

Sends SQL to the server's read-only DuckDB endpoint (the server owns the database's write lock, so all reads go through HTTP):

```bash
shadow-query 'SELECT count(*) FROM turns'
shadow-query 'SELECT id, cost FROM turns ORDER BY cost DESC LIMIT 5'
shadow-query --json 'SELECT * FROM turns LIMIT 1' | jq
shadow-query - <<'EOF'
  SELECT date_trunc('day', started_at) AS day, count(*) AS n
  FROM turns GROUP BY day ORDER BY day DESC LIMIT 7
EOF
```

| Variable | Purpose |
|----------|---------|
| `BRIDGE_URL` | Server base URL (default `http://localhost:8765`) |
| `BRIDGE_PASSWORD` | Auth token override; otherwise read from `~/.config/painapple-code/config.yaml` |

Output is TSV by default, JSON with `--json`. The endpoint rejects anything that isn't a read (no INSERT/UPDATE/DDL).

## `shadow-git-helper` agent

A Claude Code agent template installed into `~/.claude/agents/`, giving every Claude session (pAInapple Code or plain CLI) a specialist for code archaeology: file history, changes by session, blame analysis, tracing when and why code changed.

Use it by delegating from a normal prompt:

> Consult with shadow-git-helper about when the auth middleware last changed and why.

Claude spawns the sub-agent, which digs through the shadow repo with the `shadow-git` CLI and reports back — keeping your main thread focused on the task instead of filling it with research output.
