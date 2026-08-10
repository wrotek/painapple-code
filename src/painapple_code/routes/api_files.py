"""
Files API Routes - File operations for the file browser

These endpoints provide file listing, reading, writing, and search
functionality for the web client's file browser and autocomplete.
"""

import asyncio
import json
import logging
import os
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from painapple_code import bridge_paths
from painapple_code.utils.file_paths import (
    PATH_DENIED_DETAIL,
    is_path_allowed,
    is_path_allowed_for_read,
    resolve_project_dir,
    resolve_project_files,
    safe_resolve,
    verify_file_paths,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["files"])


# ═══════════════════════════════════════════════════════════════════════
# File Listing
# ═══════════════════════════════════════════════════════════════════════

@router.get("/api/files")
async def list_files(path: str = "."):
    """List files in a directory (for file browser)."""
    try:
        p = safe_resolve(path)
        if not is_path_allowed_for_read(p):
            raise HTTPException(status_code=403, detail=PATH_DENIED_DETAIL)
        if not p.exists():
            raise HTTPException(status_code=404, detail="Path not found")
        if not p.is_dir():
            raise HTTPException(status_code=400, detail="Not a directory")

        files = []
        for item in sorted(p.iterdir()):
            try:
                st = item.stat()
                mtime = st.st_mtime
                size = st.st_size if item.is_file() else None
            except (OSError, PermissionError):
                mtime = 0
                size = None
            files.append({
                "name": item.name,
                "path": str(item),
                "is_dir": item.is_dir(),
                "size": size,
                "mtime": mtime,
            })

        return {"path": str(p), "files": files}
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")


# Mirrors the fd --exclude list below (and the old find -not -path set).
_WALK_SKIP_DIRS = {'node_modules', '.git', '__pycache__', 'venv', '.venv',
                   'dist', 'build', '.next', 'coverage'}
_WALK_SKIP_NAMES = {'.DS_Store'}
_WALK_MAX_FILES = 50000  # same order as fd's practical ceiling; keeps a
                         # runaway tree from pinning a worker thread
_WALK_TIMEOUT = 15.0     # matches the `find` budget this path replaced
                         # (5s spawn + 10s communicate)


def _walk_files(directory: Path, deadline: float | None = None) -> tuple[list[str], bool]:
    """Relative file paths under `directory`, POSIX-separated.

    Returns (paths, truncated) — truncated is True when the file cap or the
    deadline cut the walk short, so the caller can tell the client its list
    is partial instead of silently serving a prefix of the project.

    Runs in a worker thread (os.walk is blocking). Separators are
    normalized so the client gets the same shape fd produces, and so
    Windows results don't arrive with backslashes the @-autocomplete
    can't match.

    `deadline` (a time.monotonic value) is checked once per directory. It
    bounds the WORKER; the caller separately bounds the REQUEST, because a
    single scandir stuck on a dead NFS/sshfs mount is uninterruptible and
    no in-loop check can preempt it.
    """
    out = []
    root = str(directory)
    for dirpath, dirnames, filenames in os.walk(root):
        if deadline is not None and time.monotonic() > deadline:
            return out, True
        dirnames[:] = [d for d in dirnames if d not in _WALK_SKIP_DIRS]
        # Once per directory, not once per file: os.walk already knows
        # dirpath, and relpath abspath-normalizes and splits BOTH arguments
        # on every call — 50k of them at the cap, for a prefix that changes
        # only when the directory does.
        rel_dir = os.path.relpath(dirpath, root)
        prefix = '' if rel_dir == os.curdir else rel_dir.replace(os.sep, '/') + '/'
        for name in filenames:
            if name in _WALK_SKIP_NAMES or name.endswith('.pyc'):
                continue
            out.append(prefix + name)
            if len(out) >= _WALK_MAX_FILES:
                return out, True
    return out, False


