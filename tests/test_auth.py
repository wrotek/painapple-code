"""Auth middleware + login/logout endpoint tests.

Every test uses fixtures from conftest.py that point at a tmp_path
config file — nothing here touches ~/.config/painapple-code/config.yaml.
"""

import hmac
import json
import os
import re
import stat
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from conftest import client_token
from painapple_code.auth_middleware import (
    COOKIE_NAME,
    check_download_token,
    check_http_auth_detailed,
    derive_cookie_token,
    ensure_config_file,
    mint_download_token,
    safe_next,
)


# ---------------------------------------------------------------------------
# ensure_config_file — creation, preservation, permission repair, migration
# ---------------------------------------------------------------------------

def test_config_file_created_on_first_run(tmp_path):
    cfg_path = tmp_path / "sub" / "config.yaml"
    password, newly_created = ensure_config_file(cfg_path)
    assert newly_created is True
    assert len(password) >= 32
    # File mode is 0600, parent is 0700
    assert oct(cfg_path.stat().st_mode)[-3:] == "600"
    assert oct(cfg_path.parent.stat().st_mode)[-3:] == "700"
    # Persisted as YAML with a `password` key
    config = yaml.safe_load(cfg_path.read_text())
    assert config == {"password": password}


def test_config_file_preserved(tmp_path):
    cfg_path = tmp_path / "sub" / "config.yaml"
    first, _ = ensure_config_file(cfg_path)
    second, newly_created = ensure_config_file(cfg_path)
    assert first == second
    assert newly_created is False


def test_existing_config_perms_repaired(tmp_path):
    cfg_path = tmp_path / "sub" / "config.yaml"
    cfg_path.parent.mkdir(mode=0o755)
    cfg_path.write_text(yaml.safe_dump({"password": "seeded-password"}))
    os.chmod(cfg_path, 0o644)
    password, newly_created = ensure_config_file(cfg_path)
    assert newly_created is False
    assert password == "seeded-password"
    assert oct(cfg_path.stat().st_mode)[-3:] == "600"


def test_existing_parent_perms_repaired(tmp_path):
    cfg_path = tmp_path / "sub" / "config.yaml"
    cfg_path.parent.mkdir(mode=0o755)
    cfg_path.write_text(yaml.safe_dump({"password": "seeded-password"}))
    os.chmod(cfg_path, 0o600)
    ensure_config_file(cfg_path)
    assert oct(cfg_path.parent.stat().st_mode)[-3:] == "700"


def test_config_without_password_key_gets_one(tmp_path):
    """If config.yaml exists but lacks a password (e.g. user-edited), generate one."""
    cfg_path = tmp_path / "sub" / "config.yaml"
    cfg_path.parent.mkdir(mode=0o700)
    cfg_path.write_text(yaml.safe_dump({"bind-addr": "127.0.0.1:8765"}))
    cfg_path.chmod(0o600)

    password, newly_created = ensure_config_file(cfg_path)
    assert newly_created is True
    assert len(password) >= 32
    config = yaml.safe_load(cfg_path.read_text())
    assert config["password"] == password
    assert config["bind-addr"] == "127.0.0.1:8765"  # preserved


def test_config_with_non_mapping_rejected(tmp_path):
    """Non-mapping YAML (e.g. a list) raises rather than silently succeeding."""
    cfg_path = tmp_path / "sub" / "config.yaml"
    cfg_path.parent.mkdir(mode=0o700)
    cfg_path.write_text("- just-a-list\n")
    cfg_path.chmod(0o600)
    with pytest.raises(ValueError):
        ensure_config_file(cfg_path)


# ---------------------------------------------------------------------------
# derive_cookie_token
# ---------------------------------------------------------------------------

def test_derived_cookie_token_differs_from_password():
    pw = "hello-world-password"
    token = derive_cookie_token(pw)
    assert token != pw
    assert len(token) == 64  # hex sha256
    # Stable across calls
    assert derive_cookie_token(pw) == token


# ---------------------------------------------------------------------------
# safe_next
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("raw,expected", [
    ("", "/app"),
    ("//evil.com", "/app"),
    ("/\\evil", "/app"),
    ("https://evil.com/", "/app"),
    ("http://evil.com/foo", "/app"),
    ("/app", "/app"),
    ("/app?session=foo", "/app?session=foo"),
    ("/foo?tkn=abc&bar=1", "/foo?bar=1"),
    ("/foo?bar=1&tkn=abc", "/foo?bar=1"),
    ("/foo?tkn=a&tkn=b", "/foo"),
    ("/foo?bar=1&tkn=abc&baz=2", "/foo?bar=1&baz=2"),
    # Path-traversal segments are rejected (browser would normalize these
    # client-side to surprising targets; server-side must not echo them).
    ("/../etc/passwd", "/app"),
    ("/app/../etc/passwd", "/app"),
    ("/./foo", "/app"),
    ("/foo/./bar", "/app"),
    ("/foo/..", "/app"),
    # Non-string inputs must not raise.
    (None, "/app"),
    (123, "/app"),
    (["/app"], "/app"),
])
def test_safe_next(raw, expected):
    assert safe_next(raw) == expected


