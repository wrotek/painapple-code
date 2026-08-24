"""Cross-platform process helpers.

Concentrates every platform-dispatched process primitive in one module so
the rest of the codebase never touches ``os.kill``/``signal`` portability
directly (docs-ai/plans/2026-08-08-windows-native-port.md, "Cross-cutting").

Why not ``os.kill(pid, 0)`` for liveness: on Windows sig 0 is
``CTRL_C_EVENT``, and the call **returns success even for a dead pid**
(verified on Windows 11 2026-08-08) — every probe would report alive forever.
psutil answers correctly on all platforms, with the same
zombie-counts-as-alive semantics the POSIX idiom had.
"""

import logging
import shlex
import shutil
import signal
import subprocess
import sys

import psutil

logger = logging.getLogger(__name__)

__all__ = [
    "pid_alive",
    "popen_kwargs_detached",
    "interrupt_process",
    "kill_pid",
    "resolve_binary",
]


def pid_alive(pid) -> bool:
    """True if a process with this pid currently exists.

    Mirrors the POSIX ``os.kill(pid, 0)`` contract: existence, not health
    — zombies count as alive, permission errors count as alive.
    """
    if not pid:
        return False
    try:
        return psutil.pid_exists(pid)
    except Exception:
        # psutil raising here is exotic (invalid pid type); err on the
        # side the old idiom did for PermissionError: assume it exists.
        return True


def popen_kwargs_detached(fully_detached: bool = False) -> dict:
    """Spawn kwargs that isolate a child from the server's process group.

    POSIX: ``start_new_session=True`` (setsid), exactly as before.
    win32: ``CREATE_NEW_PROCESS_GROUP`` — start_new_session is silently
    ignored there (verified on Windows 11), and the new process group is the
    PREREQUISITE for ``interrupt_process``: CTRL_BREAK sent to a child
    without its own group lands on OUR group instead (a Windows 11 probe).

    ``fully_detached`` adds ``DETACHED_PROCESS`` on win32 for children
    that must outlive our console (``painapple start``); no-op on POSIX
    where setsid already covers it.
    """
    if sys.platform == "win32":
        flags = subprocess.CREATE_NEW_PROCESS_GROUP
        if fully_detached:
            flags |= subprocess.DETACHED_PROCESS
        return {"creationflags": flags}
    return {"start_new_session": True}


def _shares_our_console(pid) -> bool:
    """win32: is `pid` attached to OUR console? (CTRL_BREAK's real reach.)

    ``GenerateConsoleCtrlEvent`` only delivers to process groups attached
    to the caller's console. Sent anywhere else it does NOT error — it
    returns success and nothing happens (measured on Windows 11 2026-08-09: a
    ``DETACHED_PROCESS`` child survived CTRL_BREAK with no exception
    raised, while a same-console group child died with
    STATUS_CONTROL_C_EXIT). So "unsendable" cannot be detected by
    catching exceptions after the fact; it has to be decided BEFORE
    sending, from console membership. ``GetConsoleProcessList`` is that
    answer: the set of pids on our console. Returns 0 when we have no
    console at all (the ``painapple start`` detached-server case) —
    nothing can share it, so every interrupt escalates to terminate().
    """
    import ctypes

    kernel32 = ctypes.windll.kernel32
    count = 64
    while True:
        arr = (ctypes.c_uint32 * count)()
        n = kernel32.GetConsoleProcessList(arr, count)
        if n == 0:          # no console attached to this process
            return False
        if n <= count:
            return pid in arr[:n]
        count = n           # buffer too small; retry at the reported size


