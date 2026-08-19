# HTTP & WebSocket API

A practical scripting reference for pAInapple Code's HTTP endpoints and WebSocket protocols.

## Authentication for scripts

Every endpoint requires a credential. The public allowlist is exactly `/login`, `/api/login`, `/api/logout`, `/health`, `/sw.js`, `/manifest.json`, `/static/css/login.css`, and anything under the `/instance-icons/` prefix. **All `OPTIONS` requests** also bypass auth, so CORS preflight works.

Scripts authenticate with the **API token**, not the password. Both live in `~/.config/painapple-code/config.yaml`:

```bash
# Liveness check — no auth required
curl http://localhost:8765/health

# Authenticated request — credential on stdin, never in argv
TOKEN=$(awk '/^api_token:/ {print $2}' ~/.config/painapple-code/config.yaml)
printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" |
    curl -sS --config - http://localhost:8765/api/welcome/projects
```

!!! info "Why a token and not the password"
    `api_token` is derived from your password, so it is not a second secret to
    manage — but it is **not** the password: it can't open the login form, and
    leaking it doesn't leak the credential everything else derives from. It's
    also revocable on its own — bump `bearer_epoch` in the same file and every
    script token and `?tkn=` link dies while browsers stay logged in. The
    password is never accepted as a Bearer credential or in `?tkn=`.

    The server writes `api_token` on start, so a config from an older build
    gets one the first time you launch the new version.

### Revoking credentials

`POST /api/auth/revoke` with `{"scope": "browsers"}` or `{"scope": "scripts"}` invalidates one class of credential and leaves the other alone:

```bash
printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" |
    curl -sS --config - -X POST http://localhost:8765/api/auth/revoke \
        -H 'Content-Type: application/json' --data '{"scope":"scripts"}'
# {"ok":true,"scope":"scripts","cookie_epoch":1,"bearer_epoch":2}
```

| Scope | Kills | Keeps working |
|-------|-------|---------------|
| `browsers` | every `bridge_auth` cookie | scripts, `?tkn=` links |
| `scripts` | every `api_token` (Bearer + `?tkn=`) | logged-in browsers |

Neither touches the password — rotating that resets everything. The change is written to the config and applied immediately, with no restart. Note that `scripts` revokes the very token that called it, so the response is the last thing that token does. A second instance sharing the same config file keeps its in-memory credentials until it restarts.

!!! warning "Don't put the password in `-H`"
    `curl -H "Authorization: Bearer $TOKEN"` places the secret in the process
    command line, and `ps` shows that to **every user on the machine** unless
    `/proc` is mounted with `hidepid`. That's a wider exposure than the `0600`
    config file the password came from. `--config -` reads the same header from
    stdin, so it never reaches argv. The same applies to any tool you script
    against this API.

Browsers use the `bridge_auth` cookie or a one-time `?tkn=<api_token>` query parameter instead; the `Authorization` header is the HTTP-only path meant for scripts. See [First run & login](../getting-started/first-run.md).

