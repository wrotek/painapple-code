"""
Authentication middleware for pAInapple Code.

Simple code-server-style password authentication:

- Password lives in ~/.config/painapple-code/config.yaml under the `password:`
  key (mode 0600, parent 0700). Mirrors code-server's config.yaml layout so
  future settings (bind-addr, etc.) can land alongside it.
- Three auth paths: cookie, ?tkn= query param, Authorization: Bearer header
- Cookie value is HMAC-derived from password (never stored as raw password)
- ?tkn= bootstraps the cookie: HTML paths 302-strip, API paths inject Set-Cookie
- WebSockets auth via cookie or ?tkn=; no HTTP-level auth
- Fourth path, ?dl=: short-lived HMAC-signed download token bound to one exact
  URL (minted via POST /api/auth/download-token). Lets "copy download link"
  work outside the authed browser context (iPad PWA → Safari) without ever
  putting the password in a shareable URL. Never sets a cookie.

Public allowlist: /login, /api/login, /api/logout, /health, /sw.js,
/manifest.json, /instance-icons/*, /static/css/login.css. Also OPTIONS method.

Middleware reads password + cookie_token from scope["app"].state at request
time, so tests can mutate app.state per-fixture without re-adding middleware.
"""

import hmac
import os
import secrets
import time
from hashlib import sha256
from pathlib import Path
from typing import Literal, Optional
from urllib.parse import parse_qsl, quote, urlencode, urlparse, urlunparse

import yaml
from starlette.websockets import WebSocket

from painapple_code.bridge_paths import lock_mode


COOKIE_NAME = "bridge_auth"
COOKIE_MAX_AGE = 30 * 24 * 3600  # 30 days
COOKIE_DERIVATION_INFO = b"bridge-cookie-v1"

DOWNLOAD_TOKEN_TTL = 5 * 60  # 5 minutes
DOWNLOAD_TOKEN_INFO = b"bridge-download-v1"
DOWNLOAD_TOKEN_PARAM = "dl"

PUBLIC_PATHS = frozenset({
    "/login",
    "/api/login",
    "/api/logout",
    "/health",
    "/sw.js",
    "/manifest.json",
    "/static/css/login.css",
})

PUBLIC_PREFIXES = (
    "/instance-icons/",
)


def ensure_config_file(path: Path) -> tuple[str, bool]:
    """Load or create the YAML config at `path`. Repair permissions every call.

    Returns (password, newly_created).
    """
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock_mode(path.parent, 0o700)

    if path.exists():
        lock_mode(path, 0o600)
        config = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        if not isinstance(config, dict):
            raise ValueError(
                f"{path}: expected a YAML mapping, got {type(config).__name__}"
            )
        password = config.get("password")
        if isinstance(password, str) and password:
            return password, False
        # Existing config but no usable password — generate one and persist.
        password = secrets.token_urlsafe(32)
        config["password"] = password
        _write_config(path, config)
        return password, True

    password = secrets.token_urlsafe(32)
    _write_config(path, {"password": password})
    return password, True


def _write_config(path: Path, config: dict) -> None:
    """Write the config dict as YAML and lock perms to 0600."""
    path.write_text(yaml.safe_dump(config, default_flow_style=False, sort_keys=False), encoding="utf-8")
    lock_mode(path, 0o600)


def derive_cookie_token(password: str) -> str:
    """Derive the cookie value from the password via HMAC-SHA256.

    This separates the cookie value from the password itself — compromising
    a cookie does not reveal the password. Reversing would require brute-force.
    """
    return hmac.new(
        password.encode("utf-8"),
        COOKIE_DERIVATION_INFO,
        sha256,
    ).hexdigest()


def _download_signing_key(password: str) -> bytes:
    """Derive a dedicated signing key so download tokens never expose the
    password or the cookie token, and vice versa."""
    return hmac.new(password.encode("utf-8"), DOWNLOAD_TOKEN_INFO, sha256).digest()