def interrupt_process(process) -> None:
    """Politely interrupt a child's current work (turn abort).

    POSIX: SIGINT, as always. win32: CTRL_BREAK_EVENT — the only
    interrupt Windows can deliver to another process; requires the child
    to have been spawned with ``popen_kwargs_detached()``. SIGINT there
    raises ``ValueError: Unsupported signal: 2`` (verified on Windows 11).

    Raises ProcessLookupError for an already-dead child, like the direct
    call did — callers keep their existing handling.

    win32 delivery is gated on console membership (see
    ``_shares_our_console``): CTRL_BREAK to a group outside our console
    is a SILENT no-op — no OSError, no effect — so an exception-based
    fallback never fires and Stop wedges with the UI stuck on
    "stopping". A child that can't hear CTRL_BREAK (``DETACHED_PROCESS``
    grandchildren of ``painapple start``, or any child once the server
    itself is console-less) is terminated instead: blunter than an
    interrupt, but the line-protocol callers using this path kill the
    process on stop anyway. The except arm stays as a belt for the
    ValueError/OSError shapes Python itself can raise.

    Callers therefore still never need a win32-only except arm — but the
    escalation itself can raise (a dead child, a permission problem), and
    that surfaces as the OSError/ProcessLookupError they already handle.
    """
    if sys.platform == "win32":
        if not _shares_our_console(process.pid):
            logger.warning(
                f"pid {process.pid} is not on our console — CTRL_BREAK "
                "cannot reach it; terminating instead")
            process.terminate()
            return
        try:
            process.send_signal(signal.CTRL_BREAK_EVENT)
        except (ValueError, OSError) as e:
            logger.warning(f"CTRL_BREAK unsendable ({e}); terminating child instead")
            process.terminate()
    else:
        process.send_signal(signal.SIGINT)


def kill_pid(pid) -> None:
    """Force-kill by pid: SIGKILL on POSIX, TerminateProcess on Windows.

    (signal.SIGKILL doesn't exist on win32 — psutil dispatches for us.)
    Missing process is not an error; anything else is best-effort logged.
    """
    try:
        psutil.Process(pid).kill()
    except psutil.NoSuchProcess:
        pass
    except Exception as e:
        logger.warning(f"kill_pid({pid}) failed: {e}")


def resolve_binary(name: str) -> str:
    """Resolve a bare program name for spawning, win32 only.

    npm-installed CLIs (claude, codex on some setups) are ``.cmd`` shims
    on Windows; ``CreateProcess`` won't execute a bare ``claude`` but
    handles the full ``...\\claude.cmd`` path ``shutil.which`` returns.
    POSIX returns the name untouched (exec does PATH lookup natively) so
    existing behavior — including configured absolute paths — is
    byte-identical there. Unresolvable names come back unchanged and
    fail at spawn with the same FileNotFoundError as today.
    """
    if sys.platform != "win32":
        return name
    return shutil.which(name) or name


def shell_join(argv: list[str]) -> str:
    """Render argv as a command the user can paste into THEIR shell.

    shlex.join quotes for POSIX sh, where a backslash is an escape — so a
    Windows path comes back single-quoted (``'C:\\Users\\me\\claude.cmd'
    auth login``). PowerShell reads a leading ``'...'`` as a string
    expression, not a command, so the "run this to log in" hint the UI
    shows was not runnable. list2cmdline applies Windows' own rules.
    """
    if sys.platform == "win32":
        return subprocess.list2cmdline(argv)
    return shlex.join(argv)


def force_utf8_stdio() -> None:
    """Reconfigure stdout/stderr to UTF-8 on win32; no-op on POSIX.

    Windows consoles default to a legacy codepage (cp1252/OEM), so the
    first ``→`` in ``--help`` or box-drawing char in the boot banner
    raises ``UnicodeEncodeError``. Call at process entry points (CLI
    main, SDK driver main). Works on redirected streams too, which is
    what makes the detached ``painapple start`` child safe. Streams
    without ``reconfigure`` (test doubles, pythonw) are left alone —
    ``errors="replace"`` keeps even OEM-codepage consoles from crashing,
    they just render mojibake instead.
    """
    if sys.platform != "win32":
        return
    for stream in (sys.stdout, sys.stderr):
        if stream is not None and hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (OSError, ValueError):
                pass
