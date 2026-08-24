"""
Background Tasks API - Read output from Claude Code background tasks.

Provides endpoints for listing background tasks and streaming their output
via offset-based polling (like tail -f).
"""

import logging
import os
import re
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException

logger = logging.getLogger(__name__)

router = APIRouter(tags=["tasks"])

# Match alphanumeric task IDs
TASK_ID_RE = re.compile(r'^[a-z0-9]+$')


def _cwd_to_slug(cwd: str) -> str:
    """Convert CWD path to Claude's tmp directory slug.

    /home/user/dev/foo → -home-user-dev-foo
    """
    return cwd.replace('/', '-')


def _get_tasks_dir() -> Path | None:
    """Get the tasks directory for the current project.

    Returns None on native Windows: os.getuid doesn't exist there and the
    whole /tmp/claude-{uid} convention is Linux/macOS Claude CLI layout —
    the endpoints degrade to an empty list / 404 instead of a 500.
    """
    if not hasattr(os, "getuid"):
        return None
    from painapple_code.server import agents
    cwd = (agents.default_cwd if agents else None) or os.getcwd()
    uid = os.getuid()
    slug = _cwd_to_slug(cwd)
    # Claude Code uses dash-prefix slugs; also check tilde-prefix variant
    tasks_dir = Path(f"/tmp/claude-{uid}/{slug}/tasks")
    if not tasks_dir.exists():
        tilde_slug = '~' + slug[1:]  # -home-... → ~home-...
        alt = Path(f"/tmp/claude-{uid}/{tilde_slug}/tasks")
        if alt.exists():
            return alt
    return tasks_dir


def _is_running(mtime: float, threshold: float = 5.0) -> bool:
    """Heuristic: task is running if file was modified recently."""
    return (time.time() - mtime) < threshold


def _read_last_lines(path: Path, n: int = 3) -> str:
    """Read last N lines from a file efficiently."""
    try:
        with open(path, 'rb') as f:
            # Seek near end
            f.seek(0, 2)
            size = f.tell()
            pos = max(0, size - 4096)
            f.seek(pos)
            chunk = f.read().decode('utf-8', errors='replace')
            lines = chunk.strip().split('\n')
            return '\n'.join(lines[-n:])
    except Exception:
        return ''


@router.get("/api/tasks")
async def list_tasks():
    """List all background tasks for the current project."""
    tasks_dir = _get_tasks_dir()

    if tasks_dir is None or not tasks_dir.exists():
        return {"tasks": []}

    tasks = []
    for f in sorted(tasks_dir.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not f.name.endswith('.output'):
            continue
        try:
            task_id = f.stem
            stat = f.stat()
            running = _is_running(stat.st_mtime)
            preview = _read_last_lines(f.resolve(), 2) if stat.st_size > 0 else ''

            tasks.append({
                "id": task_id,
                "size": stat.st_size,
                "modified": stat.st_mtime,
                "is_running": running,
                "preview": preview[:200],
            })
        except Exception as e:
            logger.warning(f"Error reading task {f.name}: {e}")

    return {"tasks": tasks}


@router.get("/api/tasks/{task_id}")
async def get_task_output(task_id: str, offset: int = 0):
    """Read task output with offset-based incremental polling."""
    if not TASK_ID_RE.match(task_id):
        raise HTTPException(400, "Invalid task ID format")

    tasks_dir = _get_tasks_dir()
    if tasks_dir is None:
        raise HTTPException(404, "Background tasks not available on this platform")
    file_path = tasks_dir / f"{task_id}.output"

    if not file_path.exists():
        raise HTTPException(404, "Task not found")

    # Resolve symlinks but verify we stay in /tmp/claude-*
    real_path = file_path.resolve()
    uid = os.getuid()
    if not str(real_path).startswith(f"/tmp/claude-{uid}/"):
        raise HTTPException(403, "Path traversal denied")

    stat = real_path.stat()
    running = _is_running(stat.st_mtime)

    content = ""
    new_offset = offset
    try:
        with open(real_path, 'r', errors='replace', encoding="utf-8") as f:
            if offset > 0:
                f.seek(min(offset, stat.st_size))
            content = f.read()
            new_offset = f.tell()
    except Exception as e:
        raise HTTPException(500, f"Error reading task output: {e}")

    return {
        "id": task_id,
        "content": content,
        "offset": new_offset,
        "size": stat.st_size,
        "is_running": running,
    }
