"""Shared pytest fixtures for the bridge test suite.

Test isolation: every fixture writes to tmp_path so no test ever reads
~/.config/painapple-code/config.yaml. The server.create_app(config_file=...)
factory reinitializes auth state on the module-level app; tests run
serially so this mutation is safe.
"""

import pytest
import yaml


# test_cli_compat.py is NOT a pytest module — it's a standalone, paid
# CLI-upgrade harness (run explicitly: `python tests/test_cli_compat.py`).
# It needs an authenticated Claude CLI and each full run costs real API
# tokens. Its test_* functions return TestResult objects for the script's
# own runner instead of asserting, so pytest collection would count them
# as vacuous passes. Keep it out of collection entirely.
collect_ignore = ["test_cli_compat.py"]


TEST_PASSWORD = "unit-test-password-do-not-reuse"


def client_token(password, kind="cookie"):
    """The credential value a client presents on a given auth path.

    Single source of truth for "what does a valid cookie / bearer / tkn look
    like". Every test that needs to construct one goes through here, so a
    change to the derivation lands in this function instead of a dozen
    scattered assertions.

    Deliberately NOT used by tests that exercise the derivation primitives
    themselves (test_derived_cookie_token_differs_from_password) — those must
    call the real function, or they'd be asserting this helper against itself.
    """
    from painapple_code.auth_middleware import derive_cookie_token

    if kind == "cookie":
        return derive_cookie_token(password)
    if kind in ("bearer", "tkn"):
        # Today both paths take the literal password. WP-02 phase 1 swaps
        # them for a derived api_token — one edit, here.
        return password
    raise ValueError(f"unknown auth kind: {kind!r}")


@pytest.fixture
def auth_token(test_password):
    """Fixture wrapper around client_token(), bound to the test password.

    Usage: auth_token() -> cookie value; auth_token("tkn") -> tkn value.
    """
    def _token(kind="cookie", password=None):
        return client_token(test_password if password is None else password, kind)
    return _token


@pytest.fixture
def test_config_file(tmp_path):
    """Per-test YAML config under tmp_path. Returns the Path."""
    d = tmp_path / "painapple-code"
    d.mkdir(mode=0o700)
    cfg = d / "config.yaml"
    cfg.write_text(yaml.safe_dump({"password": TEST_PASSWORD}))
    cfg.chmod(0o600)
    return cfg


@pytest.fixture
def test_password():
    return TEST_PASSWORD


@pytest.fixture
def app(test_config_file):
    """App with auth state pointed at the tmp_path config file."""
    from painapple_code.server import create_app
    app_ = create_app(config_file=test_config_file)
    # WS handlers read app.state.bridge before the auth check. Default to
    # None here so unauthed tests reach the auth-rejection path instead
    # of AttributeErroring out of the handler. Tests that exercise authed
    # paths replace this with a real AgentBridge via app_with_bridge.
    app_.state.bridge = None
    return app_


@pytest.fixture
def unauth_client(app):
    """TestClient with no auth header / cookie — exercises 401 / 302 paths."""
    from fastapi.testclient import TestClient
    return TestClient(app)


@pytest.fixture
def client(app, test_password):
    """TestClient pre-authed via Bearer. Cookie isn't set so responses don't
    leak a Set-Cookie header — tests that need cookie auth use a raw client
    and call /api/login (or inject the derived cookie directly)."""
    from fastapi.testclient import TestClient
    bearer = client_token(test_password, "bearer")
    return TestClient(app, headers={"Authorization": f"Bearer {bearer}"})
