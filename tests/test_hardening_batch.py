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