def mint_download_token(
    password: str,
    url: str,
    ttl: int = DOWNLOAD_TOKEN_TTL,
    now: Optional[float] = None,
) -> tuple[str, int]:
    """Mint a short-lived token authorizing exactly `url` (local path?query).

    Stateless: token = "<expiry_epoch>.<hmac-sha256-hex>" signed over
    "<expiry>:<url>". Returns (token, expiry_epoch).
    """
    exp = int((time.time() if now is None else now) + ttl)
    sig = hmac.new(
        _download_signing_key(password),
        f"{exp}:{url}".encode("utf-8"),
        sha256,
    ).hexdigest()
    return f"{exp}.{sig}", exp


def check_download_token(
    token: str,
    password: str,
    url: str,
    now: Optional[float] = None,
) -> bool:
    """Validate a download token against the exact requested URL and expiry."""
    exp_str, _, sig = token.partition(".")
    if not exp_str.isdigit() or not sig:
        return False
    if (time.time() if now is None else now) > int(exp_str):
        return False
    expected = hmac.new(
        _download_signing_key(password),
        f"{exp_str}:{url}".encode("utf-8"),
        sha256,
    ).hexdigest()
    return hmac.compare_digest(sig, expected)


def _request_url_without_dl(scope) -> str:
    """Rebuild path?query with the dl= param removed, preserving the raw
    (client-built) percent-encoding of the remaining query segments so the
    string matches what was signed byte-for-byte."""
    path = scope.get("path", "/")
    qs = scope.get("query_string", b"").decode("latin1")
    kept = [
        seg for seg in qs.split("&")
        if seg and not seg.startswith(f"{DOWNLOAD_TOKEN_PARAM}=")
    ]
    return path + (f"?{'&'.join(kept)}" if kept else "")


def safe_next(raw: str) -> str:
    """Sanitize a `next=` parameter to a local path, stripping any tkn= token.

    Rejects absolute URLs, protocol-relative URLs (//evil), backslash-escape
    (/\\evil), path-traversal segments (`..` / `.`), and anything that
    doesn't start with a single slash. Always parses the query string
    rather than substring-matching, so encoded or reordered tkn= variants
    are still stripped.
    """
    if not isinstance(raw, str):
        return "/app"
    if not raw or not raw.startswith("/") or raw.startswith("//") or raw.startswith("/\\"):
        return "/app"
    try:
        parsed = urlparse(raw)
    except ValueError:
        return "/app"
    if parsed.scheme or parsed.netloc:
        return "/app"
    if any(seg in ("..", ".") for seg in parsed.path.split("/")):
        return "/app"
    clean_qs = [
        (k, v)
        for k, v in parse_qsl(parsed.query, keep_blank_values=True)
        if k != "tkn"
    ]
    rebuilt_query = urlencode(clean_qs)
    return urlunparse(parsed._replace(query=rebuilt_query))


def is_public(path: str) -> bool:
    """Allowlisted paths bypass auth entirely."""
    if path in PUBLIC_PATHS:
        return True
    for prefix in PUBLIC_PREFIXES:
        if path.startswith(prefix):
            return True
    return False


def _parse_cookies(cookie_header: str) -> dict[str, str]:
    """Parse a Cookie header into a dict."""
    cookies = {}
    for item in cookie_header.split(";"):
        item = item.strip()
        if "=" in item:
            k, _, v = item.partition("=")
            cookies[k.strip()] = v.strip()
    return cookies


def _get_query(scope) -> dict[str, str]:
    qs = scope.get("query_string", b"").decode("latin1")
    return dict(parse_qsl(qs, keep_blank_values=True))


def _get_headers(scope) -> dict[bytes, bytes]:
    """Flatten ASGI headers to a single-value dict.

    Multi-value headers (Cookie in particular) get joined with `; `, which is
    the same separator used inside a single Cookie header. iPadOS WebKit over
    HTTP/2 splits cookies into multiple `:cookie` pseudo-headers; some
    reverse proxies forward those as separate `Cookie:` headers, and a naive
    `dict(headers)` keeps only the last one — silently dropping `bridge_auth`
    if WebKit happened to put it earlier.
    """
    merged: dict[bytes, bytes] = {}
    for name, value in scope.get("headers", []):
        if name in merged:
            sep = b"; " if name == b"cookie" else b", "
            merged[name] = merged[name] + sep + value
        else:
            merged[name] = value
    return merged


