# Optional helpers

Three small helpers ship with the package to make the [Shadow Git journal](../guides/shadow-git.md) usable from a terminal and from Claude itself: two CLIs and one agent template.

| Helper | Installed to | What it does |
|--------|--------------|--------------|
| `shadow-git` | `~/.local/bin/shadow-git` | Git wrapper for the per-project shadow repositories — log, show, diff, blame, plus project/session listing and full-text search |
| `shadow-query` | `~/.local/bin/shadow-query` | Runs read-only SQL against the shadow DuckDB via the server's `/api/shadow-db/sql` endpoint (handles auth and formatting) |
| `shadow-git-helper` | `~/.claude/agents/shadow-git-helper.md` | Claude Code agent template — a "code archaeologist" that knows how to search the shadow repo |

All targets are user-scoped: no `sudo`, no `$PATH` edits, no shell-rc changes. The Docker image installs all three at build time.

!!! warning "You'll likely need the full path — `~/.local/bin` may not be on your `$PATH`"
    The installer creates `~/.local/bin/` and copies the scripts in, but it **never touches your `$PATH`** and doesn't warn you if the directory isn't on it. On many distros it already is; on macOS and plenty of others it isn't, and a bare `shadow-git log` then just reports "command not found".

    The script's closing "no PATH change is needed" line is true for the **agent**, which invokes the CLI by absolute path — not for you at a prompt. That's also why the in-app instructions tell you to run `~/.local/bin/shadow-git log`. Either use the full path, or add the directory yourself:

    ```bash
    export PATH="$HOME/.local/bin:$PATH"   # add to ~/.bashrc / ~/.zshrc / ~/.config/fish/config.fish
    ```

!!! warning "`shadow-git` only looks in `~/.painapple-code` — it breaks in Docker and on profiles"
    `shadow-git` hardcodes its data directory as `$HOME/.painapple-code` and **ignores `$PAINAPPLE_CODE_HOME`**, which is the one thing the server does honour. So anywhere the data home has been relocated, the CLI looks in the wrong place and reports *"No shadow git found"* even though the journal is being written normally:

    - **In the container**, the image sets `PAINAPPLE_CODE_HOME=/data`. No symlink is created, so an in-container `shadow-git log` finds nothing. (`~/.local/bin` isn't on the container's `PATH` either.)
    - **On a host [profile](profiles.md)**, the data home is `~/.painapple-code/profiles/NAME/`, so the same mismatch applies.

    Use the Journal panel or the [`/api/shadow-db/sql` endpoint](api.md#shadow-db-sql) in those setups — `shadow-query` is unaffected, since it talks to the server over HTTP rather than reading the filesystem. The CLI is reliable on a plain, default-home host install.

!!! note "On native Windows"
    `shadow-git` and `shadow-query` are bash scripts, so they need a bash. If the installer finds one — **Git for Windows** counts, and is looked for next to `git.exe` — it installs both scripts *and* generates a small `.cmd` wrapper beside each, which is what lets PowerShell run `shadow-git log` by name. If no bash is found, the two CLIs are skipped (the Settings panel marks them *"Not available here"* rather than nagging that they're out of date) and only the `shadow-git-helper` agent installs — which is the part that matters for `#` autocomplete.

## Installing

### From the UI

The status bar **always** shows an auto-journal pill, so the feature stays discoverable — it just changes label to report state: *Auto-journal* when everything is current, *Helpers outdated*, or *Helpers not installed*. Click it to open the **helpers-install widget** (the auto-journal control center). It shows per-file install/freshness state, installs or updates all three with one click (`POST /api/app/helpers/install`), and also holds the per-project journal toggles.

What *is* conditional is the widget opening by itself: it auto-pops when anything is outdated (always) or missing (unless you've ticked "Don't show again"), and never when everything is current.

!!! warning "The Install button overwrites local edits"
    The UI always installs with `--update`, so clicking **Install**/**Update** replaces the installed copies with the bundled ones — any tweaks you made to `~/.local/bin/shadow-git` are lost. The bare CLI invocation is the safe one: it *skips* files that already exist unless you pass `--update` yourself.

### From the script

On a host install, run the bundled script yourself (path shown for a repo checkout; on a pip install it lives in the installed package's `tools/` directory):

```bash
src/painapple_code/tools/install-helpers.sh             # install (skip files already present)
src/painapple_code/tools/install-helpers.sh --update    # overwrite with the packaged version (alias: --force)
src/painapple_code/tools/install-helpers.sh --uninstall # remove installed files
src/painapple_code/tools/install-helpers.sh --dry-run   # preview without changing anything
src/painapple_code/tools/install-helpers.sh --help      # usage (-h works too)
```

All three scripts take `--help` / `-h`; `shadow-git` also answers a bare `shadow-git help`.

The server tracks freshness by content hash (`GET /api/app/helpers/status`), so after an upgrade the UI pill reappears when the installed copies are stale.

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

Project detection uses the current directory; override with `SHADOW_PROJECT=/path/to/project`. `shadow-git snapshot` skips files larger than 50 MB — raise or lower that with `SHADOW_MAX_FILE_MB` (`0` disables the cap), mirroring the server's own `shadow_git.max_file_size_mb`.

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
| `PAINAPPLE_URL` | Server base URL (default `http://localhost:8765`) |
| `PAINAPPLE_TOKEN` | API token override; otherwise read from `~/.config/painapple-code/config.yaml` |

Output is TSV by default, JSON with `--json`. `--tsv` asks for the default explicitly, and `--format json|tsv` (or `--format=json`) does the same thing if you prefer that spelling. A `-` argument reads the SQL from stdin. The endpoint rejects anything that isn't a read (no INSERT/UPDATE/DDL), and — worth knowing before you pipe into `jq` — [every value comes back as a string](api.md#shadow-db-sql).

## `shadow-git-helper` agent

A Claude Code agent template installed into `~/.claude/agents/`, giving every Claude session (pAInapple Code or plain CLI) a specialist for code archaeology: file history, changes by session, blame analysis, tracing when and why code changed.

Use it by delegating from a normal prompt:

> Consult with shadow-git-helper about when the auth middleware last changed and why.

Claude spawns the sub-agent, which digs through the shadow repo with the `shadow-git` CLI and reports back — keeping your main thread focused on the task instead of filling it with research output.