async def _enumerate_files(directory: Path, include_ignored: bool = False) -> tuple[list[str], bool]:
    """
    Enumerate files in a directory using fd (falls back to a Python walk).
    Returns (relative paths within the directory, truncated).

    When `include_ignored` is True, .gitignore'd and hidden files are included
    (fd's --no-ignore --hidden). The hardcoded `--exclude` list still applies
    so node_modules/.git etc. are never returned regardless.
    """
    # Try fd first (respects .gitignore by default)
    try:
        fd_args = [
            'fd', '--type', 'f', '--relative-path',
            '--exclude', 'node_modules',
            '--exclude', '.git',
            '--exclude', '__pycache__',
            '--exclude', 'venv',
            '--exclude', '.venv',
            '--exclude', '*.pyc',
            '--exclude', '.DS_Store',
            '--exclude', 'dist',
            '--exclude', 'build',
            '--exclude', '.next',
            '--exclude', 'coverage',
        ]
        if include_ignored:
            fd_args += ['--no-ignore', '--hidden']
        result = await asyncio.wait_for(
            asyncio.create_subprocess_exec(
                *fd_args,
                cwd=str(directory),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            ),
            timeout=5.0
        )
        stdout, stderr = await asyncio.wait_for(result.communicate(), timeout=10.0)

        if result.returncode == 0:
            # `.replace(os.sep, '/')`, matching _walk_files: fd emits
            # OS-native separators, so on Windows this branch returned
            # `src\app.js` while the fallback returned `src/app.js` — one
            # endpoint with two shapes depending on whether fd happened to
            # be installed. The client scores the user's typed `src/app`
            # against that string and checks `changedSet.has(path)` against
            # shadow-git paths that are always forward-slashed, so both
            # silently missed on the fd machine. Keyed off os.sep rather
            # than replacing '\\' unconditionally, because on POSIX a
            # backslash is an ordinary filename byte.
            return [f.replace(os.sep, '/') for f in stdout.decode().strip().split('\n') if f], False
        raise FileNotFoundError("fd failed")

    except (FileNotFoundError, asyncio.TimeoutError):
        # Fallback: pure-Python walk. This used to shell out to `find`,
        # which on Windows resolves to find.exe — a COMPLETELY different
        # tool (it greps for a string in files). It doesn't error on this
        # argv, it just prints something else, so the @-autocomplete file
        # list would have been silently wrong rather than empty. os.walk
        # also drops the last non-Python dependency of this endpoint.
        #
        # Like `find`, this doesn't read .gitignore, so include_ignored
        # stays a no-op on the fallback path.
        #
        # Bounded on both sides. The `find` path it replaced had two
        # timeouts (5s spawn + 10s communicate) and the executor handoff
        # had none, so one directory on a hung autofs/NFS/sshfs mount held
        # a shared ThreadPoolExecutor worker forever and the request never
        # returned. wait_for can't kill the thread — nothing can — but it
        # returns the request, and the in-walk deadline lets the thread
        # retire as soon as it comes back from the stuck syscall.
        loop = asyncio.get_running_loop()
        deadline = time.monotonic() + _WALK_TIMEOUT
        return await asyncio.wait_for(
            loop.run_in_executor(None, _walk_files, directory, deadline),
            timeout=_WALK_TIMEOUT + 1.0,
        )