AuthVia = Optional[Literal["cookie", "bearer", "tkn", "dl"]]

# Methods that can change state — CSRF-relevant. GET/HEAD/OPTIONS are safe.
UNSAFE_METHODS = frozenset({"POST", "PUT", "DELETE", "PATCH"})
# Ambient credentials a hostile cross-origin page could ride (the browser
# attaches them automatically). Bearer/dl are set explicitly by the caller,
# so they aren't CSRF vectors and skip the Origin check. Note auth resolution
# prefers the cookie when BOTH a cookie and a Bearer header are present, so a
# Bearer client that also carries a cookie is treated as ambient and Origin-
# checked — the fail-safe direction (never the reverse).
AMBIENT_AUTH = frozenset({"cookie", "tkn"})


def _origin_of(url: str) -> Optional[str]:
    """scheme://host[:port] of a URL, or None if unparseable."""
    try:
        p = urlparse(url)
    except ValueError:
        return None
    if not p.scheme or not p.hostname:
        return None
    netloc = f"{p.hostname}:{p.port}" if p.port else p.hostname
    return f"{p.scheme}://{netloc}"


def _norm_host(scheme: str, hostport: str) -> Optional[str]:
    """Normalize a Host-style value to lowercase ``host:port``, filling in the
    scheme's default port when absent. ``None`` for an empty value."""
    hostport = hostport.strip().lower()
    if not hostport:
        return None
    if hostport.startswith("["):  # IPv6 literal: [::1] or [::1]:8765
        host, _, rest = hostport[1:].partition("]")
        port = rest.lstrip(":")
    elif hostport.count(":") == 1:
        host, _, port = hostport.partition(":")
    else:  # bare host, or IPv6 without brackets (no port possible)
        host, port = hostport, ""
    if not port:
        port = "443" if scheme == "https" else "80"
    return f"{host}:{port}"


def _req_scheme(scope, headers) -> str:
    """Effective request scheme for origin comparison. Honours a trusted
    ``X-Forwarded-Proto`` (uvicorn only forwards it from ``--forwarded-allow-ips``
    peers) and maps ws/wss → http/https."""
    xfp = headers.get(b"x-forwarded-proto", b"").decode("latin1").split(",")[0].strip().lower()
    if xfp in ("http", "https"):
        return xfp
    s = (scope.get("scheme") or "http").lower()
    return "https" if s in ("https", "wss") else "http"


def _origin_matches_host(origin: str, headers: dict, scheme: str) -> bool:
    """True when ``origin`` addresses the SAME host:port the request was sent to
    (its ``Host`` / ``X-Forwarded-Host``). This is the standard, config-free
    CSRF defense: a cross-site page's Origin never matches the bridge's own host,
    while genuine same-origin traffic — proxied under any hostname or reached
    over the LAN — always does, with no preconfigured allowlist.

    DNS-rebinding (Origin==Host but Host is an attacker-chosen name) is not
    covered here — it is separately defeated because the ``bridge_auth`` cookie
    is bound to the real origin's domain and never rides an attacker-domain
    request, and ``TrustedHostMiddleware`` can be enabled for defense-in-depth.
    """
    try:
        p = urlparse(origin)
    except ValueError:
        return False
    if not p.hostname:
        return False
    o_scheme = (p.scheme or scheme).lower()
    o_netloc = _norm_host(o_scheme, p.netloc)
    if not o_netloc:
        return False
    # Prefer the client-facing host the proxy forwarded; fall back to Host.
    for hdr in (b"x-forwarded-host", b"host"):
        raw = headers.get(hdr, b"").decode("latin1")
        first = raw.split(",")[0].strip()
        if first and _norm_host(o_scheme, first) == o_netloc:
            return True
    return False


