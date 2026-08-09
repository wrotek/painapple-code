"""Cross-platform process helpers.

Concentrates every platform-dispatched process primitive in one module so
the rest of the codebase never touches ``os.kill``/``signal`` portability
directly (docs-ai/plans/2026-08-08-windows-native-port.md, "Cross-cutting").

Why not ``os.kill(pid, 0)`` for liveness: on Windows sig 0 is
``CTRL_C_EVENT``, and the call **returns success even for a dead pid**
(verified on winvm 2026-08-08) — every probe would report alive forever.
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
    ignored there (verified on winvm), and the new process group is the
    PREREQUISITE for ``interrupt_process``: CTRL_BREAK sent to a child
    without its own group lands on OUR group instead (winvm probe 1c2).

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


def interrupt_process(process) -> None:
    """Politely interrupt a child's current work (turn abort).

    POSIX: SIGINT, as always. win32: CTRL_BREAK_EVENT — the only
    interrupt Windows can deliver to another process; requires the child
    to have been spawned with ``popen_kwargs_detached()``. SIGINT there
    raises ``ValueError: Unsupported signal: 2`` (verified on winvm).

    Raises ProcessLookupError for an already-dead child, like the direct
    call did — callers keep their existing handling.

    On win32 an unsendable CTRL_BREAK escalates to ``terminate()``, and
    "unsendable" is BOTH shapes, not just ValueError:

    * ``ValueError`` — Python refusing the signal number outright.
    * ``OSError`` — ``GenerateConsoleCtrlEvent`` failing, which is the
      realistic case: a bridge launched by ``painapple start NAME`` is
      spawned with ``popen_kwargs_detached(fully_detached=True)``, i.e.
      ``DETACHED_PROCESS`` — it has no console at all, so the call comes
      back ``[WinError 6] The handle is invalid``. Catching only
      ValueError meant the documented terminate() escalation never fired;
      callers swallow OSError, so Stop was a silent no-op with the UI
      stuck on "stopping".

    Callers therefore still never need a win32-only except arm — but the
    escalation itself can raise (a dead child, a permission problem), and
    that surfaces as the OSError/ProcessLookupError they already handle.
    """
    if sys.platform == "win32":
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
