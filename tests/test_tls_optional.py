"""`cryptography` is a platform-conditional dependency — keep it that way.

pyca/cryptography stopped publishing wheels for Windows/ARM64 (after 46.0.3)
and Intel macOS (after 48.0.1). pip ranks candidates by version *before*
wheel-vs-sdist, so on those platforms it resolves the newest version, finds no
wheel, and falls back to a Rust/maturin source build that fails on a stock box
— i.e. `pipx install painapple-code` was simply broken there.

The fix is a PEP 508 marker that drops cryptography from the default install on
exactly those platforms (it is only needed by tls_cert.py, which is imported
lazily and only when TLS is on), plus an opt-in `[tls]` extra that pins the
last wheel-shipping version per platform.

These tests lock in the three things that can silently rot:
  1. the base requirement stays markered, and the marker excludes exactly the
     abandoned platforms;
  2. the `[tls]` extra still covers *every* platform, so the documented
     `pip install painapple-code[tls]` never resolves to nothing;
  3. server.py's `_CRYPTOGRAPHY_GAP` (which drives the user-facing "install
     this" message) agrees with the packaging about which platforms are
     abandoned — a mismatch would hand users a pin that doesn't help.
"""

import re
import sys
import tomllib
from pathlib import Path

import pytest
from packaging.markers import Marker
from packaging.requirements import Requirement

REPO_ROOT = Path(__file__).resolve().parent.parent

# (label, marker environment, cryptography expected in the DEFAULT install)
PLATFORMS = [
    ("linux-x86_64", {"platform_machine": "x86_64", "sys_platform": "linux"}, True),
    ("linux-aarch64", {"platform_machine": "aarch64", "sys_platform": "linux"}, True),
    ("macos-arm64", {"platform_machine": "arm64", "sys_platform": "darwin"}, True),
    ("macos-intel", {"platform_machine": "x86_64", "sys_platform": "darwin"}, False),
    ("windows-x64", {"platform_machine": "AMD64", "sys_platform": "win32"}, True),
    ("windows-arm64", {"platform_machine": "ARM64", "sys_platform": "win32"}, False),
]


def _crypto_requirements(lines):
    out = []
    for raw in lines:
        # Strip trailing inline comments ("httpcore>=1.0  # why") before parsing.
        line = re.sub(r"(^|\s)#.*$", "", raw).strip()
        if not line:
            continue
        req = Requirement(line)
        if req.name.lower() == "cryptography":
            out.append(req)
    return out


@pytest.fixture(scope="module")
def base_reqs():
    text = (REPO_ROOT / "requirements.txt").read_text(encoding="utf-8")
    reqs = _crypto_requirements(text.splitlines())
    assert reqs, "no cryptography requirement found in requirements.txt"
    return reqs


@pytest.fixture(scope="module")
def tls_extra():
    with open(REPO_ROOT / "pyproject.toml", "rb") as fh:
        data = tomllib.load(fh)
    extras = data["project"]["optional-dependencies"]
    assert "tls" in extras, "the opt-in [tls] extra is gone — docs reference it"
    return [Requirement(item) for item in extras["tls"]]


def test_base_cryptography_is_platform_conditional(base_reqs):
    for req in base_reqs:
        assert req.marker is not None, (
            f"{req} has no environment marker — an unconditional cryptography "
            "requirement breaks `pip install` on Windows/ARM64 and Intel macOS, "
            "where upstream ships no wheel and the sdist needs a Rust toolchain."
        )


@pytest.mark.parametrize("label,env,expected", PLATFORMS)
def test_default_install_requires_cryptography_only_where_wheels_exist(
    base_reqs, label, env, expected
):
    required = any(req.marker.evaluate(env) for req in base_reqs)
    assert required is expected, (
        f"on {label} the default install "
        f"{'should' if expected else 'should NOT'} pull cryptography"
    )


