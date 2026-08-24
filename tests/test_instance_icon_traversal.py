r"""`/instance-icons/{filename}` is public — it must not be a file read.

This is the only unauthenticated route that takes a filesystem name
(auth_middleware.PUBLIC_PREFIXES), so its `filename` is the one path
component that never passes an authenticated caller.

The route pattern `[^/]+` blocks POSIX traversal, which is why this was
invisible for as long as the server was Linux-only. A backslash is not a
slash: `%5C` survives both uvicorn's decode and the route match, and on
Windows it is a separator. `base / "C:\\..."` then discards the base
outright (pathlib does this for ANY absolute right-hand side), as does a
`\\host\share` UNC — which would also make `.exists()` authenticate
outbound to an attacker-controlled SMB server.

Reachable payoff was the server password at
~/.config/painapple-code/config.yaml, which per SECURITY.md is equivalent
to handing over a shell.

The guard is an allowlist on the NAME, so these assertions hold on every
platform and this test fails on Linux CI if the fix is reverted — the
HTTP-level checks alone would not, since the traversal targets don't
exist here.
"""

import pytest

from painapple_code.server import _ICON_NAME_RE, _safe_icon_path

REAL_ICONS = [
    "apple-touch-icon.png", "favicon-32.png", "favicon.ico",
    "icon-192.png", "icon-512.png", "icon-72.png",
]

ATTACKS = [
    # Windows absolute — pathlib discards the base entirely
    r"C:\Users\bob\.config\painapple-code\config.yaml",
    r"C:\Windows\win.ini",
    # UNC — base discarded AND outbound SMB auth on .exists()
    r"\\attacker\share\x.png",
    r"\\?\UNC\attacker\share\x.png",
    # Windows-separator traversal
    r"..\..\..\Windows\win.ini",
    r"..\..\.config\painapple-code\config.yaml",
    # POSIX forms, for completeness
    "../../../etc/passwd",
    "/etc/passwd",
    "..",
    ".",
    # Alternate data stream / DOS device
    "icon-192.png:hidden",
    "NUL:x.png",
    # Right extension, wrong shape
    r"..\evil.png",
    "sub/dir/icon.png",
]


@pytest.mark.parametrize("name", REAL_ICONS)
def test_real_icon_names_still_pass(name):
    """The guard must not break the icons the PWA manifest asks for."""
    assert _ICON_NAME_RE.match(name), f"legit icon {name} rejected"


@pytest.mark.parametrize("payload", ATTACKS)
def test_traversal_payloads_are_rejected(payload, tmp_path):
    assert _safe_icon_path(tmp_path, payload) is None, (
        f"{payload!r} was accepted — on Windows this is a pre-auth "
        "arbitrary file read"
    )


def test_non_image_extensions_are_rejected(tmp_path):
    """Even a well-formed basename must not serve arbitrary file types."""
    for name in ("config.yaml", "shadow.duckdb", "server.log", "meta.json"):
        assert _safe_icon_path(tmp_path, name) is None


def test_a_legit_name_resolves_inside_the_base(tmp_path):
    (tmp_path / "icon-192.png").write_bytes(b"\x89PNG")
    got = _safe_icon_path(tmp_path, "icon-192.png")
    assert got is not None
    assert got.is_relative_to(tmp_path.resolve())


def test_symlink_escaping_the_icons_dir_is_rejected(tmp_path):
    """A name can pass the regex and still point outside via a symlink."""
    outside = tmp_path / "secret.png"
    outside.write_bytes(b"secret")
    base = tmp_path / "icons"
    base.mkdir()
    (base / "icon-192.png").symlink_to(outside)
    assert _safe_icon_path(base, "icon-192.png") is None


def test_public_route_does_not_serve_traversal_over_http(client):
    """End-to-end: still public (not 401), but never 200 on a payload."""
    for payload in ("C:%5CWindows%5Cwin.ini",
                    "..%5C..%5C..%5CWindows%5Cwin.ini",
                    "%5C%5Cattacker%5Cshare%5Cx.png"):
        r = client.get(f"/instance-icons/{payload}")
        assert r.status_code == 404, f"{payload} -> {r.status_code}"


def test_public_route_is_still_public(client):
    """Guard against 'fixing' this by dropping the allowlist entry: the
    icons must keep loading before login, or the login page loses them."""
    r = client.get("/instance-icons/icon-192.png")
    assert r.status_code != 401
