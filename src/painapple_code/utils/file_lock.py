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
is fine). ``msvcrt.LK_LOCK`` only retries for ~10s before raising, so the
win32 branch loops to match flock's block-forever semantics.
"""

import sys

__all__ = ["FileLock"]


if sys.platform == "win32":
    import msvcrt

    class FileLock:
        """Exclusive, blocking advisory lock on a dedicated lock file."""

        def __init__(self, path):
            self._path = path
            self._fh = None

        def __enter__(self):
            # "a" creates without truncating — truncation would race other
            # holders of the same lock file.
            self._fh = open(self._path, "a")
            while True:
                try:
                    self._fh.seek(0)
                    msvcrt.locking(self._fh.fileno(), msvcrt.LK_LOCK, 1)
                    return self
                except OSError:
                    # LK_LOCK gave up after its internal ~10 retries;
                    # keep waiting like flock would.
                    continue

        def __exit__(self, exc_type, exc, tb):
            try:
                self._fh.seek(0)
                msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
            finally:
                self._fh.close()
            return False

else:
    import fcntl

    class FileLock:
        """Exclusive, blocking advisory lock on a dedicated lock file."""

        def __init__(self, path):
            self._path = path
            self._fh = None

        def __enter__(self):
            self._fh = open(self._path, "a")
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX)
            return self

        def __exit__(self, exc_type, exc, tb):
            try:
                fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
            finally:
                self._fh.close()
            return False
