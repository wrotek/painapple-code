"""The terminal's pbcopy shim: PATH wiring + the OSC 52 it emits.

The shim has to reach the *browser's* clipboard, so it speaks OSC 52 to
the controlling tty rather than touching any server-side clipboard. These
tests run it under a real pty (POSIX only — Windows terminals don't get
the shim) and decode what the terminal widget would receive.
"""

import base64
import os
import re
import subprocess
import sys

import pytest

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX pty shim")

if sys.platform != "win32":
    import pty
    from painapple_code.utils import pty_posix

OSC52 = re.compile(rb"\x1b\]52;c;([A-Za-z0-9+/=]*)\x07")


def _run_in_pty(cmd: str, env_extra=None) -> tuple[int, bytes]:
    """Run `sh -c cmd` with a pty as its controlling terminal; return (rc, tty output)."""
    env = dict(os.environ)
    env.pop("TMUX", None)
    env["PATH"] = pty_posix.with_term_bin(env.get("PATH", ""))
    env.update(env_extra or {})
    pid, fd = pty.fork()
    if pid == 0:  # child: the pty is our controlling terminal
        os.execvpe("sh", ["sh", "-c", cmd], env)
    out = b""
    while True:
        try:
            chunk = os.read(fd, 65536)
        except OSError:  # EIO once the child closes the slave
            break
        if not chunk:
            break
        out += chunk
    _, status = os.waitpid(pid, 0)
    os.close(fd)
    return os.waitstatus_to_exitcode(status), out


def test_term_bin_ships_executable_pbcopy():
    shim = os.path.join(pty_posix.TERM_BIN_DIR, "pbcopy")
    assert os.access(shim, os.X_OK)


def test_with_term_bin_appends_once():
    d = pty_posix.TERM_BIN_DIR
    assert pty_posix.with_term_bin("/usr/bin:/bin") == f"/usr/bin:/bin:{d}"
    once = pty_posix.with_term_bin("/usr/bin")
    assert pty_posix.with_term_bin(once) == once  # nested spawn: no duplicate
    assert pty_posix.with_term_bin("") == d


def test_pbcopy_emits_osc52_with_utf8_payload():
    text = "héllo 🍍\nsecond line\n"
    rc, out = _run_in_pty("printf '%s' \"$T\" | pbcopy >/dev/null", {"T": text})
    assert rc == 0
    m = OSC52.search(out)
    assert m, out
    assert base64.b64decode(m.group(1)).decode("utf-8") == text


def test_pbcopy_large_input_is_single_unwrapped_sequence():
    # GNU base64 wraps at 76 cols; a newline inside the payload would
    # corrupt it — the shim must strip them.
    rc, out = _run_in_pty("head -c 20000 /dev/zero | tr '\\0' a | pbcopy")
    assert rc == 0
    m = OSC52.search(out)
    assert m and base64.b64decode(m.group(1)) == b"a" * 20000


def test_pbcopy_wraps_in_tmux_passthrough():
    rc, out = _run_in_pty("printf x | pbcopy", {"TMUX": "/tmp/fake,1,0"})
    assert rc == 0
    assert b"\x1bPtmux;\x1b\x1b]52;c;eA==\x07\x1b\\" in out


def test_pbcopy_without_tty_fails_loudly():
    shim = os.path.join(pty_posix.TERM_BIN_DIR, "pbcopy")
    r = subprocess.run([shim], input=b"x", capture_output=True, start_new_session=True)
    assert r.returncode == 1
    assert b"no terminal" in r.stderr
