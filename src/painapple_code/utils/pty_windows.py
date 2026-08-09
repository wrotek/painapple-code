"""Windows pseudo-terminal backend — ConPTY via pywinpty.

Mirrors pty_posix.PosixPty's interface. Two Windows realities shape it:

1. `select` accepts only sockets on Windows, so the POSIX "poll the fd
   with a 0.1s timeout" loop can't be ported. pywinpty's `read()` blocks
   instead (it reads a loopback socket that pywinpty's own pump fills
   from the ConPTY), which suits a dedicated reader thread handing
   chunks to a queue — the same shape as the SDK driver's stdin pump.

2. There is no fork/exec: `PtyProcess.spawn` starts the shell and gives
   back a handle. Signals are replaced by terminate/kill, and the window
   size is set through the ConPTY API rather than a TIOCSWINSZ ioctl.

pywinpty's read channel is a `127.0.0.1` socket on an ephemeral port,
bound and accepted inside its constructor. That's a loopback-only,
immediately-consumed listener, but it does mean terminal output crosses
a local socket — worth knowing when reasoning about the trust boundary
on a shared machine.
"""

import logging
import os
import queue
import shutil
import threading

from winpty import PtyProcess as _WinPtyProcess

logger = logging.getLogger(__name__)

_READ_CHUNK = 4096


def _pick_shell() -> str:
    """PAINAPPLE_CODE_SHELL, else PowerShell 7, else Windows PowerShell."""
    override = os.environ.get("PAINAPPLE_CODE_SHELL")
    if override:
        return override
    return shutil.which("pwsh.exe") or "powershell.exe"


class WindowsPty:
    """A ConPTY-hosted shell, read by a background thread."""

    def __init__(self, proc, cwd: str):
        self._p = proc
        self.pid = proc.pid
        self.cwd = cwd
        self._q: queue.Queue = queue.Queue()
        self._eof = False
        self._closed = False
        self._reader = threading.Thread(
            target=self._pump, name=f"pty-read-{self.pid}", daemon=True
        )
        self._reader.start()

    def _pump(self) -> None:
        """Blocking-read the pty until it closes; b'' sentinel marks EOF."""
        while True:
            try:
                chunk = self._p.read(_READ_CHUNK)
            except EOFError:
                break
            except Exception as e:  # pty torn down under us (close/terminate)
                logger.debug(f"pty {self.pid} reader stopped: {type(e).__name__}: {e}")
                break
            if not chunk:
                break
            # pywinpty decodes to str (and already handles UTF-8 sequences
            # split across reads); the rest of the stack speaks bytes.
            self._q.put(chunk.encode("utf-8", "replace"))
        self._q.put(b"")

    # ── output ────────────────────────────────────────────────────────
    def read(self, timeout: float = 0.1) -> bytes | None:
        """None = nothing yet, b"" = EOF/child gone, bytes = output."""
        # Short-circuit once closed so a chunk still sitting in the queue
        # can't be handed out after teardown — PosixPty does the same with
        # its _closed flag, and the WS read loop relies on b"" being final.
        if self._eof or self._closed:
            return b""
        try:
            item = self._q.get(timeout=timeout)
        except queue.Empty:
            return None
        if item == b"":
            self._eof = True
            return b""
        return item

    # ── input ─────────────────────────────────────────────────────────
    def write(self, data: bytes) -> None:
        try:
            self._p.write(data.decode("utf-8", "replace"))
        except Exception as e:
            # Match the POSIX backend: a write to a dead pty is EOF, and
            # the WS loop already treats that as "terminal is over".
            raise EOFError(f"pty closed: {e}") from e

    # ── control ───────────────────────────────────────────────────────
    def set_size(self, rows: int, cols: int) -> None:
        self._p.setwinsize(rows, cols)

    def poll(self) -> int | None:
        """Exit code if the shell is gone, else None. Never blocks."""
        try:
            if self._p.isalive():
                return None
        except Exception:
            return -1
        status = getattr(self._p, "exitstatus", None)
        return -1 if status is None else status

    def terminate(self, force: bool = False) -> None:
        try:
            self._p.terminate(force=force)
        except Exception as e:
            logger.debug(f"pty {self.pid} terminate failed: {e}")

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._p.close(force=True)
        except Exception as e:
            logger.debug(f"pty {self.pid} close failed: {e}")

    def live_cwd(self) -> str | None:
        """The shell process's actual working directory.

        Note for PowerShell: `cd` moves its *provider location*, which is
        a shell-level concept it does not push down to the Win32 process
        CWD — so this tracks `cd` in cmd.exe but reports the spawn
        directory for a PowerShell session. Never wrong, sometimes stale.
        """
        try:
            import psutil
            return psutil.Process(self.pid).cwd()
        except Exception:
            return None


def _argv(shell: str) -> list[str]:
    """-NoLogo for the PowerShells; anything else gets spawned bare."""
    stem = os.path.basename(shell).lower()
    if stem.startswith(("powershell", "pwsh")):
        return [shell, "-NoLogo"]
    return [shell]


def spawn_pty(cwd: str, rows: int = 24, cols: int = 80) -> WindowsPty:
    shell = _pick_shell()
    argv = _argv(shell)

    # Inherit the server's environment, plus the hints color-aware CLIs
    # (including Claude Code itself) look for.
    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"

    try:
        proc = _WinPtyProcess.spawn(argv, cwd=cwd, env=env, dimensions=(rows, cols))
    except Exception as e:
        # A missing cwd is the common case (project dir deleted/renamed).
        # POSIX survives it — the forked child's os.chdir failure is
        # swallowed and the shell starts in the inherited directory — so
        # match that here instead of failing the whole terminal.
        logger.warning(f"PTY spawn in {cwd!r} failed ({e}); retrying in the user profile")
        home = os.path.expanduser("~")
        proc = _WinPtyProcess.spawn(argv, cwd=home, env=env, dimensions=(rows, cols))
        cwd = home

    return WindowsPty(proc, cwd)