@pytest.mark.parametrize("label,env,_expected", PLATFORMS)
def test_tls_extra_covers_every_platform(tls_extra, label, env, _expected):
    """`pip install painapple-code[tls]` must resolve to something everywhere."""
    matching = [r for r in tls_extra if r.marker is None or r.marker.evaluate(env)]
    assert len(matching) == 1, (
        f"on {label} the [tls] extra matched {len(matching)} cryptography pins "
        f"({[str(m) for m in matching]}) — it must match exactly one, or the "
        "documented install command either does nothing or self-conflicts."
    )


@pytest.mark.parametrize("label,env,_expected", PLATFORMS)
def test_tls_extra_pins_are_installable(tls_extra, label, env, _expected):
    """The pin for an abandoned platform must exclude the wheel-less versions."""
    last_wheel = {"windows-arm64": "46.0.3", "macos-intel": "48.0.1"}.get(label)
    req = next(r for r in tls_extra if r.marker is None or r.marker.evaluate(env))
    if last_wheel is None:
        assert req.specifier.contains("50.0.0"), (
            f"{label} has wheels upstream, so [tls] should track current "
            f"cryptography, got {req.specifier}"
        )
    else:
        assert req.specifier.contains(last_wheel), (
            f"{label}: [tls] pin {req.specifier} excludes {last_wheel}, the last "
            "version with a wheel — installing it would trigger a source build"
        )
        assert not req.specifier.contains("50.0.0"), (
            f"{label}: [tls] pin {req.specifier} allows 50.0.0, which ships no "
            "wheel there — pip would fall back to a failing source build"
        )


def test_tls_extra_and_base_agree_on_supported_platforms(base_reqs, tls_extra):
    """The extra is a no-op where cryptography is already a base dep."""
    env = {"platform_machine": "x86_64", "sys_platform": "linux"}
    base = next(r for r in base_reqs if r.marker.evaluate(env))
    extra = next(r for r in tls_extra if r.marker is None or r.marker.evaluate(env))
    assert str(base.specifier) == str(extra.specifier), (
        f"requirements.txt says {base.specifier} but the [tls] extra says "
        f"{extra.specifier}; they must not drift or `[tls]` would silently "
        "downgrade a supported platform"
    )


def test_server_gap_table_matches_the_packaging_markers(base_reqs):
    """server.py's advice table must name exactly the excluded platforms."""
    from painapple_code.server import _CRYPTOGRAPHY_GAP

    for label, env, expected_in_default in PLATFORMS:
        key = (env["platform_machine"], env["sys_platform"])
        has_advice = key in _CRYPTOGRAPHY_GAP
        assert has_advice is (not expected_in_default), (
            f"{label}: _CRYPTOGRAPHY_GAP {'has' if has_advice else 'lacks'} an "
            f"entry but the packaging marker says cryptography is "
            f"{'present' if expected_in_default else 'absent'} by default. The "
            "table drives the 'install this' message — it must match."
        )


def test_tls_unavailable_is_actionable_and_exits_nonzero(monkeypatch):
    import io
    import platform as platform_mod

    from painapple_code import server

    monkeypatch.setattr(platform_mod, "machine", lambda: "ARM64")
    monkeypatch.setattr(sys, "platform", "win32")
    buf = io.StringIO()
    monkeypatch.setattr(sys, "__stderr__", buf)

    with pytest.raises(SystemExit) as excinfo:
        server._tls_unavailable("auto", "0.0.0.0")

    assert excinfo.value.code == 1
    out = buf.getvalue()
    # The platform-specific pin, both install routes, and the escape hatch.
    assert "cryptography<=46.0.3" in out
    assert "painapple-code[tls]" in out
    assert "--tls off" in out
    # 'auto' must explain why TLS turned itself on.
    assert "0.0.0.0" in out


def test_tls_unavailable_falls_back_on_an_unlisted_platform(monkeypatch):
    import io
    import platform as platform_mod

    from painapple_code import server

    monkeypatch.setattr(platform_mod, "machine", lambda: "s390x")
    monkeypatch.setattr(sys, "platform", "linux")
    buf = io.StringIO()
    monkeypatch.setattr(sys, "__stderr__", buf)

    with pytest.raises(SystemExit):
        server._tls_unavailable("on", "127.0.0.1")

    out = buf.getvalue()
    assert "cryptography" in out
    assert "--tls off" in out