@router.get("/api/files/list")
async def list_project_files(cwd: str, refresh: bool = False, include_ignored: bool = False):
    """
    List all files in a project for @ autocomplete.
    Uses 'fd' command for fast enumeration, falls back to find.
    Also includes files from extra_dirs in project config.

    `include_ignored=true` returns .gitignore'd and hidden files as well
    (used by the file explorer's "Include ignored" search toggle).
    """
    try:
        p = safe_resolve(cwd)
        if not p.exists() or not p.is_dir():
            raise HTTPException(status_code=404, detail="Directory not found")

        # Enumerate project files (relative paths)
        files, walk_truncated = await _enumerate_files(p, include_ignored=include_ignored)

        # Load extra_dirs: merge global (all projects) + project-specific
        try:
            global_config = bridge_paths.load_global_config()
            global_extra = global_config.get("extra_dirs", [])
        except Exception as e:
            logger.warning(f"Failed to load global config for extra_dirs: {e}")
            global_extra = []
        try:
            project_config_path = bridge_paths.get_project_config_path(str(p))
            if project_config_path.exists():
                project_config = json.loads(project_config_path.read_text(encoding="utf-8"))
                project_extra = project_config.get("extra_dirs", [])
            else:
                project_extra = []
        except Exception as e:
            logger.warning(f"Failed to load project config for extra_dirs: {e}")
            project_extra = []
        # Combine both, deduplicate, preserve order
        seen = set()
        extra_dirs = []
        for d in global_extra + project_extra:
            resolved = str(safe_resolve(d))
            if resolved not in seen:
                seen.add(resolved)
                extra_dirs.append(d)

        # Enumerate files from each extra directory (absolute paths)
        for extra_dir in extra_dirs:
            extra_path = safe_resolve(extra_dir)
            if not extra_path.is_dir():
                logger.warning(f"Extra dir not found: {extra_dir}")
                continue
            try:
                extra_files, extra_truncated = await _enumerate_files(
                    extra_path, include_ignored=include_ignored
                )
                walk_truncated = walk_truncated or extra_truncated
                for f in extra_files:
                    files.append(str(extra_path / f))
            except Exception as e:
                logger.warning(f"Failed to enumerate extra dir {extra_dir}: {e}")

        # Also get directories (for drilling down)
        dirs = []
        try:
            for item in p.iterdir():
                if item.is_dir() and not item.name.startswith('.') and item.name not in (
                    'node_modules', '__pycache__', 'venv', '.venv', 'dist', 'build', '.next', 'coverage'
                ):
                    dirs.append(item.name + '/')
        except PermissionError:
            pass

        if walk_truncated:
            logger.warning(
                f"File enumeration hit its cap under {p} — returning a partial list"
            )

        return {
            "cwd": str(p),
            "files": sorted(files)[:20000],  # 20k files ≈ 1MB JSON
            "directories": sorted(dirs),
            "total": len(files),
            # Either cap counts: the 20k response budget, or the walk's own
            # 50k/15s ceiling. The latter used to cut the list off with no
            # signal at all, so the client rendered a partial project as a
            # complete one and an @-mention that found nothing looked like
            # a missing file.
            "truncated": len(files) > 20000 or walk_truncated,
        }

    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="File listing timed out")
    except Exception as e:
        logger.error(f"Error listing files: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════
# File Read/Write
# ═══════════════════════════════════════════════════════════════════════

@router.get("/api/file")
async def read_file(path: str):
    """Read a file's contents (for file viewer)."""
    try:
        p = safe_resolve(path)
        if not is_path_allowed_for_read(p):
            raise HTTPException(status_code=403, detail=PATH_DENIED_DETAIL)
        if not p.exists():
            raise HTTPException(status_code=404, detail="File not found")
        if not p.is_file():
            raise HTTPException(status_code=400, detail="Not a file")
        if p.stat().st_size > 1_000_000:  # 1MB limit
            raise HTTPException(status_code=400, detail="File too large")

        return {"path": str(p), "content": p.read_text(encoding="utf-8", errors='replace'), "mtime": p.stat().st_mtime}
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")


@router.get("/api/file/stat")
async def file_stat(path: str):
    """Lightweight file stat (mtime + size) without reading content."""
    try:
        p = safe_resolve(path)
        if not is_path_allowed_for_read(p):
            raise HTTPException(status_code=403, detail=PATH_DENIED_DETAIL)
        if not p.exists():
            return {"path": str(p), "exists": False, "mtime": 0, "size": 0}
        st = p.stat()
        return {"path": str(p), "exists": True, "mtime": st.st_mtime, "size": st.st_size}
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")


class WriteFileRequest(BaseModel):
    path: str
    content: str


# How much of an existing file to sniff for its line-ending style. A file's
# convention is established in its first few hundred lines or not at all.
_EOL_SNIFF_BYTES = 65536


def _file_is_crlf(p: Path) -> bool:
    """Is this existing file written entirely with CRLF line endings?

    True only when the sniffed prefix has at least one `\\r\\n` and no bare
    `\\n` at all. Deliberately strict: see `write_file`.
    """
    try:
        with open(p, "rb") as fh:
            head = fh.read(_EOL_SNIFF_BYTES)
    except OSError:
        return False
    # A cut exactly between CR and LF would otherwise read as a bare CR
    # followed (in the next chunk we never see) by a bare LF.
    if head.endswith(b"\r"):
        head = head[:-1]
    lf = head.count(b"\n")
    return lf > 0 and head.count(b"\r\n") == lf


@router.post("/api/file/write")
async def write_file(request: WriteFileRequest):
    """Write content to a file (for scratch Save As, and every editor save).

    Line endings: GET /api/file reads with universal newlines, which turns
    a CRLF file into `\\n` before the client ever sees it, and this write
    used `newline=""`, which suppresses the translation that would put them
    back. So on a Windows bridge every save silently rewrote a CRLF file to
    LF — and with `core.autocrlf=true`, git then reported the whole file as
    modified after a one-character edit.

    `newline=""` is still right (the content must go out byte-for-byte, and
    on a Linux bridge editing a checked-out CRLF file the platform default
    wouldn't help anyway); what was missing is that the endpoint has to
    supply the endings itself. It takes them from the file already on disk,
    which is the only place the information survives — the client's editor
    normalizes to `\\n` in its document model regardless of what we send it.

    A file that is *purely* CRLF gets CRLF back. Everything else — LF,
    genuinely mixed, lone-CR, and any new file — is written verbatim. Mixed
    is the interesting case and it is left alone on purpose: there is no
    ending that is "the file's", so either choice rewrites lines the user
    never touched, and silently normalizing a mixed file is a bigger
    surprise (a whole-file diff) than leaving it as the editor produced it.
    """
    try:
        p = safe_resolve(request.path)
        if not is_path_allowed(p):
            raise HTTPException(status_code=403, detail=PATH_DENIED_DETAIL)

        content = request.content
        if p.is_file() and _file_is_crlf(p):
            # Normalize first so a client that already sent CRLF doesn't
            # come out with CRCRLF.
            content = content.replace("\r\n", "\n").replace("\n", "\r\n")

        # Create parent directories if needed
        p.parent.mkdir(parents=True, exist_ok=True)

        # Write the file
        p.write_text(content, encoding="utf-8", newline="")

        return {
            "path": str(p),
            "size": p.stat().st_size,
            "mtime": p.stat().st_mtime
        }
    except HTTPException:
        raise
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════
# Directory Operations
# ═══════════════════════════════════════════════════════════════════════

@router.get("/api/check-dir")
async def check_directory(path: str):
    """Check if a directory exists."""
    try:
        p = safe_resolve(path)
        return {
            "path": str(p),
            "exists": p.exists(),
            "is_dir": p.is_dir() if p.exists() else False
        }
    except Exception as e:
        return {"path": path, "exists": False, "is_dir": False, "error": str(e)}


class MkdirRequest(BaseModel):
    path: str


@router.post("/api/mkdir")
async def create_directory(req: MkdirRequest):
    """Create a directory if it doesn't exist.

    Path rides in a JSON body (not a query param) so the request is
    CORS-preflighted — a hostile page can't create dirs with the user's
    ambient cookie via a simple cross-origin POST.
    """
    path = req.path
    try:
        p = safe_resolve(path)
        if not is_path_allowed(p):
            raise HTTPException(status_code=403, detail=PATH_DENIED_DETAIL)
        if p.exists():
            if p.is_dir():
                return {"path": str(p), "created": False, "message": "Directory already exists"}
            else:
                raise HTTPException(status_code=400, detail="Path exists but is not a directory")

        p.mkdir(parents=True, exist_ok=True)
        return {"path": str(p), "created": True, "message": "Directory created"}
    except HTTPException:
        raise
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════
# File Search
# ═══════════════════════════════════════════════════════════════════════

@router.get("/api/find-file")
async def find_file(name: str, cwd: str = None, hint: list[str] = Query(default=None)):
    """
    Find a file by name within the project directory.

    Resolution is context-aware: repeated `hint` query params carry
    directory candidates from the caller's context (terminal lines around
    the clicked filename, the shell's live cwd) and are tried before any
    heuristic search. The fallback search ranks matches shallowest-first
    (mtime breaks ties) and skips dependency/build trees like node_modules.

    Args:
        name: Filename to search for (e.g., "git-widget.js")
        cwd: Base directory to search from
        hint: Optional directory hints, most-relevant first

    Returns:
        - {found: true, path: "/full/path", is_dir: bool} if found
        - {found: false} if not found
    """
    try:
        base_cwd = cwd or str(Path.cwd())
        resolved = resolve_project_files([name], base_cwd, hint or ()).get(name)
        if resolved:
            return {"found": True, "path": resolved, "is_dir": False}
        # Not a file anywhere — maybe it's a directory (e.g. a clicked
        # `docs-ai/readme` in terminal output). Direct tiers only, no walk.
        resolved_dir = resolve_project_dir(name, base_cwd, hint or ())
        if resolved_dir:
            return {"found": True, "path": resolved_dir, "is_dir": True}
        return {"found": False}

    except Exception as e:
        return {"found": False, "error": str(e)}


@router.post("/api/verify-files")
async def verify_files(request: Request):
    """
    Batch verify multiple file paths exist.
    Used by frontend to validate file links after rendering.

    Request body:
        {
            "files": ["git-panel.c", "server.py", "static/js/app.js"],
            "cwd": "/home/user/dev/project"
        }

    Returns:
        {
            "results": {
                "git-panel.c": null,  // Not found
                "server.py": "/full/path/server.py",  // Found
                "static/js/app.js": "/full/path/static/js/app.js"  // Found
            }
        }
    """
    try:
        body = await request.json()
        files = body.get("files", [])
        cwd = body.get("cwd")

        if not files:
            return {"results": {}}

        results = verify_file_paths(set(files), cwd or str(Path.cwd()))
        return {"results": results}

    except Exception as e:
        return {"error": str(e), "results": {}}
