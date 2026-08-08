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

import psutil

logger = logging.getLogger(__name__)

__all__ = ["pid_alive"]


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
