"""
Shadow Git Core API Routes - Branches, log, commits, session operations

These endpoints provide core access to the shadow git repository:
- Branch listing
- Commit log and details
- File content at a specific commit
- Session undo, restore, archive
"""

import logging
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from painapple_code.shadow_git import get_shadow_git
from painapple_code.utils.file_paths import resolve_work_dir

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/shadow", tags=["shadow"])


# ═══════════════════════════════════════════════════════════════════════════════
# Request/Response Models
# ═══════════════════════════════════════════════════════════════════════════════

class RestoreRequest(BaseModel):
    ref: str
    paths: list[str]


# ═══════════════════════════════════════════════════════════════════════════════
# Basic Shadow Git Operations
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/branches")
async def get_shadow_branches(cwd: str = None):
    """
    List all shadow branches with commit counts.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            return {"branches": [], "message": "Shadow git not initialized"}

        branches = await shadow.list_shadow_branches()
        current = await shadow._get_current_shadow_branch()

        return {
            "branches": branches,
            "current": current,
            "project": str(work_dir),
        }

    except Exception as e:
        logger.error(f"Shadow branches error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/log")
async def get_shadow_log(cwd: str = None, limit: int = 50, session_id: str = None, branch: str = None):
    """
    Get shadow git commit history.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            return {"commits": [], "total": 0, "message": "Shadow git not initialized"}

        if session_id:
            commits = await shadow.get_session_log(session_id, limit, branch)
        else:
            commits = await shadow.get_full_log(limit, branch)

        return {
            "commits": commits,
            "total": len(commits),
            "project": str(work_dir),
            "branch": branch,
        }

    except Exception as e:
        logger.error(f"Shadow log error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/commits/{commit_hash}")
async def get_shadow_commit(commit_hash: str, cwd: str = None):
    """
    Get full details for a shadow git commit.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        # Validate commit hash
        if not re.match(r'^[a-fA-F0-9]{7,40}$', commit_hash):
            raise HTTPException(status_code=400, detail="Invalid commit hash")

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            raise HTTPException(status_code=404, detail="Shadow git not initialized")

        # Get commit details using git show
        stdout, stderr, code = await shadow._run([
            "show",
            "--format=%H%n%h%n%an%n%at%n%s%n%b%n---END_MSG---",
            "--stat",
            "--no-color",
            commit_hash
        ], check=False)

        if code != 0:
            raise HTTPException(status_code=404, detail="Commit not found")

        # Parse output
        parts = stdout.split('---END_MSG---')
        msg_lines = parts[0].strip().split('\n')
        stats = parts[1].strip() if len(parts) > 1 else ''

        # Get the diff
        diff_out, _, _ = await shadow._run([
            "show", "--no-color", "--format=", commit_hash
        ], check=False)

        # Parse changed files from diff
        files = []
        for line in diff_out.split('\n'):
            if line.startswith('diff --git'):
                file_parts = line.split(' b/')
                if len(file_parts) > 1:
                    files.append(file_parts[-1])

        return {
            "hash": msg_lines[0] if len(msg_lines) > 0 else '',
            "hashShort": msg_lines[1] if len(msg_lines) > 1 else '',
            "author": msg_lines[2] if len(msg_lines) > 2 else '',
            "timestamp": int(msg_lines[3]) if len(msg_lines) > 3 and msg_lines[3].isdigit() else 0,
            "subject": msg_lines[4] if len(msg_lines) > 4 else '',
            "body": '\n'.join(msg_lines[5:]).strip() if len(msg_lines) > 5 else '',
            "stats": stats,
            "files": files,
            "diff": diff_out,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Shadow commit error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/commits/{commit_hash}/file")
async def get_shadow_file(commit_hash: str, path: str, cwd: str = None):
    """
    Get file content at a specific shadow git commit.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        if not re.match(r'^[a-fA-F0-9]{7,40}$', commit_hash):
            raise HTTPException(status_code=400, detail="Invalid commit hash")

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            raise HTTPException(status_code=404, detail="Shadow git not initialized")

        content = await shadow.get_file_at_ref(commit_hash, path)

        if content is None:
            raise HTTPException(status_code=404, detail="File not found at this commit")

        return {
            "path": path,
            "ref": commit_hash,
            "content": content,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Shadow file error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════════════
# Session Operations
# ═══════════════════════════════════════════════════════════════════════════════

@router.post("/sessions/{session_id}/undo")
async def shadow_undo_turn(session_id: str, cwd: str = None):
    """
    Undo the last turn for a session (git revert).
    """
    try:
        work_dir = resolve_work_dir(cwd)

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            raise HTTPException(status_code=404, detail="Shadow git not initialized")

        commit_hash = await shadow.undo_turn(session_id)

        if not commit_hash:
            raise HTTPException(status_code=400, detail="No commits to undo for this session")

        return {
            "success": True,
            "undoCommit": commit_hash,
            "message": f"Undid last turn for session {session_id[:8]}",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Shadow undo error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/restore")
async def shadow_restore_files(request: RestoreRequest, cwd: str = None):
    """
    Restore files from a shadow git commit.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        if not re.match(r'^[a-fA-F0-9]{7,40}$', request.ref):
            raise HTTPException(status_code=400, detail="Invalid commit ref")

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            raise HTTPException(status_code=404, detail="Shadow git not initialized")

        restored = []
        failed = []

        for path in request.paths:
            success = await shadow.restore_file(request.ref, path)
            if success:
                restored.append(path)
            else:
                failed.append(path)

        return {
            "success": len(failed) == 0,
            "restored": restored,
            "failed": failed,
            "ref": request.ref,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Shadow restore error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/sessions/{session_id}/archive")
async def shadow_archive_session(session_id: str, cwd: str = None):
    """
    Archive a session by creating an annotated tag.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            raise HTTPException(status_code=404, detail="Shadow git not initialized")

        success = await shadow.archive_session(session_id)

        if not success:
            raise HTTPException(status_code=400, detail="Failed to archive session")

        return {
            "success": True,
            "tag": f"sessions/{session_id}",
            "message": f"Archived session {session_id[:8]}",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Shadow archive error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/archived")
async def get_shadow_archived_sessions(cwd: str = None):
    """
    List all archived sessions (from git tags).
    """
    try:
        work_dir = resolve_work_dir(cwd)

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            return {"sessions": [], "message": "Shadow git not initialized"}

        sessions = await shadow.list_archived_sessions()

        return {
            "sessions": sessions,
            "total": len(sessions),
        }

    except Exception as e:
        logger.error(f"Shadow archived error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
