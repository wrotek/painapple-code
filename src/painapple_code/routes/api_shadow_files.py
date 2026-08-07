"""
Shadow Git Files & Timeline API Routes

Endpoints for file-level operations in shadow git:
- Timeline (commits grouped by session)
- File listing
- File history (commits touching a specific file)
- File diff between commits
"""

import asyncio
import logging
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException

from painapple_code.shadow_git import get_shadow_git
from painapple_code.shadow_parser import parse_commit_message, parse_diff_output, group_by_session
from painapple_code.utils.file_paths import resolve_work_dir

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/shadow", tags=["shadow"])


# ═══════════════════════════════════════════════════════════════════════════════
# Timeline
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/timeline")
async def get_shadow_timeline(cwd: str = None, limit: int = 100):
    """
    Get commits grouped by session for Timeline view.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            return {"sessions": [], "total": 0}

        raw_commits = await shadow.get_full_log(limit)
        parsed_commits = []

        for raw in raw_commits:
            msg_out, _, _ = await shadow._run([
                "log", "-1", "--format=%at%n%B", raw['hash']
            ], check=False)

            lines = msg_out.split('\n')
            ts = int(lines[0]) if lines and lines[0].isdigit() else 0
            msg = '\n'.join(lines[1:])

            parsed = parse_commit_message(msg, raw['hash'], raw['hash'][:8], ts)
            parsed_commits.append(parsed.to_dict())

        sessions = group_by_session(parsed_commits)

        return {
            "sessions": sessions,
            "totalCommits": len(parsed_commits),
            "totalSessions": len(sessions),
        }

    except Exception as e:
        logger.exception(f"Shadow timeline error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════════════
# File Listing
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/files")
async def get_shadow_files(cwd: str = None):
    """
    List all files tracked in shadow git.

    Fast endpoint - uses git ls-tree instead of parsing commit history.
    Returns sorted list of file paths currently in HEAD.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            return {"files": [], "total": 0}

        # Use git ls-tree to list all files in HEAD (works with bare repos)
        result = await asyncio.create_subprocess_exec(
            "git", f"--git-dir={shadow.git_dir}", "ls-tree", "-r", "--name-only", "HEAD",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await result.communicate()

        if result.returncode != 0:
            # No commits yet or other error
            if b"fatal: Not a valid object name" in stderr:
                return {"files": [], "total": 0}
            raise HTTPException(status_code=500, detail=stderr.decode())

        files = sorted(stdout.decode().strip().split('\n')) if stdout.strip() else []

        return {
            "files": files,
            "total": len(files)
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Shadow files list error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════════════
# File History
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/files/{file_path:path}/history")
async def get_shadow_file_history(file_path: str, cwd: str = None, limit: int = 50):
    """
    Get commit history for a specific file.

    The file_path can be:
    - Relative path: "static/js/app.js"
    - Absolute path: "/home/user/dev/project/static/js/app.js"

    Absolute paths are converted to relative paths based on cwd.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        # Normalize file_path: convert absolute to relative if within cwd
        normalized_path = file_path
        if file_path.startswith('/'):
            abs_file = Path(file_path)
            try:
                # Try to make it relative to work_dir
                normalized_path = str(abs_file.relative_to(work_dir))
            except ValueError:
                # Not within work_dir, use as-is (will likely not find anything)
                normalized_path = file_path

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            return {"commits": [], "total": 0}

        # Get commits touching this file
        stdout, _, code = await shadow._run([
            "log",
            f"-n{limit}",
            "--format=%H|%at|%s",
            "--follow",
            "--",
            normalized_path
        ], check=False)

        if code != 0 or not stdout.strip():
            return {"commits": [], "total": 0, "file": normalized_path}

        commits = []
        for line in stdout.strip().split('\n'):
            if not line:
                continue
            parts = line.split('|', 2)
            if len(parts) >= 3:
                hash_full = parts[0]
                ts = int(parts[1]) if parts[1].isdigit() else 0

                # Get diff stats for this commit on this file
                stat_out, _, _ = await shadow._run([
                    "show", "--format=", "--stat", hash_full, "--", normalized_path
                ], check=False)

                additions = deletions = 0
                for stat_line in stat_out.split('\n'):
                    if 'insertion' in stat_line or 'deletion' in stat_line:
                        parts_stat = stat_line.split(',')
                        for p in parts_stat:
                            if 'insertion' in p:
                                additions = int(p.split()[0])
                            elif 'deletion' in p:
                                deletions = int(p.split()[0])

                # Pull session/turn/summary from commit body so the picker
                # can show a summary and group by session.
                msg_out, _, _ = await shadow._run([
                    "log", "-1", "--format=%B", hash_full
                ], check=False)
                parsed = parse_commit_message(msg_out, hash_full, hash_full[:8], ts)

                commits.append({
                    "hash": hash_full[:8],
                    "hashFull": hash_full,
                    "timestamp": ts,
                    "subject": parts[2],
                    "summary": parsed.summary or parts[2],
                    "sessionId": parsed.session_id,
                    "turn": parsed.turn,
                    "additions": additions,
                    "deletions": deletions,
                })

        return {
            "commits": commits,
            "total": len(commits),
            "file": normalized_path,
        }

    except Exception as e:
        logger.exception(f"Shadow file history error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════════════
# File Diff
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/files/{file_path:path}/diff")
async def get_shadow_file_diff(
    file_path: str,
    from_ref: str,
    to_ref: str = "HEAD",
    cwd: str = None
):
    """
    Get diff for a file between two commits.

    The file_path can be absolute or relative (normalized to relative).
    """
    try:
        work_dir = resolve_work_dir(cwd)

        # Normalize file_path: convert absolute to relative if within cwd
        normalized_path = file_path
        if file_path.startswith('/'):
            abs_file = Path(file_path)
            try:
                normalized_path = str(abs_file.relative_to(work_dir))
            except ValueError:
                normalized_path = file_path

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            raise HTTPException(status_code=404, detail="Shadow git not initialized")

        # Validate refs (allow HEAD, hex hashes, and parent suffixes like abc123~1 or abc123^)
        for ref in [from_ref, to_ref]:
            if ref != "HEAD" and not re.match(r'^[a-fA-F0-9]{7,40}(?:~\d+|\^\d*)?$', ref):
                raise HTTPException(status_code=400, detail=f"Invalid ref: {ref}")

        # Get diff
        diff_out, _, code = await shadow._run([
            "diff", "--no-color", from_ref, to_ref, "--", normalized_path
        ], check=False)

        if code != 0:
            # Try individual file show if diff fails
            return {"diff": "", "file": normalized_path, "fromRef": from_ref, "toRef": to_ref}

        parsed_diff = parse_diff_output(diff_out)

        return {
            "file": normalized_path,
            "fromRef": from_ref,
            "toRef": to_ref,
            **parsed_diff,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Shadow file diff error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════════════
# File Content at Ref
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/files/{file_path:path}/content")
async def get_shadow_file_content(file_path: str, ref: str, cwd: str = None):
    """
    Get file content at a specific shadow git ref.

    The file_path can be absolute or relative (normalized to relative).
    """
    try:
        work_dir = resolve_work_dir(cwd)

        # Normalize file_path: convert absolute to relative if within cwd
        normalized_path = file_path
        if file_path.startswith('/'):
            abs_file = Path(file_path)
            try:
                normalized_path = str(abs_file.relative_to(work_dir))
            except ValueError:
                normalized_path = file_path

        # Validate ref (allow HEAD, hex hashes, and parent suffixes like abc123~1 or abc123^)
        if ref != "HEAD" and not re.match(r'^[a-fA-F0-9]{7,40}(?:~\d+|\^\d*)?$', ref):
            raise HTTPException(status_code=400, detail=f"Invalid ref: {ref}")

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            raise HTTPException(status_code=404, detail="Shadow git not initialized")

        content = await shadow.get_file_at_ref(ref, normalized_path)

        if content is None:
            raise HTTPException(status_code=404, detail="File not found at ref")

        return {"content": content, "file": normalized_path, "ref": ref}

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Shadow file content error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
