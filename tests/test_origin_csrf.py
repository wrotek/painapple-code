"""Regression tests for the WP-03 origin/CSRF boundary (A1–A6).

Covers: exec/mkdir JSON-body requirement, HTTP Origin/CSRF enforcement on
ambient-credential state-changing requests, Bearer exemption, WebSocket
Origin enforcement, and login rate limiting.
"""

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from conftest import client_token
from painapple_code.auth_middleware import COOKIE_NAME


def _cookie_client(app, pw):
    return TestClient(app, cookies={COOKIE_NAME: client_token(pw, "cookie")})


# ---------------------------------------------------------------------------
# A4 — exec/mkdir require a JSON body (kills the simple-request RCE shape)
# ---------------------------------------------------------------------------

def test_exec_query_string_no_longer_binds(client):
    # Bearer client (CSRF-exempt); query form must 422 now that a body is required.
    r = client.post("/api/exec?command=echo+hi&cwd=.")
    assert r.status_code == 422


def test_exec_json_body_runs(client):
    r = client.post("/api/exec", json={"command": "echo hardening", "cwd": "."})
    assert r.status_code == 200
    assert "hardening" in r.json()["stdout"]


def test_mkdir_query_string_no_longer_binds(client):
    r = client.post("/api/mkdir?path=/tmp/should-not-bind")
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# A2 — HTTP Origin/CSRF enforcement
# ---------------------------------------------------------------------------

def test_cookie_post_foreign_origin_blocked(app, test_password):
    c = _cookie_client(app, test_password)
    r = c.post("/api/exec", json={"command": "echo x"},
               headers={"Origin": "http://evil.example"})
    assert r.status_code == 403
    assert r.json()["error"] == "origin_forbidden"


def test_cookie_post_allowed_origin_ok(app, test_password):
    c = _cookie_client(app, test_password)
    r = c.post("/api/exec", json={"command": "echo ok"},
               headers={"Origin": "http://127.0.0.1:8765"})
    assert r.status_code == 200


def test_cookie_post_sec_fetch_same_origin_ok(app, test_password):
    c = _cookie_client(app, test_password)
    r = c.post("/api/exec", json={"command": "echo ok"},
               headers={"Sec-Fetch-Site": "same-origin"})
    assert r.status_code == 200


def test_cookie_post_no_origin_evidence_blocked(app, test_password):
    c = _cookie_client(app, test_password)
    r = c.post("/api/exec", json={"command": "echo x"})
    assert r.status_code == 403


def test_cookie_post_null_origin_blocked(app, test_password):
    c = _cookie_client(app, test_password)
    r = c.post("/api/exec", json={"command": "echo x"},
               headers={"Origin": "null"})
    assert r.status_code == 403


def test_bearer_foreign_origin_exempt(client):
    # Bearer is a non-ambient credential -> not a CSRF vector -> exempt.
    r = client.post("/api/exec", json={"command": "echo b"},
                    headers={"Origin": "http://evil.example"})
    assert r.status_code == 200


def test_tkn_stays_ambient_after_credential_split(app, test_password):
    """?tkn= carries a derived api_token now, not the password — but it still
    rides in a URL a browser can be induced to load, so it must stay in
    AMBIENT_AUTH and keep the Origin gate.

    The tempting cleanup ("it's an explicit token now, exempt it like Bearer")
    would silently drop CSRF protection from an entire auth path. This test is
    the tripwire for that refactor.
    """
    tkn = client_token(test_password, "tkn")
    c = TestClient(app)
    r = c.post(f"/api/exec?tkn={tkn}", json={"command": "echo t"},
               headers={"Origin": "http://evil.example"})
    assert r.status_code == 403


def test_safe_method_not_origin_checked(app, test_password):
    c = _cookie_client(app, test_password)
    # GET on a POST-only route -> 405, proving the CSRF gate (403) did not fire
    # on a safe method even with a hostile Origin.
    r = c.get("/api/exec", headers={"Origin": "http://evil.example"})
    assert r.status_code == 405


# ---------------------------------------------------------------------------
# H1 — config-free same-origin acceptance (Origin matches the request's own
# Host / X-Forwarded-Host). Fixes the "locks out every non-loopback deploy"
# regression: a proxied hostname / LAN bind is NOT in the loopback allowlist,
# but is genuinely same-origin and must be accepted with zero config.
# ---------------------------------------------------------------------------

def test_cookie_post_same_origin_as_host_ok(app, test_password):
    # Origin == the TestClient's own Host ("testserver"), which is deliberately
    # NOT in the default (loopback) allowlist.
    from painapple_code import server as srv
    assert "http://testserver" not in srv.resolve_allowed_origins()
    c = _cookie_client(app, test_password)
    r = c.post("/api/exec", json={"command": "echo ok"},
               headers={"Origin": "http://testserver"})
    assert r.status_code == 200


def test_cookie_post_proxied_forwarded_host_ok(app, test_password):
    # Reverse-proxy shape: browser Origin is the public https host, the proxy
    # forwards it via X-Forwarded-Host/-Proto. Not in any allowlist -> must pass.
    c = _cookie_client(app, test_password)
    r = c.post("/api/exec", json={"command": "echo ok"},
               headers={"Origin": "https://bridge.example.com",
                        "X-Forwarded-Host": "bridge.example.com",
                        "X-Forwarded-Proto": "https"})
    assert r.status_code == 200


