# HTTP & WebSocket API

A practical scripting reference for pAInapple Code's HTTP endpoints and WebSocket protocols.

## Authentication for scripts

Every endpoint requires the server password except a small public allowlist (`/health`, `/login`, `/sw.js`, and a few login-page assets). For scripts and `curl`, send it as a Bearer token — the password lives in `~/.config/painapple-code/config.yaml`:

```bash
# Liveness check — no auth required
curl http://localhost:8765/health

# Authenticated request
TOKEN=$(awk '/^password:/ {print $2}' ~/.config/painapple-code/config.yaml)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8765/api/welcome/projects
```

Browsers use the `bridge_auth` cookie or a one-time `?tkn=<password>` query parameter instead; the `Authorization` header is the HTTP-only path meant for scripts. See [First run & login](../getting-started/first-run.md).

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

Sessions are bound to session IDs, not connections — reconnecting to a running session resumes its output stream.

### Client → server

| Type | Payload |
|------|---------|
| `user_message` | `{"type": "user_message", "content": "prompt", "images": [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "…"}}]}` — `images` optional |
| `ping` | Keepalive; server replies `pong` |
| `stop` | Kill the running turn |
| `clear_session` | Archive and reset the session |
| `tool_answer` | Answer to an `AskUserQuestion` tool prompt |
| `set_permission_mode` | `{"type": "set_permission_mode", "mode": "acceptEdits"}` — applied on the next turn |

### Server → client

| Type | Meaning |
|------|---------|
| `connected` | Handshake — includes `session_id`, `cwd`, `is_reconnect`, `agent_running` |
| `agent_message` | Wraps provider-neutral Claude-shaped JSON (`system` / `assistant` / `user` / `result`) in `data` |
| `raw_output` | Unparsed subprocess output line |
| `stderr` | Subprocess stderr / server error text |
| `user_message_stored` | Acknowledges your prompt was persisted |
| `stopped` | Turn killed after a `stop` request |
| `session_cleared` | Session reset after `clear_session` |
| `permission_mode_changed` | Echo of a `set_permission_mode` request |
| `compact_progress` | Progress while a compaction runs |
| `session_ended` | Claude process exited (`reason` included) |
| `error` | Anything else that went wrong |
| `pong` | Reply to `ping` |

## Terminal WebSocket

Connect to `ws://…/ws/terminal?session=<id>&cwd=<path>`:

- **Client → server:** raw keystrokes as text, plus one JSON control message: `{"type": "resize", "rows": 40, "cols": 120}`.
- **Server → client:** raw ANSI terminal output.

Each session gets its own persistent PTY that survives disconnects; `cwd` is only used when the session has no stored working directory.

## Shadow DB SQL

`POST /api/shadow-db/sql` runs ad-hoc read-only SQL against the [shadow DuckDB](../guides/shadow-git.md) of turns, costs, and tags.

- **Body:** raw SQL (`Content-Type: text/plain`) or `{"sql": "…"}` JSON.
- **Format:** default JSON `{columns, rows, count}`; `?format=tsv` returns tab-separated text with a header row.
- **Read-only:** a validator rejects mutation keywords (INSERT, UPDATE, DROP, ATTACH, …) and file-access functions.

```bash
shadow-query() { curl -sS -X POST "${BRIDGE_URL:-http://localhost:8765}/api/shadow-db/sql?format=tsv" \
  -H "Authorization: Bearer $(awk '/^password:/ {print $2}' ~/.config/painapple-code/config.yaml)" \
  -H "Content-Type: text/plain" --data-binary "$1"; }

shadow-query 'SELECT started_at, user_prompt[:80], cost, model FROM turns ORDER BY started_at DESC LIMIT 10'
```

Drop `?format=tsv` for JSON output that pipes cleanly into `jq`.
