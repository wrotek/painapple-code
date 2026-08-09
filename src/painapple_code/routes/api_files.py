"""
Files API Routes - File operations for the file browser

These endpoints provide file listing, reading, writing, and search
functionality for the web client's file browser and autocomplete.
"""

import asyncio
import json
import logging
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
        p = Path(path).expanduser().resolve()
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


async def _enumerate_files(directory: Path, include_ignored: bool = False) -> list[str]:
    """
    Enumerate files in a directory using fd (falls back to find).
    Returns relative paths within the directory.

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
            return [f for f in stdout.decode().strip().split('\n') if f]
        raise FileNotFoundError("fd failed")

    except (FileNotFoundError, asyncio.TimeoutError):
        # Fallback to find command — `find` doesn't know about .gitignore, so
        # `include_ignored` is a no-op here (find always lists everything except
        # the hardcoded excludes).
        result = await asyncio.wait_for(
            asyncio.create_subprocess_exec(
                'find', '.', '-type', 'f',
                '-not', '-path', '*/node_modules/*',
                '-not', '-path', '*/.git/*',
                '-not', '-path', '*/__pycache__/*',
                '-not', '-path', '*/venv/*',
                '-not', '-path', '*/.venv/*',
                '-not', '-name', '*.pyc',
                '-not', '-name', '.DS_Store',
                cwd=str(directory),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            ),
            timeout=10.0
        )
        stdout, _ = await asyncio.wait_for(result.communicate(), timeout=15.0)
        return [f[2:] if f.startswith('./') else f
                for f in stdout.decode().strip().split('\n') if f and f != '.']


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
        p = Path(cwd).expanduser().resolve()
        if not p.exists() or not p.is_dir():
            raise HTTPException(status_code=404, detail="Directory not found")

        # Enumerate project files (relative paths)
        files = await _enumerate_files(p, include_ignored=include_ignored)

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
            resolved = str(Path(d).expanduser().resolve())
            if resolved not in seen:
                seen.add(resolved)
                extra_dirs.append(d)

        # Enumerate files from each extra directory (absolute paths)
        for extra_dir in extra_dirs:
            extra_path = Path(extra_dir).expanduser().resolve()
            if not extra_path.is_dir():
                logger.warning(f"Extra dir not found: {extra_dir}")
                continue
            try:
                extra_files = await _enumerate_files(extra_path, include_ignored=include_ignored)
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

        return {
            "cwd": str(p),
            "files": sorted(files)[:20000],  # 20k files ≈ 1MB JSON
            "directories": sorted(dirs),
            "total": len(files),
            "truncated": len(files) > 20000
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
        p = Path(path).expanduser().resolve()
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
        p = Path(path).expanduser().resolve()
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


@router.post("/api/file/write")
async def write_file(request: WriteFileRequest):
    """Write content to a file (for scratch Save As)."""
    try:
        p = Path(request.path).expanduser().resolve()
        if not is_path_allowed(p):
            raise HTTPException(status_code=403, detail=PATH_DENIED_DETAIL)

        # Create parent directories if needed
        p.parent.mkdir(parents=True, exist_ok=True)

        # Write the file
        p.write_text(request.content, encoding="utf-8")

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
        p = Path(path).expanduser().resolve()
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
        p = Path(path).expanduser().resolve()
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