def check_csrf_origin(scope, allowed_origins) -> bool:
    """True if a state-changing, ambient-credential request is same-origin
    or from a trusted origin. Fail-closed: a missing/``null``/foreign Origin
    (with no same-origin Sec-Fetch signal and no trusted Referer) is rejected.
    """
    headers = _get_headers(scope)

    # Modern browsers label the request context directly. Trust only an
    # explicit same-origin / non-navigational ("none") assertion — never
    # "same-site" (a sibling localhost port is same-site but hostile).
    sec_fetch = headers.get(b"sec-fetch-site", b"").decode("latin1").strip().lower()
    if sec_fetch in ("same-origin", "none"):
        return True

    scheme = _req_scheme(scope, headers)
    origin = headers.get(b"origin", b"").decode("latin1").strip()
    if origin and origin.lower() != "null":
        # Configured trusted origin, OR genuinely same-origin as our own Host
        # (works for any proxied hostname / LAN bind with zero config).
        return origin in allowed_origins or _origin_matches_host(origin, headers, scheme)

    # No usable Origin — fall back to the Referer's origin.
    referer = headers.get(b"referer", b"").decode("latin1").strip()
    if referer:
        ro = _origin_of(referer)
        if not ro:
            return False
        return ro in allowed_origins or _origin_matches_host(referer, headers, scheme)

    # Ambient credential, state-changing method, and no origin evidence at
    # all → treat as forged.
    return False


def _redact_bridge_auth(value: str) -> str:
    """Replace bridge_auth=<value> with bridge_auth=<REDACTED:N> for log safety."""
    import re
    return re.sub(r"bridge_auth=([^;]*)", lambda m: f"bridge_auth=<REDACTED:{len(m.group(1))}>", value)


def _log_csrf_failure(scope, path: str) -> None:
    """Log a rejected cross-origin state-changing request (Origin mismatch)."""
    import logging
    try:
        headers = _get_headers(scope)
        origin = headers.get(b"origin", b"").decode("latin1", "replace")
        sec_fetch = headers.get(b"sec-fetch-site", b"").decode("latin1", "replace")
        client = scope.get("client", ("?", 0))
        logging.getLogger("painapple-code.auth-debug").warning(
            "CSRF-REJECT %s %s client=%s:%s origin=%r sec-fetch-site=%r",
            scope.get("method", "?"), path,
            client[0] if client else "?", client[1] if client else 0,
            origin, sec_fetch,
        )
    except Exception:
        pass


def _log_auth_failure(scope, path: str) -> None:
    """Log the shape (not contents) of cookies on a failing request, so we can
    correlate intermittent 401s with what the client actually sent."""
    import logging
    try:
        cookie_entries = [v.decode("latin1", "replace") for n, v in scope.get("headers", []) if n == b"cookie"]
        has_bridge_auth = any("bridge_auth=" in c for c in cookie_entries)
        redacted = [_redact_bridge_auth(c)[:200] for c in cookie_entries]
        client = scope.get("client", ("?", 0))
        logging.getLogger("painapple-code.auth-debug").warning(
            "AUTH-FAIL %s %s client=%s:%s cookies=%d has_bridge_auth=%s entries=%r",
            scope.get("method", "?"), path,
            client[0] if client else "?", client[1] if client else 0,
            len(cookie_entries), has_bridge_auth, redacted,
        )
    except Exception:
        pass