!!! warning "`?tkn=` won't work for writes — use Bearer in scripts"
    `POST`, `PUT`, `DELETE` and `PATCH` requests authenticated by an **ambient** credential (the cookie or `?tkn=`) must also pass the [Origin/CSRF gate](server-cli.md#origincsrf-boundary), or they're rejected with `403 {"error":"origin_forbidden"}`. `curl` sends no `Origin`/`Sec-Fetch-Site`, so `curl -X POST '…?tkn=…'` fails while the identical `GET` succeeds. `Authorization: Bearer` sets its credential explicitly and is exempt from the gate — that's the header scripts should use.

## Endpoint groups

Not exhaustive — a map of where things live, with representative routes.

| Group | Prefix | Examples |
|-------|--------|----------|
| Chat | `ws://…/chat` | Main Claude WebSocket (see [protocol](#websocket-chat-protocol)) |
| Terminal | `ws://…/ws/terminal` | PTY WebSocket; also `GET /api/terminals`, `DELETE /api/terminal/{id}`, `GET /api/active-sessions` |
| Sessions | `/api/sessions`, `/api/session/{id}` | CRUD, `POST /api/session/{id}/fork`, `PUT /api/session/{id}/permission-mode`, `PUT /api/session/{id}/provider`, `GET /api/session/{id}/threads` |
| Engines | `/api/providers`, `/api/bridge/engine-*` | `GET /api/providers` (engine catalog + capabilities), `GET/PUT /api/bridge/engine-path/{name}`, `…/engine-auth/{name}`, `…/engine-models/{name}`, `…/engine-defaults/{name}`, `PUT /api/bridge/default-provider` |
| Logs | `/api/sessions/{id}/logs` | `…/logs/messages`, `…/logs/raw`, `…/logs/tools`, `GET /api/sessions/{id}/changes` |
| Files | `/api/files`, `/api/file` | Directory listing (`GET /api/files?path=…`), `GET /api/file?path=…`, `POST /api/file/write` |
| Search | `/api/search` | `GET /api/search?…` — project-wide content search (ripgrep, with a Python fallback) |
| Drafts | `/api/drafts` | `GET`/`POST /api/drafts`, `PUT`/`DELETE /api/drafts/{draft_id}`, `DELETE /api/drafts` (clear all) — saved prompt drafts |
| Git | `/api/git` | Status, diff, log, show |
| Server | `/api/bridge` | `GET/POST /api/bridge/tabs`, `GET /api/bridge/presets`, `GET/PUT /api/bridge/config`, `GET /api/info` |
| Project config | `/api/project` | `GET/PUT /api/project/config`, `POST /api/project/rename` |
| Stash | `/api/session/{id}/stash` | GET/POST/DELETE stash items; `GET /api/favorites` |
| Welcome | `/api/welcome` | `GET /api/welcome/sessions`, `POST /api/welcome/search`, `GET /api/welcome/projects` |
| Shadow git | `/api/shadow` | Branches, log, undo, restore, search, file timelines |
| Shadow DB | `/api/shadow-db`, `/api/turns` | Turn queries, tags, stats, [raw SQL](#shadow-db-sql) |
| Prompts | `/api/prompts` | Prompt search, recent, frequent, stats |
| Costs | `/api/costs` | Summary, per-session, per-tool, trends |
| Tasks | `/api/tasks` | `GET /api/tasks`, `GET /api/tasks/{task_id}` (background task output) |
| Commands | `/api/commands` | Slash-command catalog |
| Agents | `/api/agents` | Agent templates |
| Plugins | `/api/plugins` | Plugin discovery |
| Skills | `/api/skills` | Skill catalog |
| Exec | `/api/exec` | `POST /api/exec` with JSON body `{"command": …, "cwd": …}` — shell execution (powers [bang commands](commands.md#bang-commands)) |
| Upload | `/api/upload-image`, `/api/upload-file` | Image and file uploads |
| Viewer | `/view`, `/api/file-raw` | Raw file serving and the file-viewer page |
| Browser | `/api/browser` | `…/render`, `…/proxy` — local HTML rendering + external URL proxy |

## WebSocket chat protocol

Connect to `ws://…/chat` with query parameters:

| Param | Meaning |
|-------|---------|
| `session` | Server-side session ID to join or resume an existing session |
| `cwd` | Working directory (used when creating a new session) |
| `provider` | [Engine](../guides/engines.md) to bind a **new** session to (`claude-sdk`, `claude`, `codex`, `codex-app-server`). Ignored once a session is bound |

Sessions are bound to session IDs, not connections — reconnecting to a running session resumes its output stream.

### Client → server

| Type | Payload |
|------|---------|
| `user_message` | `{"type": "user_message", "content": "prompt", "images": [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "…"}}]}` — `images` optional |
| `ping` | Keepalive; server replies `pong` |
| `stop` | Interrupt the running turn (see below — not always a kill) |
| `clear_session` | Archive and reset the session |
| `tool_answer` | Answer to an `AskUserQuestion` tool prompt |
| `permission_response` | `{"type": "permission_response", "request_id": "…", "behavior": "allow" or "deny", "updated_input": {…}}` — answers a `permission_request`. `updated_input` (optional) replaces the tool's arguments; `suggestion_index` (int, optional) picks an "always allow" rule from the request's `suggestions` |
| `set_permission_mode` | `{"type": "set_permission_mode", "mode": "acceptEdits"}` — see below |

**`stop` interrupts; it only kills on some engines.** On a provider with `live_controls` (`claude-sdk`, the default), the server aborts the turn over the control plane and **keeps the process warm** — the next message skips the respawn and `--resume` cost, and the aborted turn still emits its `result` frame, so cost and tokens are recorded. Line-protocol providers get the old path: `SIGINT`, then `SIGKILL` after 5s. A failed graceful interrupt falls through to `SIGINT` too, so a wedged engine never survives Stop.

**`set_permission_mode` applies live on `claude-sdk`.** The reply (`permission_mode_changed`) carries an `applied` field: `"live"` means the running engine switched in place, effective immediately even mid-turn; `"next_turn"` means the idle process will be respawned on your next message. Every other provider — and any nacked or timed-out control request — reports `next_turn`. One exception on `claude-sdk`: a process *launched* in `bypassPermissions` has no approval gate attached, so switching **out** of bypass always takes the respawn path.

### Server → client

| Type | Meaning |
|------|---------|
| `connected` | Handshake — `session_id`, `cwd`, `home`, `workspace`, `is_reconnect`, `agent_running`, `is_compacting`, plus the engine-identity block: `provider`, `provider_display_name`, `provider_caps` (the full capabilities object), `provider_locked` |
| `agent_message` | Wraps provider-neutral Claude-shaped JSON (`system` / `assistant` / `user` / `result`) in `data` |
| `raw_output` | Unparsed subprocess output line |
| `stderr` | Subprocess stderr / server error text |
| `message_stored` | **Broadcast** to every attached client: `{message, line}`, the stored prompt. This is the frame clients render — `line` gives the stable sid `{session_id}:{line}` used for dedup |
| `user_message_stored` | Sent **only to the socket that sent the prompt**: `{promptId, isFavorite}` (plus `verifiedFiles` when the prompt referenced files) — the favorite-button ack, not the render path |
| `permission_request` | An interactive approve/deny ask, blocking the engine until you answer with `permission_response`. Carries `request_id`, `tool_name`, the tool input, optional `suggestions`, and `replay: true` when re-sent to a reconnecting client |
| `permission_resolved` | **Broadcast** when any client answers: `{request_id, behavior, ok}`. `ok: false` means the request expired (process restarted) — peer tabs retire the card either way |
| `stopped` | Turn interrupted after a `stop` request |
| `session_cleared` | Session reset after `clear_session` |
| `permission_mode_changed` | Echo of a `set_permission_mode` request — includes `applied: "live"` or `"next_turn"` |
| `compact_progress` | Progress while a compaction runs (also the turn heartbeat through silent windows; `is_compacting` distinguishes the two) |
| `session_ended` | Claude process exited (`reason` included) |
| `error` | Anything else that went wrong |
| `pong` | Reply to `ping` |

`provider_locked` reports whether the session's engine can still be switched — it locks permanently after the first turn. `connected` is also where a reconnecting client picks state back up: any permission ask the engine is still blocked on is replayed immediately after the handshake.

## Terminal WebSocket

Connect to `ws://…/ws/terminal?session=<id>&cwd=<path>`:

- **Client → server:** raw keystrokes as text (or binary), plus two JSON control messages: `{"type": "resize", "rows": 40, "cols": 120}` and `{"type": "ping"}`.
- **Server → client:** raw ANSI terminal output, **interleaved with JSON control frames** (see below).

The control frames are sent as JSON text on the same socket as the PTY bytes:

| Frame | Meaning |
|-------|---------|
| `{"type": "connected", "session", "cwd", "home", "pid", "has_scrollback"}` | First frame after the handshake. `has_scrollback` tells you a replay of buffered output follows |
| `{"type": "exit", "code": N}` | The shell process exited |
| `{"type": "heartbeat"}` | Periodic liveness ping from the server |
| `{"type": "pong"}` | Reply to a client `ping` |

!!! warning "Don't treat every frame as terminal bytes"
    A client that writes each incoming message straight into the emulator will paint the raw JSON into the buffer. Parse text frames that start with `{` as JSON first, and fall back to terminal output only when they aren't one of the control types above.

Each session gets its own persistent PTY that survives disconnects; `cwd` is only used when the session has no stored working directory.

## Shadow DB SQL

`POST /api/shadow-db/sql` runs ad-hoc read-only SQL against the [shadow DuckDB](../guides/shadow-git.md) of turns, costs, and tags.

- **Body:** raw SQL (`Content-Type: text/plain`) or `{"sql": "…"}` JSON.
- **Format:** default JSON `{columns, rows, count}`; `?format=tsv` returns tab-separated text with a header row.
- **Read-only:** a validator rejects mutation keywords (INSERT, UPDATE, DROP, ATTACH, …) and file-access functions.

```bash
shadow-query() {
  printf 'header = "Authorization: Bearer %s"\n' \
    "$(awk '/^api_token:/ {print $2}' ~/.config/painapple-code/config.yaml)" |
  curl -sS --config - -X POST "${BRIDGE_URL:-http://localhost:8765}/api/shadow-db/sql?format=tsv" \
    -H "Content-Type: text/plain" --data-binary "$1"
}

shadow-query 'SELECT started_at, user_prompt[:80], cost, model FROM turns ORDER BY started_at DESC LIMIT 10'
```

Drop `?format=tsv` for JSON output that pipes cleanly into `jq`.

!!! warning "Every value comes back as a string"
    Both formats stringify the whole result set — a number arrives as `"1.42"`, not `1.42`, and `NULL` arrives as `""`, not `null`. So `jq` comparisons and arithmetic need an explicit cast: `jq '.rows[] | select((.[2]|tonumber) > 1)'`, not `select(.[2] > 1)`. Do the aggregation in SQL where you can — `SUM`/`AVG`/`ORDER BY` run on the real types inside DuckDB.
