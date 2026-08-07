"""Shared pytest fixtures for the bridge test suite.

Test isolation: every fixture writes to tmp_path so no test ever reads
~/.config/painapple-code/config.yaml. The server.create_app(config_file=...)
factory reinitializes auth state on the module-level app; tests run
serially so this mutation is safe.
"""

import pytest
import yaml


TEST_PASSWORD = "unit-test-password-do-not-reuse"


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
    # paths replace this with a real ClaudeBridge via app_with_bridge.
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
    return TestClient(app, headers={"Authorization": f"Bearer {test_password}"})