def check_http_auth_detailed(
    scope,
    password: str,
    cookie_token: str,
) -> AuthVia:
    """Check HTTP auth; return which path authed, or None.

    Uses hmac.compare_digest for all comparisons.
    """
    headers = _get_headers(scope)

    # 1. Cookie
    cookie_header = headers.get(b"cookie", b"").decode("latin1")
    if cookie_header:
        cookies = _parse_cookies(cookie_header)
        presented = cookies.get(COOKIE_NAME, "")
        if presented and hmac.compare_digest(presented, cookie_token):
            return "cookie"

    # 2. Authorization: Bearer
    auth_header = headers.get(b"authorization", b"").decode("latin1")
    if auth_header.lower().startswith("bearer "):
        presented = auth_header[7:].strip()
        if presented and hmac.compare_digest(presented, password):
            return "bearer"

    # 3. Query ?tkn=
    query = _get_query(scope)
    presented = query.get("tkn", "")
    if presented and hmac.compare_digest(presented, password):
        return "tkn"

    # 4. Query ?dl= — short-lived signed download token, bound to this URL.
    # Grants access to this request only: no cookie is set (see middleware).
    presented = query.get(DOWNLOAD_TOKEN_PARAM, "")
    if presented and check_download_token(
        presented, password, _request_url_without_dl(scope)
    ):
        return "dl"

    return None


def check_websocket_auth(
    websocket: WebSocket,
    password: str,
    cookie_token: str,
) -> bool:
    """WebSocket auth via cookie or ?tkn=. No Authorization header for WS."""
    presented = websocket.cookies.get(COOKIE_NAME, "")
    if presented and hmac.compare_digest(presented, cookie_token):
        return True
    tkn = websocket.query_params.get("tkn", "")
    if tkn and hmac.compare_digest(tkn, password):
        return True
    return False


def check_websocket_origin(websocket: WebSocket, allowed_origins) -> bool:
    """Origin gate for a WebSocket handshake (WS bypasses CORS entirely).

    Browsers ALWAYS send an Origin header on a WS handshake, so a present but
    foreign Origin is the cross-site attack we block. A missing Origin means a
    non-browser client (script/native) — not a CSRF vector, and still gated by
    the cookie/tkn check — so we allow it. ``null`` is treated as foreign.
    """
    origin = (websocket.headers.get("origin") or "").strip()
    if not origin:
        return True
    if origin.lower() == "null":
        return False
    if origin in (allowed_origins or set()):
        return True
    # Genuinely same-origin as the handshake's own Host (config-free) — the
    # common case for a proxied hostname or a LAN bind.
    headers = _get_headers(websocket.scope)
    return _origin_matches_host(origin, headers, _req_scheme(websocket.scope, headers))


