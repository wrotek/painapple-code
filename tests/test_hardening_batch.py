"""Regression tests for the 2026-08-07 trivial hardening batch.

Covers:
  T2  — uploaded files are served inert (attachment + nosniff + private cache)
  T3  — server-side renderers are OFF by default (503, no Node subprocess)
  T10 — the /static/js cache-bust route cannot escape its root
  T11 — Windows UNC / device / reserved-name paths are refused

All tests use the tmp_path-backed `app`/`client` fixtures from conftest.py —
nothing touches the real ~/.painapple-code or ~/.config data.
"""

import pytest

from painapple_code.routes.dependencies import get_session_store


# ---------------------------------------------------------------------------
# T2 — inert upload serving
# ---------------------------------------------------------------------------

class _FakeStore:
    """Minimal stand-in exposing just the _uploads_dir hook the route uses."""

    def __init__(self, uploads_dir):
        self._d = uploads_dir

    def _uploads_dir(self, session_id):  # noqa: ARG002 - signature match
        return self._d


@pytest.fixture
def uploads(app, tmp_path):
    """Point the uploads route at a tmp dir with one raster + one active file."""
    d = tmp_path / "uploads"
    d.mkdir()
    (d / "pic.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
    (d / "evil.html").write_text("<script>alert(1)</script>")
    (d / "evil.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')
    app.dependency_overrides[get_session_store] = lambda: _FakeStore(d)
    yield d
    app.dependency_overrides.clear()


def test_uploaded_html_served_as_inert_attachment(client, uploads):
    resp = client.get("/api/sessions/sess1/uploads/evil.html")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/octet-stream")
    assert resp.headers["content-disposition"].startswith("attachment")
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["cache-control"] == "private, no-store"


def test_uploaded_svg_served_as_inert_attachment(client, uploads):
    # SVG is image-shaped but scriptable — must NOT be inline image/svg+xml.
    resp = client.get("/api/sessions/sess1/uploads/evil.svg")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/octet-stream")
    assert resp.headers["content-disposition"].startswith("attachment")
    assert "image/svg" not in resp.headers["content-type"]


def test_uploaded_png_served_inline_with_nosniff(client, uploads):
    resp = client.get("/api/sessions/sess1/uploads/pic.png")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/png"
    # Inline (no attachment disposition) so <img> preview still works...
    assert "attachment" not in resp.headers.get("content-disposition", "")
    # ...but never sniffable and never publicly cached.
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["cache-control"] == "private, no-store"


def test_upload_response_never_public_cached(client, uploads):
    for name in ("pic.png", "evil.html", "evil.svg"):
        resp = client.get(f"/api/sessions/sess1/uploads/{name}")
        assert "public" not in resp.headers.get("cache-control", "")


# ---------------------------------------------------------------------------
# T3 — renderers disabled by default
# ---------------------------------------------------------------------------

def test_chart_render_disabled_by_default(client):
    # create_app() never sets app.state.renderers_enabled -> secure default off.
    resp = client.post("/api/chart/render", content=b'{"mark":"bar"}')
    assert resp.status_code == 503


def test_excalidraw_render_disabled_by_default(client):
    resp = client.post("/api/excalidraw/render", content=b'{"type":"excalidraw"}')
    assert resp.status_code == 503


def test_disabled_renderer_never_spawns_node(app, client, monkeypatch):
    """The whole point: a disabled renderer must short-circuit BEFORE the
    Node subprocess (which carries the SSRF/file-read vector) is invoked."""
    import painapple_code.routes.api_viewer as viewer

    def _boom(*a, **k):
        raise AssertionError("render_chart must not run while renderers are disabled")

    monkeypatch.setattr(viewer, "render_chart", _boom)
    resp = client.post("/api/chart/render", content=b'{"mark":"bar"}')
    assert resp.status_code == 503


def test_chart_render_runs_when_enabled(app, client, monkeypatch):
    import painapple_code.routes.api_viewer as viewer

    app.state.renderers_enabled = True

    async def _fake_render(body, dark_mode=False):  # noqa: ARG001
        return "<svg>ok</svg>"

    monkeypatch.setattr(viewer, "render_chart", _fake_render)
    resp = client.post("/api/chart/render", content=b'{"mark":"bar"}')
    assert resp.status_code == 200
    assert resp.text == "<svg>ok</svg>"
    # Reset so other tests keep the secure default.
    app.state.renderers_enabled = False


# ---------------------------------------------------------------------------
# T10 — static-JS traversal containment
# ---------------------------------------------------------------------------

def test_static_js_serves_real_file(client):
    resp = client.get("/static/js/app.js")
    assert resp.status_code == 200
    assert "javascript" in resp.headers["content-type"]


def test_static_js_traversal_blocked(client):
    # Encoded ../ so the client doesn't collapse the dot-segments before send.
    resp = client.get("/static/js/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd")
    assert resp.status_code == 404
    assert "root:x:0:0" not in resp.text


# ---------------------------------------------------------------------------
# T11 — Windows path namespaces the POSIX deny-list never covered
# ---------------------------------------------------------------------------
#
# On win32, /proc,/sys,/dev don't exist, so the read/write gate degraded to
# "allow everything". Two of the things it then allowed are not merely
# exotic — a UNC path makes Windows authenticate OUTBOUND to an arbitrary
# host, turning "open this file" into an NTLM-hash exfiltration primitive,
# and the device namespaces do something other than read a file.
#
# _is_windows_path_allowed is pure string/parts work over PureWindowsPath,
# so this runs (and fails) on Linux CI too — the point is that the rule
# can't silently rot on the platform nobody's test box runs.

from pathlib import PureWindowsPath

from painapple_code.utils.file_paths import _is_windows_path_allowed


@pytest.mark.parametrize("path", [
    r"\\attacker.example.com\share\payload",   # outbound SMB -> NTLM leak
    r"\\192.168.1.5\c$\Windows",
    r"\\.\PhysicalDrive0",                     # device namespace
    r"\\?\C:\Users\me\x",                      # extended-length namespace
    r"C:\tmp\nul",                             # reserved names, any directory
    r"C:\tmp\NUL.txt",                         # ...with or without extension
    r"C:\tmp\con.log",
    r"C:\tmp\COM1",
    r"C:\tmp\lpt9.dat",
    "C:\\tmp\\nul. ",                          # NTFS strips trailing dot/space
])
def test_windows_denied_paths(path):
    assert not _is_windows_path_allowed(PureWindowsPath(path)), path


@pytest.mark.parametrize("path", [
    r"C:\Users\me\proj\app.js",
    r"D:\data\notes.md",
    r"C:\tmp\console.js",      # reserved name as a PREFIX is fine
    r"C:\tmp\nullable.py",
    r"C:\tmp\lpt10.txt",       # only LPT1-9 are reserved
    r"C:\tmp\communicate.md",
])
def test_windows_allowed_paths(path):
    assert _is_windows_path_allowed(PureWindowsPath(path)), path


# ---------------------------------------------------------------------------
# T12 — lock_mode is not a silent no-op on Windows
# ---------------------------------------------------------------------------
#
# os.chmod on Windows only toggles FILE_ATTRIBUTE_READONLY and returns
# SUCCESS, so `lock_mode(config, 0o600)` protected nothing while looking
# like it had — and the `except OSError` warning could never fire to say
# so. The replacement shells icacls; these tests pin the argv, because
# dropping /inheritance:r is the difference between "owner only" and
# "still whatever the parent directory grants".

def _capture_icacls(monkeypatch, bridge_paths):
    """Stub subprocess.run and hand back the dict that records argv."""
    seen = {}

    class _Result:
        returncode = 0
        stdout = "processed file: x"
        stderr = ""

    def _fake_run(argv, **kwargs):
        seen["argv"] = argv
        return _Result()

    monkeypatch.setattr(bridge_paths.subprocess, "run", _fake_run)
    return seen


def test_lock_mode_windows_builds_owner_only_icacls(monkeypatch, tmp_path):
    from painapple_code import bridge_paths

    seen = _capture_icacls(monkeypatch, bridge_paths)
    monkeypatch.setattr(bridge_paths, "_current_user_sid",
                        lambda: "S-1-5-21-1-2-3-1002")

    target = tmp_path / "config.yaml"
    target.write_text("password: x")
    bridge_paths._lock_mode_windows(target, 0o600)

    argv = seen["argv"]
    assert argv[0] == "icacls"
    assert str(target) in argv
    # Without this, inherited ACEs survive and the "restriction" is a lie.
    assert "/inheritance:r" in argv
    # /grant:r (replace), not /grant (add) — and full control for the owner.
    assert "/grant:r" in argv
    # SID form, `*`-prefixed — see the regression test below for why.
    assert "*S-1-5-21-1-2-3-1002:F" in argv


def test_lock_mode_windows_never_uses_userdomain(monkeypatch, tmp_path):
    """Regression: %USERDOMAIN%\\%USERNAME% is unresolvable on a workgroup box.

    USERDOMAIN there is the literal "WORKGROUP", which maps to no SID, so
    icacls fails 1332 and the file keeps whatever its parent granted. Seen
    live on the Windows test VM against the config holding the auth password.
    """
    from painapple_code import bridge_paths

    seen = _capture_icacls(monkeypatch, bridge_paths)
    monkeypatch.setattr(bridge_paths, "_current_user_sid", lambda: None)
    monkeypatch.setenv("USERNAME", "alice")
    monkeypatch.setenv("USERDOMAIN", "WORKGROUP")

    target = tmp_path / "config.yaml"
    target.write_text("password: x")
    bridge_paths._lock_mode_windows(target, 0o600)

    argv = seen["argv"]
    assert "WORKGROUP\\alice:F" not in argv
    # Falls back to the bare name, which does resolve against the local machine.
    assert "alice:F" in argv


def test_lock_mode_windows_skips_group_readable_modes(monkeypatch, tmp_path):
    """0o644 isn't owner-only; tightening it to owner-only would be wrong."""
    from painapple_code import bridge_paths

    called = []
    monkeypatch.setattr(bridge_paths.subprocess, "run",
                        lambda *a, **k: called.append(a) or None)
    target = tmp_path / "public.txt"
    target.write_text("x")
    bridge_paths._lock_mode_windows(target, 0o644)
    assert not called


def test_lock_mode_windows_warns_once_on_failure(monkeypatch, tmp_path, caplog):
    """A failed restriction must be LOUD (once), never silent."""
    import logging

    from painapple_code import bridge_paths

    class _Fail:
        returncode = 1
        stdout = ""
        stderr = "Access is denied."

    monkeypatch.setattr(bridge_paths.subprocess, "run", lambda *a, **k: _Fail())
    monkeypatch.setenv("USERNAME", "alice")
    bridge_paths._ACL_WARNED.clear()

    target = tmp_path / "config.yaml"
    target.write_text("password: x")
    with caplog.at_level(logging.WARNING):
        bridge_paths._lock_mode_windows(target, 0o600)
        bridge_paths._lock_mode_windows(target, 0o600)  # repeat call

    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(warnings) == 1, "should warn exactly once per path"
    assert "Access is denied." in warnings[0].message
    bridge_paths._ACL_WARNED.clear()


# ---------------------------------------------------------------------------
# T13 — upload filename sanitizer covers the NTFS name rules
# ---------------------------------------------------------------------------
#
# Enforced on EVERY platform, not just win32: uploads land in shared and
# synced directories, so a Linux-hosted bridge shouldn't be able to mint a
# name its Windows users cannot open. The trailing-dot case is the sharp
# one — NTFS silently strips it, so "report." and "report" are the same
# file, which is both a quiet overwrite and a way past a uniqueness check.

from painapple_code.routes.api_upload import sanitize_filename


@pytest.mark.parametrize("raw,expected", [
    ("report.txt", "report.txt"),
    ("../../etc/passwd", "passwd"),        # traversal (pre-existing behavior)
    ("nul", "_nul"),                       # reserved device names
    ("NUL.txt", "_NUL.txt"),
    ("con.log", "_con.log"),
    ("COM1", "_COM1"),
    ("report.", "report"),                 # NTFS strips trailing dot
    ("report ", "report"),                 # ...and trailing space
    ("a:b.txt", "a_b.txt"),                # alternate data stream syntax
    ('we"ird<>.txt', "we_ird__.txt"),      # characters NTFS rejects outright
    ("lpt10.txt", "lpt10.txt"),            # only LPT1-9 reserved
    ("console.js", "console.js"),          # reserved name as prefix is fine
])
def test_sanitize_filename(raw, expected):
    assert sanitize_filename(raw) == expected


@pytest.mark.parametrize("raw", ["", ".", "..", "...", "   "])
def test_sanitize_filename_rejects_empty_shapes(raw):
    with pytest.raises(ValueError):
        sanitize_filename(raw)
