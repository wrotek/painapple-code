"""POSIX pseudo-terminal backend — openpty + fork + execvp.

Lifted verbatim from routes/api_terminal.py when the Windows port needed
a seam; the syscall sequence, the O_NONBLOCK master, the 0.1s select
poll and the waitpid reaping are all unchanged, so POSIX terminals
behave exactly as before. Only the packaging moved.

Windows never imports this module (fcntl/pty/termios don't exist there).
"""

import errno
import fcntl
import logging
import os
import pty
import select
import signal
import struct
import termios

logger = logging.getLogger(__name__)


class PosixPty:
    """A forked shell attached to a pty master fd."""

    def __init__(self, master_fd: int, pid: int, cwd: str):
        self._fd = master_fd
        self.pid = pid
        self.cwd = cwd
        self._exit_code = None
        self._closed = False

    # ── output ────────────────────────────────────────────────────────
    def read(self, timeout: float = 0.1) -> bytes | None:
        """None = nothing yet, b"" = EOF/child gone, bytes = output."""
        if self._closed:
            return b""
        try:
            readable, _, _ = select.select([self._fd], [], [], timeout)
        except (OSError, ValueError):
            # fd closed under us (kill_terminal raced this read)
            return b""
        if not readable:
            return None
        try:
            return os.read(self._fd, 4096)
        except OSError as e:
            # EIO is how Linux reports "the slave side went away" — the
            # normal end of a terminal, not an error worth propagating.
            if e.errno == errno.EIO:
                return b""
            raise

    # ── input ─────────────────────────────────────────────────────────
    def write(self, data: bytes) -> None:
        try:
            os.write(self._fd, data)
        except OSError as e:
            if e.errno == errno.EIO:
                raise EOFError("pty closed") from e
            raise

    # ── control ───────────────────────────────────────────────────────
    def set_size(self, rows: int, cols: int) -> None:
        """Resize the pty and tell the foreground process group about it."""
        size = struct.pack('HHHH', rows, cols, 0, 0)
        fcntl.ioctl(self._fd, termios.TIOCSWINSZ, size)
        try:
            os.kill(self.pid, signal.SIGWINCH)
        except OSError:
            pass

    def poll(self) -> int | None:
        """Exit code if the child is reaped, else None. Never blocks."""
        if self._exit_code is not None:
            return self._exit_code
        try:
            result_pid, status = os.waitpid(self.pid, os.WNOHANG)
        except ChildProcessError:
            # Already reaped (or never ours) — treat as a clean exit, as
            # the pre-seam code did.
            self._exit_code = 0
            return self._exit_code
        if result_pid != self.pid:
            return None
        if os.WIFEXITED(status):
            self._exit_code = os.WEXITSTATUS(status)
        elif os.WIFSIGNALED(status):
            self._exit_code = -os.WTERMSIG(status)
        else:
            self._exit_code = -1
        return self._exit_code

    def terminate(self, force: bool = False) -> None:
        try:
            os.kill(self.pid, signal.SIGKILL if force else signal.SIGTERM)
        except OSError:
            pass

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            os.close(self._fd)
        except OSError:
            pass

    def live_cwd(self) -> str | None:
        """Where the shell actually is right now, tracking the user's cd."""
        try:
            return os.readlink(f"/proc/{self.pid}/cwd")
        except OSError:
            return None  # macOS, or the shell exited


def spawn_pty(cwd: str, rows: int = 24, cols: int = 80) -> PosixPty:
    master_fd, slave_fd = pty.openpty()

    size = struct.pack('HHHH', rows, cols, 0, 0)
    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, size)

    pid = os.fork()

    if pid == 0:
        # Child process
        os.close(master_fd)
        os.setsid()

        try:
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        except (OSError, AttributeError):
            pass

        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)

        if slave_fd > 2:
            os.close(slave_fd)

        try:
            os.chdir(cwd)
        except OSError:
            pass

        os.environ['TERM'] = 'xterm-256color'
        os.environ['COLORTERM'] = 'truecolor'

        shell = os.environ.get('SHELL', '/bin/bash')
        os.execvp(shell, [shell, '-i'])

    # Parent process
    os.close(slave_fd)

    flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
    fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    return PosixPty(master_fd, pid, cwd)