class AuthMiddleware:
    """Pure ASGI middleware that gates all HTTP requests by auth.

    WebSocket auth is NOT enforced here — each WS handler accepts then
    closes(1008) if unauth. That pattern plays nicer with Starlette's WS
    state machine than trying to reject before accept.

    Reads password + cookie_token from scope["app"].state at request time so
    tests can mutate state without re-adding middleware.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "/")

        # OPTIONS passes through so CORS preflight works
        if scope["type"] == "http" and scope.get("method") == "OPTIONS":
            await self.app(scope, receive, send)
            return

        if is_public(path):
            await self.app(scope, receive, send)
            return

        if scope["type"] == "websocket":
            # WS handler does accept-then-close(1008) itself.
            await self.app(scope, receive, send)
            return

        # HTTP path
        state = scope["app"].state
        password = getattr(state, "auth_password", None)
        cookie_token = getattr(state, "auth_cookie_token", None)

        if password is None or cookie_token is None:
            # Fail-closed: if auth state isn't initialized, reject everything.
            await self._send_unauth_http(scope, send)
            return

        auth_via = check_http_auth_detailed(scope, password, cookie_token)
        if auth_via is None:
            _log_auth_failure(scope, path)
            await self._send_unauth_http(scope, send)
            return

        # CSRF/origin boundary: a state-changing request authed by an ambient
        # credential (cookie/tkn) must come from a trusted origin. Bearer/dl
        # callers set their credential explicitly and are exempt.
        if scope.get("method", "GET") in UNSAFE_METHODS and auth_via in AMBIENT_AUTH:
            allowed = getattr(state, "allowed_origins", None) or set()
            if not check_csrf_origin(scope, allowed):
                _log_csrf_failure(scope, path)
                await self._send_forbidden_http(scope, send)
                return

        if auth_via == "tkn":
            if self._is_html_target(scope):
                await self._redirect_strip_tkn(scope, send, cookie_token)
                return
            # API / other: inject Set-Cookie on the downstream response
            send = self._wrap_send_with_cookie(
                send,
                cookie_token=cookie_token,
                secure=self._is_https(scope),
            )

        await self.app(scope, receive, send)

    @staticmethod
    def _is_https(scope) -> bool:
        headers = _get_headers(scope)
        forwarded = headers.get(b"x-forwarded-proto", b"").decode("latin1")
        if forwarded:
            return forwarded == "https"
        return scope.get("scheme") == "https"

    @staticmethod
    def _is_html_target(scope) -> bool:
        path = scope.get("path", "/")
        if path in ("/", "/app", "/test", "/triage"):
            return True
        headers = _get_headers(scope)
        accept = headers.get(b"accept", b"").decode("latin1")
        return "text/html" in accept

    @staticmethod
    def _build_cookie_header(cookie_token: str, secure: bool) -> bytes:
        parts = [
            f"{COOKIE_NAME}={cookie_token}",
            "HttpOnly",
            "SameSite=Lax",
            "Path=/",
            f"Max-Age={COOKIE_MAX_AGE}",
        ]
        if secure:
            parts.append("Secure")
        return "; ".join(parts).encode("latin1")

    def _wrap_send_with_cookie(self, send, cookie_token: str, secure: bool):
        cookie_header = self._build_cookie_header(cookie_token, secure)

        async def wrapped_send(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append((b"set-cookie", cookie_header))
                message = {**message, "headers": headers}
            await send(message)

        return wrapped_send

    async def _redirect_strip_tkn(self, scope, send, cookie_token: str):
        path = scope.get("path", "/")
        qs = scope.get("query_string", b"").decode("latin1")
        clean = [
            (k, v)
            for k, v in parse_qsl(qs, keep_blank_values=True)
            if k != "tkn"
        ]
        target = path + (f"?{urlencode(clean)}" if clean else "")
        secure = self._is_https(scope)
        await send({
            "type": "http.response.start",
            "status": 302,
            "headers": [
                (b"location", target.encode("latin1")),
                (b"set-cookie", self._build_cookie_header(cookie_token, secure)),
                (b"cache-control", b"no-store"),
            ],
        })
        await send({"type": "http.response.body", "body": b""})

    async def _send_forbidden_http(self, scope, send):
        """403 for a rejected cross-origin state-changing request."""
        await send({
            "type": "http.response.start",
            "status": 403,
            "headers": [
                (b"content-type", b"application/json"),
                (b"cache-control", b"no-store"),
            ],
        })
        await send({
            "type": "http.response.body",
            "body": b'{"error":"origin_forbidden"}',
        })

    async def _send_unauth_http(self, scope, send):
        path = scope.get("path", "/")
        headers = _get_headers(scope)
        accept = headers.get(b"accept", b"").decode("latin1")
        is_api = path.startswith("/api/")
        is_html = not is_api and (
            "text/html" in accept
            or path in ("/", "/app", "/test", "/triage", "/sessions")
        )

        if is_api:
            await send({
                "type": "http.response.start",
                "status": 401,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"cache-control", b"no-store"),
                ],
            })
            await send({
                "type": "http.response.body",
                "body": b'{"error":"auth_required"}',
            })
            return

        if is_html:
            qs = scope.get("query_string", b"").decode("latin1")
            raw_next = path + (f"?{qs}" if qs else "")
            sanitized = safe_next(raw_next)
            location = f"/login?next={quote(sanitized, safe='')}"
            await send({
                "type": "http.response.start",
                "status": 302,
                "headers": [
                    (b"location", location.encode("latin1")),
                    (b"cache-control", b"no-store"),
                ],
            })
            await send({"type": "http.response.body", "body": b""})
            return

        # Everything else (static assets, etc.) — 401 text/plain
        await send({
            "type": "http.response.start",
            "status": 401,
            "headers": [
                (b"content-type", b"text/plain"),
                (b"cache-control", b"no-store"),
            ],
        })
        await send({"type": "http.response.body", "body": b"unauthorized"})
