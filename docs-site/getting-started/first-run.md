# First run & login

On first start the server generates a password, and everything except a tiny public allowlist requires it — here's how to log in and open your first session.

## The generated password

The password lives in a config file at `~/.config/painapple-code/config.yaml` (mode `0600`, parent dir `0700`; inside the Docker container that's under `/home/app/`):

```yaml
password: <generated-token>
```

On a **loopback bind** (the default `127.0.0.1`) every start logs a **login URL** with the derived API token embedded as `?tkn=…` — on the very first run it's flagged as newly generated:

```
Auth config generated at ~/.config/painapple-code/config.yaml. Log in once via: http://127.0.0.1:8765/?tkn=…
```

Open that URL once in your browser and you're in.

On a **non-loopback bind** (`--host 0.0.0.0`, a LAN address, or inside the Docker container) the startup box hides the password instead — a server's stdout tends to outlive the terminal in journald, `docker logs`, or a supervisor console. Retrieve the login URL with `painapple password` (see below), or pass `--show-password` to opt back in.

### Reveal the password later

The CLI prints ready-to-open login URLs plus the password, for host and container deployments alike:

```bash
painapple password                # add a profile name for named deployments
```

Or read the config file directly:

```bash
awk '/^password:/ {print $2}' ~/.config/painapple-code/config.yaml
# …or in a container not managed by the CLI:
docker exec painapple-code awk '/^password:/ {print $2}' \
    /home/app/.config/painapple-code/config.yaml
```

### Rotate the password

Delete the config file and restart — a new password is generated on the next start:

```bash
rm ~/.config/painapple-code/config.yaml
# then restart the server and grab the new login URL from the logs
```

## How auth works

Three auth paths are accepted:

| Path | Works for | Notes |
|------|-----------|-------|
| Cookie `painapple_auth=<HMAC-derived-token>` | HTTP + WebSocket | Set automatically after your first login; lasts 30 days |
| Query `?tkn=<api_token>` | HTTP + WebSocket | On HTTP, the middleware issues a `Set-Cookie` (and redirects HTML pages to strip the token from the URL), so follow-up requests don't need it |
| Header `Authorization: Bearer <api_token>` | HTTP only | For `curl` and scripts |

So in practice: open the login URL once, the cookie takes over, and you stay logged in. If you land on a page without auth, you're redirected to `/login`, where you can paste the password instead.

`api_token` is derived from the password and written into the same config file on start. Scripts and `?tkn=` links use it so that **the password itself never travels** — and so a shared link or a CI secret can be revoked on its own by bumping `bearer_epoch`, without logging your browsers out. Bumping `cookie_epoch` does the reverse: every browser is logged out, scripts keep working.

```bash
# Scripting example — the credential goes in on stdin, not the command line
printf 'header = "Authorization: Bearer %s"\n' \
    "$(awk '/^api_token:/ {print $2}' ~/.config/painapple-code/config.yaml)" |
    curl -sS --config - http://localhost:8765/api/welcome/projects
```

!!! warning "Keep the password out of `-H`"
    Passing it as `curl -H "Authorization: Bearer …"` puts the secret in the
    process command line, which `ps` exposes to every user on the machine —
    a wider audience than the `0600` config file it lives in. `--config -`
    reads the header from stdin instead. See the
    [API reference](../reference/api.md#authentication-for-scripts).

!!! note "`/health` needs no auth"
    `GET /health` is on the public allowlist (along with the login page and PWA manifest), so liveness checks and monitoring work without a token:

    ```bash
    curl http://localhost:8765/health
    ```

## Your first session

1. **Open the app.** Go to `http://localhost:8765/` (redirects to `/app`) — or just use the login URL from the logs, which lands you there authenticated.
2. **Welcome screen.** A fresh install greets you with the welcome tab: once you have history it lists recent sessions grouped by project, plus the projects in your workspace. For now, start a new session.
3. **Pick a directory.** Choose the project directory Claude should work in — sessions are bound to a working directory inside your workspace.
4. **Send a prompt.** Type into the input box and hit ++enter++. The server spawns a Claude Code subprocess for the session and streams the response — tool calls, thinking blocks and all — into the chat.

!!! tip "Install the PWA"
    On iPad (or any browser), install the app to your home screen on first visit — the auth cookie persists, so subsequent launches go straight to your sessions.

## Next steps

- [Sessions & tabs](../guides/sessions.md) — multi-session tabs, reconnect, forking
- [Writing prompts & commands](../guides/input-and-commands.md) — slash commands, bang commands, keyboard tricks
- [Features overview](../features.md) — everything else the UI can do