# ---------------------------------------------------------------------------
# HTTP auth paths
# ---------------------------------------------------------------------------

def test_no_auth_redirects_html(unauth_client):
    r = unauth_client.get("/app", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == "/login?next=%2Fapp"


def test_no_auth_401_for_api(unauth_client):
    r = unauth_client.get("/api/sessions")
    assert r.status_code == 401


def test_no_auth_401_for_static_js(unauth_client):
    r = unauth_client.get("/static/js/app.js")
    assert r.status_code == 401


def test_cookie_auth_accepts(app, test_password):
    cookie_token = client_token(test_password)
    with TestClient(app, cookies={COOKIE_NAME: cookie_token}) as c:
        r = c.get("/api/sessions")
    assert r.status_code == 200
    # Cookie auth never issues Set-Cookie
    assert "set-cookie" not in {k.lower() for k in r.headers.keys()}


def test_bearer_auth_accepts_no_cookie_set(client):
    r = client.get("/api/sessions")
    assert r.status_code == 200
    assert "set-cookie" not in {k.lower() for k in r.headers.keys()}


def test_tkn_on_api_accepts_and_sets_cookie(unauth_client, test_password):
    r = unauth_client.get(f"/api/sessions?tkn={client_token(test_password, 'tkn')}")
    assert r.status_code == 200
    # Critical: tkn on API injects Set-Cookie via the send wrapper
    set_cookie = r.headers.get("set-cookie", "")
    assert set_cookie.startswith(f"{COOKIE_NAME}=")
    assert client_token(test_password) in set_cookie
    # Raw password must not appear in the cookie value
    assert test_password not in set_cookie


def test_tkn_on_html_redirects_to_strip(unauth_client, test_password):
    r = unauth_client.get(f"/app?tkn={client_token(test_password, 'tkn')}", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == "/app"
    assert client_token(test_password) in r.headers.get("set-cookie", "")


def test_tkn_value_and_cookie_value_are_distinct(app, test_password):
    """The tkn= query value and the cookie value are NOT the same string.

    Phrased through client_token so it keeps asserting the real invariant
    after WP-02 phase 1 swaps tkn from the password to a derived api_token.
    """
    assert client_token(test_password, "tkn") != client_token(test_password, "cookie")


def test_invalid_cookie_rejected(app):
    with TestClient(app, cookies={COOKIE_NAME: "definitely-wrong"}) as c:
        r = c.get("/api/sessions")
    assert r.status_code == 401


def test_split_cookie_headers_merged(test_password):
    """iPadOS WebKit over HTTP/2 splits cookies into multiple :cookie
    pseudo-headers; reverse proxies forward those as separate Cookie:
    headers. The auth check must see all of them, not just the last."""
    cookie_token = client_token(test_password)
    api_token = client_token(test_password, "bearer")
    # bridge_auth in the FIRST header — naive dict() would drop it.
    scope = {
        "headers": [
            (b"host", b"example.com"),
            (b"cookie", f"{COOKIE_NAME}={cookie_token}".encode()),
            (b"cookie", b"theme=dark"),
        ],
        "query_string": b"",
    }
    assert check_http_auth_detailed(scope, test_password, cookie_token, api_token) == "cookie"

    # Same with the order swapped (sanity check the other side).
    scope["headers"] = [
        (b"host", b"example.com"),
        (b"cookie", b"theme=dark"),
        (b"cookie", f"{COOKIE_NAME}={cookie_token}".encode()),
    ]
    assert check_http_auth_detailed(scope, test_password, cookie_token, api_token) == "cookie"


def test_invalid_bearer_rejected(app):
    with TestClient(app) as c:
        r = c.get("/api/sessions", headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_invalid_tkn_rejected(unauth_client):
    r = unauth_client.get("/api/sessions?tkn=wrong")
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# WP-02 credential separation — no request path accepts the password, and no
# credential is interchangeable with another.
# ---------------------------------------------------------------------------

def test_password_rejected_as_bearer(app, test_password):
    """The whole point of the derived api_token: a leaked CI secret is not
    the master credential, so the master credential is not a CI secret."""
    with TestClient(app) as c:
        r = c.get("/api/sessions", headers={"Authorization": f"Bearer {test_password}"})
    assert r.status_code == 401


def test_password_rejected_as_tkn(unauth_client, test_password):
    r = unauth_client.get(f"/api/sessions?tkn={test_password}")
    assert r.status_code == 401


def test_cookie_value_rejected_as_bearer(app, test_password):
    """Cross-presentation: domain separation makes this fail by construction,
    but assert it so a future refactor that unifies the info strings breaks
    here rather than silently widening every credential's reach."""
    cookie_value = client_token(test_password, "cookie")
    with TestClient(app) as c:
        r = c.get("/api/sessions", headers={"Authorization": f"Bearer {cookie_value}"})
    assert r.status_code == 401


def test_api_token_rejected_as_cookie(app, test_password):
    api_token = client_token(test_password, "bearer")
    with TestClient(app, cookies={COOKIE_NAME: api_token}) as c:
        r = c.get("/api/sessions")
    assert r.status_code == 401


def test_three_credentials_are_three_distinct_values(test_password):
    from painapple_code.auth_middleware import derive_api_token
    cookie = derive_cookie_token(test_password)
    api = derive_api_token(test_password)
    assert len({test_password, cookie, api}) == 3
    assert len(api) == 64  # hex sha256


def test_ws_password_as_tkn_rejected(app_with_bridge, test_password):
    """The WS upgrade is the one place ?tkn= is still the primary path for
    non-browser clients — it must not accept the password either."""
    client = TestClient(app_with_bridge)
    code = _first_close_code(client, f"/chat?tkn={test_password}")
    assert code == 1008


# ---------------------------------------------------------------------------
# sync_derived_config / bump_epoch — the on-disk half
# ---------------------------------------------------------------------------

def _seed_config(tmp_path, **extra):
    from painapple_code.auth_middleware import ensure_config_file
    cfg = tmp_path / "sub" / "config.yaml"
    password, _ = ensure_config_file(cfg)
    if extra:
        data = yaml.safe_load(cfg.read_text())
        data.update(extra)
        cfg.write_text(yaml.safe_dump(data, sort_keys=False))
    return cfg, password


def test_sync_writes_token_and_epochs(tmp_path):
    from painapple_code.auth_middleware import derive_api_token, sync_derived_config
    cfg, password = _seed_config(tmp_path)
    out = sync_derived_config(cfg, password)

    on_disk = yaml.safe_load(cfg.read_text())
    assert on_disk["api_token"] == derive_api_token(password, 1) == out["api_token"]
    assert on_disk["cookie_epoch"] == 1
    assert on_disk["bearer_epoch"] == 1
    assert oct(cfg.stat().st_mode)[-3:] == "600"


def test_sync_is_idempotent(tmp_path):
    from painapple_code.auth_middleware import sync_derived_config
    cfg, password = _seed_config(tmp_path)
    sync_derived_config(cfg, password)
    first = cfg.read_text()
    sync_derived_config(cfg, password)
    assert cfg.read_text() == first


def test_sync_preserves_unknown_keys(tmp_path):
    """The config is code-server-shaped and users put their own keys in it."""
    from painapple_code.auth_middleware import sync_derived_config
    cfg, password = _seed_config(tmp_path, **{"bind-addr": "127.0.0.1:8765"})
    sync_derived_config(cfg, password)
    assert yaml.safe_load(cfg.read_text())["bind-addr"] == "127.0.0.1:8765"


def test_sync_corrects_hand_edited_token(tmp_path):
    from painapple_code.auth_middleware import derive_api_token, sync_derived_config
    cfg, password = _seed_config(tmp_path, api_token="i-made-this-up")
    out = sync_derived_config(cfg, password)
    assert out["api_token"] == derive_api_token(password, 1)
    assert yaml.safe_load(cfg.read_text())["api_token"] == out["api_token"]


def test_bump_cookie_epoch_spares_the_api_token(tmp_path):
    """Log-out-everywhere must not break CI. This is the property the whole
    epoch design exists for."""
    from painapple_code.auth_middleware import bump_epoch, derive_cookie_token, sync_derived_config
    cfg, password = _seed_config(tmp_path)
    before = sync_derived_config(cfg, password)
    after = bump_epoch(cfg, "cookie_epoch")

    assert after["cookie_epoch"] == 2
    assert derive_cookie_token(password, 2) != derive_cookie_token(password, 1)
    assert after["api_token"] == before["api_token"]


def test_bump_bearer_epoch_spares_the_cookie(tmp_path):
    from painapple_code.auth_middleware import bump_epoch, derive_cookie_token, sync_derived_config
    cfg, password = _seed_config(tmp_path)
    before = sync_derived_config(cfg, password)
    after = bump_epoch(cfg, "bearer_epoch")

    assert after["api_token"] != before["api_token"]
    assert derive_cookie_token(password, after["cookie_epoch"]) == \
        derive_cookie_token(password, before["cookie_epoch"])


def test_bump_rejects_non_epoch_key(tmp_path):
    from painapple_code.auth_middleware import bump_epoch
    cfg, _ = _seed_config(tmp_path)
    with pytest.raises(ValueError):
        bump_epoch(cfg, "password")


def test_malformed_epoch_still_derives_and_still_revokes(tmp_path):
    """Epochs are opaque discriminators, never parsed. A hand-typed garbage
    value must not fall back to the default — that would be a silently
    NON-revoking failure, the one direction this lever must never fail in."""
    from painapple_code.auth_middleware import bump_epoch, derive_api_token, sync_derived_config
    cfg, password = _seed_config(tmp_path, bearer_epoch="banana")
    out = sync_derived_config(cfg, password)
    assert out["api_token"] == derive_api_token(password, "banana")
    assert out["api_token"] != derive_api_token(password, 1)
    # And a bump off a malformed value still lands somewhere new.
    assert bump_epoch(cfg, "bearer_epoch")["api_token"] != out["api_token"]


# ---------------------------------------------------------------------------
# /api/auth/revoke — the lever, applied live
# ---------------------------------------------------------------------------

def test_revoke_browsers_kills_cookies_and_spares_scripts(app, client, test_password):
    """The property the whole epoch design exists for: 'log out everywhere'
    must not break CI."""
    old_cookie = client_token(test_password, "cookie")
    with TestClient(app, cookies={COOKIE_NAME: old_cookie}) as c:
        assert c.get("/api/sessions").status_code == 200

    r = client.post("/api/auth/revoke", json={"scope": "browsers"})
    assert r.status_code == 200
    assert r.json()["cookie_epoch"] == 2

    # Applied live — no restart needed.
    with TestClient(app, cookies={COOKIE_NAME: old_cookie}) as c:
        assert c.get("/api/sessions").status_code == 401
    # ...and the Bearer client that issued the revoke is untouched.
    assert client.get("/api/sessions").status_code == 200


def test_revoke_scripts_kills_tokens_and_spares_browsers(app, client, test_password):
    cookie = client_token(test_password, "cookie")
    r = client.post("/api/auth/revoke", json={"scope": "scripts"})
    assert r.status_code == 200
    assert r.json()["bearer_epoch"] == 2

    # The Bearer credential that made the call has just revoked itself.
    assert client.get("/api/sessions").status_code == 401
    with TestClient(app, cookies={COOKIE_NAME: cookie}) as c:
        assert c.get("/api/sessions").status_code == 200


def test_revoke_persists_to_disk(app, client, test_config_file):
    client.post("/api/auth/revoke", json={"scope": "browsers"})
    assert yaml.safe_load(test_config_file.read_text())["cookie_epoch"] == 2


def test_revoke_rejects_unknown_scope(client):
    r = client.post("/api/auth/revoke", json={"scope": "everything"})
    assert r.status_code == 400
    assert r.json()["error"] == "invalid_scope"


def test_revoke_rejects_non_json(client):
    r = client.post("/api/auth/revoke", content=b"not json")
    assert r.status_code == 400


def test_revoke_requires_auth(unauth_client):
    r = unauth_client.post("/api/auth/revoke", json={"scope": "browsers"})
    assert r.status_code == 401


def test_revoke_is_csrf_gated(app, test_password):
    """Ambient credential + state-changing method: a hostile page must not be
    able to log the user out of everything (or knock their CI offline)."""
    c = TestClient(app, cookies={COOKIE_NAME: client_token(test_password, "cookie")})
    r = c.post("/api/auth/revoke", json={"scope": "browsers"},
               headers={"Origin": "http://evil.example"})
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Auth-event log — observation, not enforcement
# ---------------------------------------------------------------------------

@pytest.fixture
def fresh_identity_table():
    from painapple_code import auth_middleware as am
    am._SEEN_AUTH.clear()
    am._seen_auth_full = False
    yield am
    am._SEEN_AUTH.clear()
    am._seen_auth_full = False


def _identity_records(caplog):
    return [r for r in caplog.records if r.name == "painapple-code.auth"]


def test_identity_logged_once_per_client(fresh_identity_table, caplog):
    """Deduped: a busy server must log once per NEW client, not once per
    request, or the signal drowns in its own noise."""
    import logging as _logging
    am = fresh_identity_table
    with caplog.at_level(_logging.INFO, logger="painapple-code.auth"):
        am.record_auth_identity("cookie", "10.0.0.1", "UA/1")
        am.record_auth_identity("cookie", "10.0.0.1", "UA/1")
        am.record_auth_identity("cookie", "10.0.0.2", "UA/1")   # new IP
        am.record_auth_identity("bearer", "10.0.0.1", "UA/1")   # new path
    assert len(_identity_records(caplog)) == 3


def test_identity_table_is_bounded(fresh_identity_table, caplog):
    """A UA-randomising client must not grow this table without limit."""
    import logging as _logging
    am = fresh_identity_table
    with caplog.at_level(_logging.INFO, logger="painapple-code.auth"):
        for i in range(am._SEEN_AUTH_CAP + 50):
            am.record_auth_identity("cookie", f"10.0.0.{i}", "UA/1")
    assert len(am._SEEN_AUTH) == am._SEEN_AUTH_CAP
    # cap entries + exactly one "table full" line, not 50 of them
    assert len(_identity_records(caplog)) == am._SEEN_AUTH_CAP + 1


def test_identity_log_carries_no_credential(app, test_password, fresh_identity_table, caplog):
    """The whole point is that this is safe to leave on: it records how and
    from where, never what."""
    import logging as _logging
    with caplog.at_level(_logging.INFO, logger="painapple-code.auth"):
        with TestClient(app, cookies={COOKIE_NAME: client_token(test_password)}) as c:
            c.get("/api/sessions")
    records = _identity_records(caplog)
    assert records, "an authenticated request should record its identity"
    blob = " ".join(r.getMessage() for r in records)
    assert "via=cookie" in blob
    for secret in (test_password,
                   client_token(test_password, "cookie"),
                   client_token(test_password, "bearer")):
        assert secret not in blob


def test_download_token_grants_are_not_identities(app, test_password, fresh_identity_table, caplog):
    """?dl= is a deliberately shareable one-URL grant (iPad PWA -> Safari).
    Logging its recipients as identities would be noise, not signal."""
    import logging as _logging
    token, _ = mint_download_token(test_password, "/api/sessions")
    with caplog.at_level(_logging.INFO, logger="painapple-code.auth"):
        with TestClient(app) as c:
            c.get(f"/api/sessions?dl={token}")
    assert not _identity_records(caplog)


# ---------------------------------------------------------------------------
# Download tokens (?dl=) — mint/check units, endpoint, middleware integration
# ---------------------------------------------------------------------------

def test_download_token_roundtrip():
    token, exp = mint_download_token("pw", "/api/file-raw?path=%2Ftmp%2Fa.txt")
    assert check_download_token(token, "pw", "/api/file-raw?path=%2Ftmp%2Fa.txt")
    assert exp > 0


def test_download_token_bound_to_exact_url():
    token, _ = mint_download_token("pw", "/api/file-raw?path=%2Ftmp%2Fa.txt")
    assert not check_download_token(token, "pw", "/api/file-raw?path=%2Fetc%2Fpasswd")
    assert not check_download_token(token, "pw", "/api/sessions")


def test_download_token_expires():
    token, _ = mint_download_token("pw", "/x", ttl=60, now=1000.0)
    assert check_download_token(token, "pw", "/x", now=1050.0)
    assert not check_download_token(token, "pw", "/x", now=1061.0)


def test_download_token_tamper_rejected():
    token, _ = mint_download_token("pw", "/x")
    exp_str, _, sig = token.partition(".")
    assert not check_download_token(f"{exp_str}.{'0' * len(sig)}", "pw", "/x")
    # Bumped expiry invalidates the signature
    assert not check_download_token(f"{int(exp_str) + 9999}.{sig}", "pw", "/x")
    # Garbage shapes
    assert not check_download_token("", "pw", "/x")
    assert not check_download_token("not-a-token", "pw", "/x")
    assert not check_download_token("123", "pw", "/x")


def test_download_token_wrong_password_rejected():
    token, _ = mint_download_token("pw", "/x")
    assert not check_download_token(token, "other-pw", "/x")


def test_mint_endpoint_requires_auth(unauth_client):
    r = unauth_client.post(
        "/api/auth/download-token", json={"url": "/api/file-raw?path=%2Ftmp%2Fa"}
    )
    assert r.status_code == 401


def test_mint_endpoint_returns_tokenized_url(client, test_password):
    r = client.post(
        "/api/auth/download-token", json={"url": "/api/file-raw?path=%2Ftmp%2Fa"}
    )
    assert r.status_code == 200
    data = r.json()
    assert data["url"].startswith("/api/file-raw?path=%2Ftmp%2Fa&dl=")
    assert data["token"] in data["url"]
    # Never embeds the password
    assert test_password not in data["url"]
    assert check_download_token(data["token"], test_password, "/api/file-raw?path=%2Ftmp%2Fa")


@pytest.mark.parametrize("body", [
    {},
    {"url": 123},
    {"url": "https://evil.example/x"},
    {"url": "//evil.example/x"},
    {"url": "relative/path"},
    {"url": "/x\\evil"},
])
def test_mint_endpoint_rejects_bad_urls(client, body):
    r = client.post("/api/auth/download-token", json=body)
    assert r.status_code == 400


def test_dl_token_authorizes_request_without_cookie(client, unauth_client):
    minted = client.post(
        "/api/auth/download-token", json={"url": "/api/sessions"}
    ).json()
    r = unauth_client.get(f"/api/sessions?dl={minted['token']}")
    assert r.status_code == 200
    # Critical: a short-lived dl token must NOT grant the 30-day cookie
    assert "set-cookie" not in {k.lower() for k in r.headers.keys()}


def test_dl_token_rejected_on_other_url(client, unauth_client):
    minted = client.post(
        "/api/auth/download-token", json={"url": "/api/sessions"}
    ).json()
    r = unauth_client.get(f"/api/welcome/projects?dl={minted['token']}")
    assert r.status_code == 401


def test_invalid_dl_rejected(unauth_client):
    r = unauth_client.get("/api/sessions?dl=123.deadbeef")
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# Allowlist + CORS preflight
# ---------------------------------------------------------------------------

def test_allowlist_no_auth(unauth_client):
    for path in (
        "/health",
        "/login",
        "/sw.js",
        "/manifest.json",
        "/static/css/login.css",
        "/static/js/login.js",
    ):
        r = unauth_client.get(path, follow_redirects=False)
        assert r.status_code != 401, f"{path} returned 401 — should be allowlisted"
        assert r.status_code != 302, f"{path} returned 302 — should be allowlisted"


def test_login_page_assets_are_all_public(unauth_client):
    """Every asset the login page references must be reachable pre-auth.

    Regression guard for the class of bug where login.html grows a new
    <script>/<link> and nobody adds it to PUBLIC_PATHS. The failure is
    quiet and nasty: the 401 body is served as the asset, so login.js
    never runs, the form loses its submit handler, and the browser does
    a native GET submit that puts the password in the URL and the
    server logs. Asserting on the allowlist alone wouldn't catch it —
    this parses the page the user actually gets.
    """
    page = unauth_client.get("/login", follow_redirects=False)
    assert page.status_code == 200

    refs = set(re.findall(r'(?:src|href)="(/static/[^"?#]+)"', page.text))
    assert refs, "no /static/ assets found in login.html — regex out of date?"

    for path in sorted(refs):
        r = unauth_client.get(path, follow_redirects=False)
        assert r.status_code == 200, (
            f"login page references {path} but it returned {r.status_code} "
            f"without auth — add it to PUBLIC_PATHS in auth_middleware.py"
        )


from painapple_code import bridge_paths


def _login_config(client):
    """Pull the #login-config JSON data block out of the served /login page."""
    page = client.get("/login", follow_redirects=False)
    assert page.status_code == 200
    m = re.search(
        r'<script type="application/json" id="login-config">(.*?)</script>',
        page.text,
        re.S,
    )
    assert m, "login-config data block missing from /login"
    return json.loads(m.group(1).replace("\\u003c", "<"))


def test_login_config_marks_custom_config_non_default(unauth_client):
    """A tmp_path-backed instance must NOT advertise `painapple password`.

    That verb reads the default config path with no --auth-config-file
    equivalent, so on a custom-config instance it prints some OTHER
    instance's password — a wrong answer that looks like a right one. The
    page falls back to awk against the real path in that case.
    """
    cfg = _login_config(unauth_client)
    assert cfg["configIsDefault"] is False
    assert cfg["configPath"] != str(bridge_paths.CONFIG_HOME / "config.yaml")


def test_login_config_marks_default_config_default(unauth_client):
    """On the default path the two agree, so the CLI command is offered."""
    from painapple_code.server import app

    default = str(bridge_paths.CONFIG_HOME / "config.yaml")
    saved = app.state.auth_config_file
    app.state.auth_config_file = default
    try:
        cfg = _login_config(unauth_client)
        assert cfg["configIsDefault"] is True
        assert cfg["configPath"] == default
    finally:
        app.state.auth_config_file = saved


def test_options_preflight_passes_through(unauth_client):
    r = unauth_client.options(
        "/api/sessions",
        headers={
            "Origin": "https://bridge.example.com",
            "Access-Control-Request-Method": "GET",
        },
    )
    # Either 200 or 204 — the point is it's not 401
    assert r.status_code != 401


# ---------------------------------------------------------------------------
# Secure flag via X-Forwarded-Proto
# ---------------------------------------------------------------------------

def test_secure_cookie_via_forwarded_proto(app, test_password):
    # httpx.Client persists cookies across requests within a TestClient, so
    # use separate clients for the two probes — otherwise the second one
    # presents the cookie from the first and skips the tkn branch entirely.
    with TestClient(app) as c:
        r = c.get(f"/api/sessions?tkn={client_token(test_password, 'tkn')}")
    assert "Secure" not in r.headers.get("set-cookie", "")

    with TestClient(app) as c:
        r = c.get(
            f"/api/sessions?tkn={client_token(test_password, 'tkn')}",
            headers={"X-Forwarded-Proto": "https"},
        )
    assert "Secure" in r.headers.get("set-cookie", "")


# ---------------------------------------------------------------------------
# /api/login and /api/logout
# ---------------------------------------------------------------------------

def test_login_returns_sanitized_next(unauth_client, test_password):
    r = unauth_client.post(
        "/api/login",
        json={"password": test_password, "next": "https://evil.com/"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["next"] == "/app"  # evil URL sanitized to /app


def test_login_preserves_safe_next(unauth_client, test_password):
    r = unauth_client.post(
        "/api/login",
        json={"password": test_password, "next": "/app?session=abc"},
    )
    assert r.status_code == 200
    assert r.json()["next"] == "/app?session=abc"


def test_login_strips_tkn_from_next(unauth_client, test_password):
    r = unauth_client.post(
        "/api/login",
        json={"password": test_password, "next": "/foo?tkn=leak&bar=1"},
    )
    assert r.status_code == 200
    assert "tkn" not in r.json()["next"]
    assert "bar=1" in r.json()["next"]


def test_login_wrong_password_401(unauth_client):
    r = unauth_client.post(
        "/api/login",
        json={"password": "nope", "next": ""},
    )
    assert r.status_code == 401


def test_login_sets_cookie_with_derived_token(unauth_client, test_password):
    r = unauth_client.post(
        "/api/login",
        json={"password": test_password, "next": ""},
    )
    assert r.status_code == 200
    cookie = r.headers.get("set-cookie", "")
    assert client_token(test_password) in cookie
    assert test_password not in cookie  # must never leak raw password
    assert "HttpOnly" in cookie
    assert "samesite=lax" in cookie.lower()


@pytest.mark.parametrize("body", [
    {"password": 123},                  # int password
    {"password": ["x"]},                # list password
    {"password": {"nested": "x"}},      # dict password
    {"password": True},                 # bool password (isinstance(True, int))
    {"password": "pw", "next": 123},    # int next
    {"password": "pw", "next": ["x"]},  # list next
    {"password": "pw", "next": {}},     # dict next
    [],                                 # top-level non-object
    "garbage",                          # top-level string (valid JSON, invalid shape)
    42,                                 # top-level int
])
def test_login_non_string_fields_return_400(unauth_client, body):
    """Malformed bodies must return 400, not 500 — caught by pentest 2026-04-24."""
    r = unauth_client.post("/api/login", json=body)
    assert r.status_code == 400
    assert r.json() == {"error": "invalid_body"}


def test_logout_clears_cookie_matching_attrs(unauth_client):
    r = unauth_client.post("/api/logout")
    assert r.status_code == 200
    cookie = r.headers.get("set-cookie", "")
    assert f"{COOKIE_NAME}=" in cookie
    # delete_cookie issues Max-Age=0 or past Expires
    assert "Max-Age=0" in cookie or "Expires=Thu, 01 Jan 1970" in cookie


# ---------------------------------------------------------------------------
# WebSocket auth
# ---------------------------------------------------------------------------

def _expect_ws_close(client, url, expected_code):
    """Connect and assert the server closes with `expected_code`.

    Starlette's WebSocketTestSession.__exit__ hangs when the server
    already sent a close frame, so we avoid the context manager and read
    ASGI messages until we see websocket.close (or WebSocketDisconnect,
    depending on Starlette version).
    """
    from starlette.websockets import WebSocketDisconnect
    ws = client.websocket_connect(url)
    ws.__enter__()
    try:
        for _ in range(10):
            msg = ws.receive()
            if msg.get("type") == "websocket.close":
                assert msg.get("code") == expected_code
                return
        pytest.fail("did not observe close within 10 messages")
    except WebSocketDisconnect as e:
        assert e.code == expected_code
    finally:
        try:
            ws.close()
        except Exception:
            pass


def test_ws_chat_unauthed_accepts_then_closes_1008(app):
    client = TestClient(app)
    _expect_ws_close(client, "/chat", 1008)


def test_ws_terminal_unauthed_accepts_then_closes_1008(app):
    client = TestClient(app)
    _expect_ws_close(client, "/ws/terminal", 1008)


def _first_close_code(client, url):
    """Open a WS, read one message; if it's a close, return its code."""
    from starlette.websockets import WebSocketDisconnect
    ws = client.websocket_connect(url)
    try:
        ws.__enter__()
    except WebSocketDisconnect as e:
        return e.code
    try:
        msg = ws.receive()
        if msg.get("type") == "websocket.close":
            return msg.get("code")
        return None  # got a non-close message — auth was accepted
    except WebSocketDisconnect as e:
        return e.code
    finally:
        try:
            ws.close()
        except Exception:
            pass


@pytest.fixture
def app_with_bridge(app, tmp_path, monkeypatch):
    """Stub the global bridge so authed WS handlers don't crash on attribute
    access. We only care that auth was accepted; actual session mechanics
    are out of scope for the auth tests."""
    from painapple_code.services.agent_session import AgentBridge
    app.state.bridge = AgentBridge(default_cwd=str(tmp_path))
    yield app


def test_ws_authed_via_tkn_not_1008(app_with_bridge, test_password):
    """tkn-authed WS must not be rejected with 1008 (auth success).

    The handler may still close later for other reasons, but not with
    1008 — that's the auth-specific reject code.
    """
    client = TestClient(app_with_bridge)
    code = _first_close_code(client, f"/chat?tkn={client_token(test_password, 'tkn')}")
    assert code != 1008, f"unexpected auth rejection, got close code {code}"


def test_ws_authed_via_cookie_not_1008(app_with_bridge, test_password):
    cookie_token = client_token(test_password)
    client = TestClient(app_with_bridge, cookies={COOKIE_NAME: cookie_token})
    code = _first_close_code(client, "/chat")
    assert code != 1008, f"unexpected auth rejection, got close code {code}"


def test_ws_terminal_authed_via_tkn_not_1008(app_with_bridge, test_password):
    client = TestClient(app_with_bridge)
    code = _first_close_code(client, f"/ws/terminal?tkn={client_token(test_password, 'tkn')}")
    assert code != 1008, f"unexpected auth rejection, got close code {code}"


# ---------------------------------------------------------------------------
# Access log redaction
# ---------------------------------------------------------------------------

def test_access_log_redacts_tkn():
    from painapple_code.server_logging import redact_query
    assert redact_query("tkn=secret") == "tkn=REDACTED"
    assert redact_query("foo=1&tkn=secret") == "foo=1&tkn=REDACTED"
    assert redact_query("tkn=a&tkn=b") == "tkn=REDACTED&tkn=REDACTED"
    assert redact_query("foo=1") == "foo=1"
    assert redact_query("") == ""


# ──── permission hardening on filesystems that refuse it ─────────────────

def test_config_survives_a_dir_it_cannot_chmod(tmp_path, monkeypatch):
    """chmod needs OWNERSHIP, not write permission — it raises EPERM on a
    config dir bind-mounted from the host into a container whenever the
    container's user isn't the owner. That used to kill the server on
    boot before it served a request (podman machine on macOS)."""
    import errno
    import os as _os
    from painapple_code import bridge_paths
    from painapple_code.auth_middleware import ensure_config_file

    real_chmod = _os.chmod

    def refuse_dirs(path, mode, *a, **kw):
        if Path(path).is_dir():
            raise PermissionError(errno.EPERM, "Operation not permitted")
        return real_chmod(path, mode, *a, **kw)

    monkeypatch.setattr(bridge_paths.os, "chmod", refuse_dirs)

    password, created = ensure_config_file(tmp_path / "cfg" / "config.yaml")
    assert created and len(password) > 20
    # The file we CAN lock down is still locked down.
    assert stat.S_IMODE((tmp_path / "cfg" / "config.yaml").stat().st_mode) == 0o600


def test_lock_mode_skips_chmod_when_already_correct(tmp_path, monkeypatch):
    """The common case must not even call chmod — that's what keeps a
    correctly-set-up bind mount off the failure path entirely."""
    from painapple_code import bridge_paths

    target = tmp_path / "already"
    target.mkdir(mode=0o700)
    os.chmod(target, 0o700)

    calls = []
    monkeypatch.setattr(bridge_paths.os, "chmod",
                        lambda *a, **kw: calls.append(a))
    bridge_paths.lock_mode(target, 0o700)
    assert calls == []
    bridge_paths.lock_mode(target, 0o755)
    assert len(calls) == 1
