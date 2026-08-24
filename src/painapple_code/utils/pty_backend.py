"""Platform seam for the interactive terminal's pseudo-terminal.

`routes/api_terminal.py` drives a shell through this interface and stays
platform-free: spawn, read, write, resize, reap, kill. Two implementations:

- POSIX (`pty_posix.py`) — `pty.openpty()` + `fork` + `execvp`, `select`
  on the master fd. This is the original inline implementation, moved
  verbatim; POSIX behavior is unchanged.
- Windows (`pty_windows.py`) — ConPTY via `pywinpty`. `select` on Windows
  accepts only sockets, so the read side is a blocking reader thread
  feeding a queue (same shape as the SDK driver's stdin pump).

The read contract is what lets one loop serve both:

    read(timeout) -> None   nothing available yet (poll again)
                  -> b""    the pty closed / child exited (stop, then poll())
                  -> bytes  output

Callers must treat the payload as opaque bytes: the terminal WebSocket
stores it in the scrollback ring and decodes with errors="replace" only
at the WS boundary.
"""

import sys

# Import failures are a supported state, not a crash: a POSIX box always
# has pty/fcntl, but a Windows box without the optional pywinpty gets a
# server with every feature EXCEPT the terminal tab, and a startup
# warning naming the fix. server.py turns this into the client-visible
# `terminal_available` capability flag.
PTY_AVAILABLE = False
PTY_UNAVAILABLE_REASON = None
_spawn = None

try:
    if sys.platform == "win32":
        from painapple_code.utils.pty_windows import spawn_pty as _spawn
    else:
        from painapple_code.utils.pty_posix import spawn_pty as _spawn
    PTY_AVAILABLE = True
except ImportError as e:
    PTY_UNAVAILABLE_REASON = (
        f"pywinpty is required for the terminal on Windows ({e}); "
        "install it with: pip install pywinpty"
        if sys.platform == "win32"
        else f"no pseudo-terminal support on this platform ({e})"
    )


def spawn_pty(cwd: str, rows: int = 24, cols: int = 80):
    """Start a login-ish interactive shell in `cwd`. Returns a PtyProcess.

    Raises RuntimeError when no backend is available — callers should
    check PTY_AVAILABLE (or let the router stay unmounted) rather than
    relying on the exception.
    """
    if _spawn is None:
        raise RuntimeError(PTY_UNAVAILABLE_REASON or "no PTY backend")
    return _spawn(cwd, rows, cols)
