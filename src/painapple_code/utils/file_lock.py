"""Cross-platform advisory file locking.

`fcntl` doesn't exist on Windows, and a bare module-level ``import fcntl``
is an import-time crash for everything that transitively imports the
module (this killed `shadow_git` → `agent_session` → `server` on win32;
see docs-ai/plans/2026-08-08-windows-native-port.md §1.1).

One context manager, exclusive + blocking, replacing the direct
``fcntl.flock(LOCK_EX)`` pattern:

    with FileLock(path.with_suffix(".lock")):
        ...critical section...

POSIX backs it with ``fcntl.flock``; Windows with ``msvcrt.locking`` on
the first byte (region locks may extend past EOF, so an empty lock file
is fine). The win32 branch polls ``LK_NBLCK`` with backoff rather than
calling ``LK_LOCK``: LK_LOCK blocks ~10s inside the CRT (one attempt per
second) before raising, so a caller-requested 2s timeout actually waited
9-10s and the 5s slow-lock warning could never fire on time (measured on
winvm 2026-08-09 — 9.2s to a ``timeout=2`` TimeoutError). The
non-blocking probe returns immediately, putting the deadline and warn
schedule under our own loop's control.

Why that matters: ``FileLock`` is entered synchronously from
``ShadowGit.track_modification``, which ``AgentBridge`` calls on the
asyncio event loop for the first Edit/Write of a turn. A retry loop that
swallows every ``OSError`` spins the whole bridge at 100% CPU forever the
moment the lock file is unopenable/unlockable for a non-contention
reason (EACCES/EINVAL/EBADF all return immediately, with no internal
sleep to throttle the loop). Anything not-contention is re-raised;
contention waits with bounded backoff and finally gives up with a
``TimeoutError`` (an ``OSError`` subclass, so existing handlers cover it)
rather than pinning a core until the process is killed.
"""

import logging
import sys
import time

logger = logging.getLogger(__name__)

__all__ = ["FileLock"]

# Contention on this lock means "another process is mid JSON read+write" —
# milliseconds. A minute of it means something is genuinely wedged, and
# hanging the event loop forever is worse than failing loudly.
LOCK_TIMEOUT = 60.0
LOCK_WARN_AFTER = 5.0
_BACKOFF_START = 0.02
_BACKOFF_MAX = 0.5


if sys.platform == "win32":
    import errno
    import msvcrt

    # MS CRT `_locking` failure codes (docs: "_locking"): EACCES is the
    # locking violation LK_NBLCK reports on contention — the retry case.
    # EDEADLOCK (LK_LOCK's give-up code) is kept for safety should the
    # mode ever change; EBADF/EINVAL are programming errors and must
    # propagate.
    _RETRYABLE = {
        getattr(errno, "EDEADLOCK", None),
        getattr(errno, "EDEADLK", None),
        errno.EACCES,
    } - {None}

    class FileLock:
        """Exclusive, blocking advisory lock on a dedicated lock file."""

        def __init__(self, path, timeout: float = LOCK_TIMEOUT):
            self._path = path
            self._timeout = timeout
            self._fh = None

        def __enter__(self):
            # "a" creates without truncating — truncation would race other
            # holders of the same lock file.
            fh = open(self._path, "a")
            try:
                self._acquire(fh)
            except BaseException:
                # __exit__ never runs when __enter__ raises, so the handle
                # would leak for the life of the process.
                fh.close()
                raise
            self._fh = fh
            return self

        def _acquire(self, fh):
            started = time.monotonic()
            deadline = started + self._timeout
            backoff = _BACKOFF_START
            warned = False
            while True:
                try:
                    fh.seek(0)
                    msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
                    return
                except OSError as e:
                    if e.errno not in _RETRYABLE:
                        raise
                    waited = time.monotonic() - started
                    if waited >= self._timeout:
                        raise TimeoutError(
                            f"could not lock {self._path} after "
                            f"{waited:.0f}s (held by another process)"
                        ) from e
                    if not warned and waited >= LOCK_WARN_AFTER:
                        warned = True
                        logger.warning(
                            f"still waiting on {self._path} after "
                            f"{waited:.0f}s — another process is holding it"
                        )
                # Bounded backoff — LK_NBLCK returns immediately, so this
                # sleep is the only thing between attempts and the only
                # thing keeping the loop off the CPU.
                time.sleep(min(backoff, max(0.0, deadline - time.monotonic())))
                backoff = min(backoff * 2, _BACKOFF_MAX)

        def __exit__(self, exc_type, exc, tb):
            try:
                self._fh.seek(0)
                msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
            finally:
                self._fh.close()
                self._fh = None
            return False

else:
    import fcntl

    class FileLock:
        """Exclusive, blocking advisory lock on a dedicated lock file."""

        def __init__(self, path, timeout: float = LOCK_TIMEOUT):
            self._path = path
            self._timeout = timeout   # accepted for API parity; flock blocks
            self._fh = None

        def __enter__(self):
            fh = open(self._path, "a")
            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            except BaseException:
                # Same leak as the win32 branch: __exit__ won't run.
                fh.close()
                raise
            self._fh = fh
            return self

        def __exit__(self, exc_type, exc, tb):
            try:
                fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
            finally:
                self._fh.close()
                self._fh = None
            return False