def test_cookie_post_sibling_port_still_blocked(app, test_password):
    # Same host, different port is same-site but hostile -> the Host match is
    # exact on host:port, so this must remain a 403.
    c = _cookie_client(app, test_password)
    r = c.post("/api/exec", json={"command": "echo x"},
               headers={"Origin": "http://testserver:9999"})
    assert r.status_code == 403


def test_origin_matches_host_unit():
    from painapple_code.auth_middleware import _origin_matches_host
    h = {b"host": b"192.168.1.50:8899"}
    assert _origin_matches_host("http://192.168.1.50:8899", h, "http")
    assert not _origin_matches_host("http://evil.example", h, "http")
    # X-Forwarded-Host wins; default ports fill in per scheme.
    hp = {b"x-forwarded-host": b"app.example.com", b"host": b"127.0.0.1:8765"}
    assert _origin_matches_host("https://app.example.com", hp, "https")
    assert not _origin_matches_host("https://app.example.com:8443", hp, "https")


# ---------------------------------------------------------------------------
# A3 — WebSocket Origin enforcement
# ---------------------------------------------------------------------------

def _ws_close_code(client, url, headers=None):
    ws = client.websocket_connect(url, headers=headers or {})
    ws.__enter__()
    try:
        for _ in range(10):
            msg = ws.receive()
            if msg.get("type") == "websocket.close":
                return msg.get("code")
        return None
    except WebSocketDisconnect as e:
        return e.code
    finally:
        try:
            ws.close()
        except Exception:
            pass


@pytest.mark.parametrize("url", ["/chat", "/ws/terminal"])
def test_ws_foreign_origin_closed(app, test_password, url):
    c = _cookie_client(app, test_password)
    code = _ws_close_code(c, url, headers={"origin": "http://evil.example"})
    assert code == 1008

# (The allowed/no-origin positive path is covered by test_auth's
# test_ws_terminal_authed_via_tkn_not_1008 — a no-Origin handshake succeeds.)


def test_ws_same_origin_as_host_accepted_unit():
    """H1: a WS handshake whose Origin matches its own Host passes the gate
    even with an empty allowlist (proxied / LAN deploy)."""
    from types import SimpleNamespace
    from painapple_code.auth_middleware import check_websocket_origin

    def ws(origin, host, scheme="http", xfh=None, xfp=None):
        raw = [(b"origin", origin.encode()), (b"host", host.encode())]
        if xfh:
            raw.append((b"x-forwarded-host", xfh.encode()))
        if xfp:
            raw.append((b"x-forwarded-proto", xfp.encode()))
        return SimpleNamespace(
            headers={"origin": origin},
            scope={"type": "websocket", "scheme": scheme, "headers": raw},
        )

    # Empty allowlist, but Origin == Host -> accepted.
    assert check_websocket_origin(ws("http://192.168.1.50:8899",
                                     "192.168.1.50:8899"), set())
    # Proxied wss handshake.
    assert check_websocket_origin(
        ws("https://bridge.example.com", "127.0.0.1:8765",
           scheme="wss", xfh="bridge.example.com", xfp="https"), set())
    # Foreign origin still rejected.
    assert not check_websocket_origin(ws("http://evil.example",
                                         "192.168.1.50:8899"), set())


# ---------------------------------------------------------------------------
# A6 — login rate limiting
# ---------------------------------------------------------------------------

def test_login_rate_limited_after_max_failures(app):
    from painapple_code import server as srv
    srv._login_reset()
    c = TestClient(app)
    try:
        for _ in range(srv._LOGIN_MAX_FAILS):
            r = c.post("/api/login", json={"password": "wrong", "next": ""})
            assert r.status_code == 401
        r = c.post("/api/login", json={"password": "wrong", "next": ""})
        assert r.status_code == 429
        assert r.headers.get("Retry-After")
    finally:
        srv._login_reset()


# ---------------------------------------------------------------------------
# Origin / host env resolution
# ---------------------------------------------------------------------------

def test_new_env_names_still_work(monkeypatch):
    from painapple_code.server import resolve_allowed_hosts, resolve_allowed_origins
    monkeypatch.setenv("PAINAPPLE_ALLOWED_ORIGINS", "https://new.example.com")
    assert resolve_allowed_origins(port=8765) == {"https://new.example.com"}
    monkeypatch.delenv("PAINAPPLE_ALLOWED_ORIGINS", raising=False)
    monkeypatch.setenv("PAINAPPLE_ALLOWED_HOSTS", "host.example.com")
    assert "host.example.com" in resolve_allowed_hosts()


def test_no_origin_env_leaves_defaults_untouched(monkeypatch):
    """Nothing set -> derived loopback pair, host check off."""
    from painapple_code.server import resolve_allowed_hosts, resolve_allowed_origins
    for n in ("PAINAPPLE_ALLOWED_ORIGINS", "PAINAPPLE_ALLOWED_HOSTS"):
        monkeypatch.delenv(n, raising=False)
    assert resolve_allowed_origins(port=8765) == {
        "http://127.0.0.1:8765", "http://localhost:8765",
    }
    assert resolve_allowed_hosts() == ["*"]
