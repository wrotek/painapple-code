"""CLI fast-path regression tests.

`cli.main()` must resolve argparse errors, `-v`, and `serve --help`
WITHOUT importing `painapple_code.server` (~300ms of fastapi/routers).
Wall-clock assertions are flaky, so the regression fence is the module
set: after each fast-path outcome, `fastapi` and `painapple_code.server`
must be absent from `sys.modules`.

Standalone — no bridge server required (unlike the API suite).
"""

import os
import subprocess
import sys
import tempfile

import pytest

FORBIDDEN = "'fastapi' not in sys.modules and 'painapple_code.server' not in sys.modules"


def run_cli(args_literal: str) -> subprocess.CompletedProcess:
    """Run cli.main(<args>) in a clean interpreter; report exit code and
    whether heavy modules stayed unimported (LIGHT/HEAVY on stderr).
    PAINAPPLE_CODE_HOME is isolated so profile-aware verbs never touch
    (or migrate) the real data home."""
    code = f"""
import sys
rc = 0
try:
    from painapple_code.cli import main
    rc = main({args_literal})
except SystemExit as e:
    rc = e.code if isinstance(e.code, int) or e.code is None else 2
print("LIGHT" if ({FORBIDDEN}) else "HEAVY", file=sys.stderr)
sys.exit(rc or 0)
"""
    env = {**os.environ,
           "PAINAPPLE_CODE_HOME": tempfile.mkdtemp(prefix="pa-cli-test-")}
    env.pop("PAINAPPLE_PROFILE", None)
    return subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True,
        timeout=30, env=env,
    )


def assert_light(proc):
    assert "LIGHT" in proc.stderr, f"server/fastapi was imported on a fast path:\n{proc.stderr}"


def test_bad_flag_fast():
    proc = run_cli("['--bogus']")
    assert proc.returncode == 2
    assert "unrecognized arguments" in proc.stderr
    assert_light(proc)


def test_bad_positional_fast():
    proc = run_cli("['lst']")  # typo'd subcommand falls through to serve parser
    assert proc.returncode == 2
    assert "unrecognized arguments" in proc.stderr
    assert_light(proc)


def test_version_fast():
    proc = run_cli("['-v']")
    assert proc.returncode == 0
    assert proc.stdout.startswith("painapple ")
    assert_light(proc)


def test_serve_help_fast():
    proc = run_cli("['serve', '--help']")
    assert proc.returncode == 0
    assert "--workspace" in proc.stdout          # full flag dump
    assert "painapple help" in proc.stdout       # subcommands epilog
    assert_light(proc)


def test_front_door_help_fast():
    proc = run_cli("['-h']")
    assert proc.returncode == 0
    assert "Claude Code in your browser" in proc.stdout  # curated overview
    assert_light(proc)


def test_lifecycle_no_match_fast():
    """A target that is neither a saved profile nor a running instance
    fails fast + light (label/pid/port matching scans ps, not fastapi)."""
    proc = run_cli("['start', 'bad/name']")
    assert proc.returncode == 1
    assert "matches no saved profile and no running instance" in proc.stderr
    assert_light(proc)


def test_lifecycle_stop_rejects_flags_fast():
    proc = run_cli("['stop', 'somename', '--port', '1']")
    assert proc.returncode == 2
    assert "stop takes no flags" in proc.stderr
    assert_light(proc)


def test_lifecycle_unknown_profile_fast(tmp_path):
    """Unknown profile → helpful error, no empty deployment spawned."""
    import os
    code = f"""
import os, sys
os.environ['PAINAPPLE_CODE_HOME'] = {str(tmp_path)!r}
rc = 0
try:
    from painapple_code.cli import main
    rc = main(['start', 'nosuch'])
except SystemExit as e:
    rc = e.code if isinstance(e.code, int) or e.code is None else 2
print("LIGHT" if ({FORBIDDEN}) else "HEAVY", file=sys.stderr)
sys.exit(rc or 0)
"""
    proc = subprocess.run([sys.executable, "-c", code],
                          capture_output=True, text=True, timeout=30)
    assert proc.returncode == 1
    assert "matches no saved profile" in proc.stderr
    assert not (tmp_path / "profiles" / "nosuch").exists()
    assert_light(proc)


def test_docker_group_moved_fast():
    """The retired `painapple docker` group fails fast + light with a
    pointer to the unified verbs."""
    proc = run_cli("['docker', 'up', '-d']")
    assert proc.returncode == 2
    assert "moved" in proc.stderr
    assert "--in-docker" in proc.stdout
    assert_light(proc)


def test_manage_unknown_profile_fast():
    proc = run_cli("['status', 'nosuch']")
    assert proc.returncode == 1
    assert "No profile named" in proc.stderr
    assert_light(proc)


def test_gate_and_server_share_parser():
    """Both callers must build from the same parser (single source of truth)."""
    from painapple_code.cli.serve_args import build_parser

    args = build_parser().parse_args(["--port", "8890"])
    assert args.port == 8890
    assert args.host == "127.0.0.1"
    assert args.workspace == "."
    assert args.tls == "auto"

    import painapple_code.server as server

    assert server.build_parser is build_parser


# ---------------------------------------------------------------------------
# Startup credential visibility (WP-02 stopgap)
# ---------------------------------------------------------------------------

def test_credentials_hidden_on_non_loopback_bind():
    """The ?tkn= login URL / password print only on loopback binds by
    default: a LAN/public server's stdout tends to outlive the terminal
    (journald, docker logs, supervisor consoles)."""
    from painapple_code.server import credentials_visible

    for host in ("127.0.0.1", "::1", "localhost"):
        assert credentials_visible(host, no_password=False, show_password=False)
    for host in ("0.0.0.0", "::", "192.168.1.10", "example.com"):
        assert not credentials_visible(host, no_password=False, show_password=False)


def test_show_password_opts_back_in_no_password_always_wins():
    from painapple_code.server import credentials_visible

    assert credentials_visible("0.0.0.0", no_password=False, show_password=True)
    assert not credentials_visible("127.0.0.1", no_password=True, show_password=False)
    assert not credentials_visible("0.0.0.0", no_password=True, show_password=False)


def test_password_flags_parse_and_exclude():
    import pytest
    from painapple_code.cli.serve_args import build_parser

    args = build_parser().parse_args([])
    assert args.no_password is False
    assert args.show_password is False

    assert build_parser().parse_args(["--show-password"]).show_password is True
    assert build_parser().parse_args(["--no-password"]).no_password is True

    with pytest.raises(SystemExit):
        build_parser().parse_args(["--no-password", "--show-password"])
