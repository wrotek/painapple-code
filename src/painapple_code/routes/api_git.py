"""
Git API Routes - Read-only git repository operations

These endpoints provide read-only access to git repositories for
status, diff, log, and commit viewing functionality.
"""

import asyncio
import logging
import re
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException

from painapple_code.utils.file_paths import resolve_work_dir

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/git", tags=["git"])


async def _run_git(cmd: list[str], cwd: str, timeout: float = 30) -> tuple[str, int]:
    """Run a git command asynchronously. Returns (stdout, returncode)."""
    proc = await asyncio.create_subprocess_exec(
        *cmd, cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        raise
    return stdout.decode(), proc.returncode


# ═══════════════════════════════════════════════════════════════════════
# Git Status
# ═══════════════════════════════════════════════════════════════════════

@router.get("/status")
async def get_git_status(cwd: str = None):
    """
    Get git status with structured output.
    Returns staged, modified, and untracked files with stats.
    """
    try:
        work_dir = resolve_work_dir(cwd)
        if not work_dir.exists():
            raise HTTPException(status_code=404, detail="Directory not found")

        # Check if inside a git repo (works for subdirectories of git repos)
        stdout, returncode = await _run_git(
            ["git", "rev-parse", "--is-inside-work-tree"],
            str(work_dir), timeout=5
        )
        if returncode != 0:
            return {"error": "not_a_repo", "message": "Not a git repository"}

        # Get repo root so clients can resolve relative porcelain paths to absolute
        stdout, returncode = await _run_git(
            ["git", "rev-parse", "--show-toplevel"],
            str(work_dir), timeout=5
        )
        root = stdout.strip() if returncode == 0 else str(work_dir)

        # Get current branch
        stdout, returncode = await _run_git(
            ["git", "branch", "--show-current"],
            str(work_dir), timeout=10
        )
        branch = stdout.strip() or "HEAD detached"

        # Get status with porcelain format for easy parsing
        stdout, returncode = await _run_git(
            ["git", "status", "--porcelain=v1", "-uall"],
            str(work_dir), timeout=30
        )

        staged = []
        modified = []
        untracked = []

        for line in stdout.split('\n'):
            line = line.rstrip()  # Only strip trailing whitespace, preserve leading space
            if not line:
                continue

            index_status = line[0]  # Status in index (staged)
            worktree_status = line[1]  # Status in worktree
            file_path = line[3:]

            # Handle renamed files: "R  old -> new"
            if ' -> ' in file_path:
                file_path = file_path.split(' -> ')[1]

            file_info = {
                "path": file_path,
                "name": file_path.split('/')[-1],
            }

            # Untracked files
            if index_status == '?' and worktree_status == '?':
                untracked.append(file_info)
            # Staged changes
            elif index_status in 'MADRC':
                file_info["status"] = {
                    'M': 'modified',
                    'A': 'added',
                    'D': 'deleted',
                    'R': 'renamed',
                    'C': 'copied'
                }.get(index_status, 'modified')
                staged.append(file_info)
                # Also modified in worktree?
                if worktree_status == 'M':
                    modified.append({**file_info, "status": "modified"})
            # Modified but not staged
            elif worktree_status == 'M':
                file_info["status"] = "modified"
                modified.append(file_info)
            elif worktree_status == 'D':
                file_info["status"] = "deleted"
                modified.append(file_info)

        # Get ahead/behind info
        stdout, returncode = await _run_git(
            ["git", "rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
            str(work_dir), timeout=10
        )
        ahead = behind = 0
        if returncode == 0 and stdout.strip():
            parts = stdout.strip().split()
            if len(parts) == 2:
                behind, ahead = int(parts[0]), int(parts[1])

        # Get diff stats for staged files
        staged_stats = {}
        if staged:
            stdout, returncode = await _run_git(
                ["git", "diff", "--numstat", "--staged"],
                str(work_dir), timeout=30
            )
            for line in stdout.strip().split('\n'):
                if not line:
                    continue
                parts = line.split('\t')
                if len(parts) >= 3:
                    add, rm, path = parts[0], parts[1], parts[2]
                    # Handle binary files (shows '-' instead of numbers)
                    staged_stats[path] = {
                        'additions': int(add) if add != '-' else 0,
                        'deletions': int(rm) if rm != '-' else 0
                    }

        # Get diff stats for modified (unstaged) files
        modified_stats = {}
        if modified:
            stdout, returncode = await _run_git(
                ["git", "diff", "--numstat"],
                str(work_dir), timeout=30
            )
            for line in stdout.strip().split('\n'):
                if not line:
                    continue
                parts = line.split('\t')
                if len(parts) >= 3:
                    add, rm, path = parts[0], parts[1], parts[2]
                    modified_stats[path] = {
                        'additions': int(add) if add != '-' else 0,
                        'deletions': int(rm) if rm != '-' else 0
                    }

        # Merge stats into file info
        for f in staged:
            stats = staged_stats.get(f['path'], {})
            f['additions'] = stats.get('additions', 0)
            f['deletions'] = stats.get('deletions', 0)

        for f in modified:
            stats = modified_stats.get(f['path'], {})
            f['additions'] = stats.get('additions', 0)
            f['deletions'] = stats.get('deletions', 0)

        return {
            "branch": branch,
            "root": root,
            "staged": staged,
            "modified": modified,
            "untracked": untracked,
            "ahead": ahead,
            "behind": behind,
            "summary": {
                "stagedCount": len(staged),
                "modifiedCount": len(modified),
                "untrackedCount": len(untracked),
            }
        }

    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Git command timed out")
    except Exception as e:
        logger.error(f"Git status error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════
# Git Diff
# ═══════════════════════════════════════════════════════════════════════

@router.get("/diff")
async def get_git_diff(cwd: str = None, file: str = None, staged: bool = False):
    """
    Get git diff for a file or all changes.
    - file: specific file path (optional)
    - staged: if true, show staged changes (--cached)
    """
    try:
        work_dir = resolve_work_dir(cwd)

        cmd = ["git", "diff", "--no-color"]
        if staged:
            cmd.append("--cached")
        if file:
            cmd.append("--")
            cmd.append(file)

        stdout, returncode = await _run_git(cmd, str(work_dir), timeout=30)

        # Parse diff into structured format
        diff_text = stdout
        files = []
        current_file = None

        for line in diff_text.split('\n'):
            if line.startswith('diff --git'):
                if current_file:
                    files.append(current_file)
                # Extract file path from "diff --git a/path b/path"
                parts = line.split(' b/')
                file_path = parts[-1] if len(parts) > 1 else ''
                current_file = {
                    "path": file_path,
                    "hunks": [],
                    "additions": 0,
                    "deletions": 0,
                }
            elif line.startswith('@@') and current_file:
                current_file["hunks"].append({
                    "header": line,
                    "lines": []
                })
            elif current_file and current_file["hunks"]:
                hunk = current_file["hunks"][-1]
                hunk["lines"].append(line)
                if line.startswith('+') and not line.startswith('+++'):
                    current_file["additions"] += 1
                elif line.startswith('-') and not line.startswith('---'):
                    current_file["deletions"] += 1

        if current_file:
            files.append(current_file)

        return {
            "files": files,
            "raw": diff_text,
            "summary": {
                "filesChanged": len(files),
                "additions": sum(f["additions"] for f in files),
                "deletions": sum(f["deletions"] for f in files),
            }
        }

    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Git command timed out")
    except Exception as e:
        logger.error(f"Git diff error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════
# Git File Content (for side-by-side diff viewer)
# ═══════════════════════════════════════════════════════════════════════

@router.get("/file-content")
async def get_git_file_content(file: str, cwd: str = None, staged: bool = False, commit: str = None):
    """
    Get old/new versions of a file for side-by-side diff.
    If commit is provided, compares commit~1 vs commit.
    Otherwise compares HEAD vs working/staged.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        if commit:
            # Validate commit hash
            if not re.match(r'^[0-9a-fA-F]{4,40}$', commit):
                raise HTTPException(status_code=400, detail="Invalid commit hash")
            # Compare parent vs commit
            old_stdout, old_rc = await _run_git(
                ["git", "show", f"{commit}~1:{file}"], str(work_dir), timeout=10
            )
            old_content = old_stdout if old_rc == 0 else ''
            new_stdout, new_rc = await _run_git(
                ["git", "show", f"{commit}:{file}"], str(work_dir), timeout=10
            )
            new_content = new_stdout if new_rc == 0 else ''
            old_label = f"{commit[:8]}~1"
            new_label = commit[:8]
        else:
            # Get HEAD version
            old_stdout, old_rc = await _run_git(
                ["git", "show", f"HEAD:{file}"], str(work_dir), timeout=10
            )
            old_content = old_stdout if old_rc == 0 else ''

            if staged:
                # Get staged (index) version
                new_stdout, new_rc = await _run_git(
                    ["git", "show", f":{file}"], str(work_dir), timeout=10
                )
                new_content = new_stdout if new_rc == 0 else ''
            else:
                # Read working tree version — confine to work_dir (no ../ escape)
                import pathlib
                work_root = pathlib.Path(str(work_dir)).resolve()
                file_path = (work_root / file).resolve()
                if not file_path.is_relative_to(work_root):
                    raise HTTPException(status_code=400, detail="File path escapes working directory")
                try:
                    new_content = file_path.read_text(encoding="utf-8", errors='replace')
                except FileNotFoundError:
                    new_content = ''
            old_label = "HEAD"
            new_label = "Staged" if staged else "Working Tree"

        return {
            "file": file,
            "old": old_content,
            "new": new_content,
            "oldLabel": old_label,
            "newLabel": new_label
        }

    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Git command timed out")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Git file-content error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════
# Git Log
# ═══════════════════════════════════════════════════════════════════════

@router.get("/log")
async def get_git_log(cwd: str = None, limit: int = 20, skip: int = 0):
    """
    Get recent commit history.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        # Get commits with detailed format
        stdout, returncode = await _run_git(
            [
                "git", "log",
                f"--skip={skip}",
                f"-{limit}",
                "--format=%H%n%h%n%an%n%ae%n%at%n%s%n%b%n---COMMIT_END---"
            ],
            str(work_dir), timeout=30
        )

        commits = []
        entries = stdout.split('---COMMIT_END---')

        for entry in entries:
            lines = entry.strip().split('\n')
            if len(lines) >= 6:
                hash_full = lines[0]
                hash_short = lines[1]
                author_name = lines[2]
                author_email = lines[3]
                timestamp = int(lines[4]) if lines[4].isdigit() else 0
                subject = lines[5]
                body = '\n'.join(lines[6:]).strip() if len(lines) > 6 else ''

                commits.append({
                    "hash": hash_full,
                    "hashShort": hash_short,
                    "author": author_name,
                    "email": author_email,
                    "timestamp": timestamp,
                    "date": datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat() if timestamp else None,
                    "subject": subject,
                    "body": body,
                })

        # Get total commit count
        count_stdout, count_returncode = await _run_git(
            ["git", "rev-list", "--count", "HEAD"],
            str(work_dir), timeout=10
        )
        total = int(count_stdout.strip()) if count_returncode == 0 else len(commits)

        return {
            "commits": commits,
            "total": total,
            "limit": limit,
            "skip": skip,
            "hasMore": skip + len(commits) < total,
        }

    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Git command timed out")
    except Exception as e:
        logger.error(f"Git log error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════
# Git Show (Commit Details)
# ═══════════════════════════════════════════════════════════════════════

@router.get("/show/{commit_hash}")
async def get_git_show(commit_hash: str, cwd: str = None):
    """
    Get details and diff for a specific commit.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        # Validate commit hash (prevent injection)
        if not re.match(r'^[a-fA-F0-9]{7,40}$', commit_hash):
            raise HTTPException(status_code=400, detail="Invalid commit hash")

        # Get commit details
        stdout, returncode = await _run_git(
            [
                "git", "show",
                "--format=%H%n%h%n%an%n%ae%n%at%n%s%n%b%n---DETAILS_END---",
                "--stat",
                "--no-color",
                commit_hash
            ],
            str(work_dir), timeout=30
        )

        if returncode != 0:
            raise HTTPException(status_code=404, detail="Commit not found")

        # Parse output
        parts = stdout.split('---DETAILS_END---')
        details_lines = parts[0].strip().split('\n')
        stats = parts[1].strip() if len(parts) > 1 else ''

        commit = {
            "hash": details_lines[0] if len(details_lines) > 0 else '',
            "hashShort": details_lines[1] if len(details_lines) > 1 else '',
            "author": details_lines[2] if len(details_lines) > 2 else '',
            "email": details_lines[3] if len(details_lines) > 3 else '',
            "timestamp": int(details_lines[4]) if len(details_lines) > 4 and details_lines[4].isdigit() else 0,
            "subject": details_lines[5] if len(details_lines) > 5 else '',
            "body": '\n'.join(details_lines[6:]).strip() if len(details_lines) > 6 else '',
            "stats": stats,
        }

        # Get the diff
        diff_stdout, diff_returncode = await _run_git(
            ["git", "show", "--no-color", "--format=", commit_hash],
            str(work_dir), timeout=30
        )

        # Parse diff
        files = []
        current_file = None
        for line in diff_stdout.split('\n'):
            if line.startswith('diff --git'):
                if current_file:
                    files.append(current_file)
                parts = line.split(' b/')
                file_path = parts[-1] if len(parts) > 1 else ''
                current_file = {
                    "path": file_path,
                    "hunks": [],
                    "additions": 0,
                    "deletions": 0,
                }
            elif line.startswith('@@') and current_file:
                current_file["hunks"].append({
                    "header": line,
                    "lines": []
                })
            elif current_file and current_file["hunks"]:
                hunk = current_file["hunks"][-1]
                hunk["lines"].append(line)
                if line.startswith('+') and not line.startswith('+++'):
                    current_file["additions"] += 1
                elif line.startswith('-') and not line.startswith('---'):
                    current_file["deletions"] += 1

        if current_file:
            files.append(current_file)

        return {
            "commit": commit,
            "files": files,
            "diffRaw": diff_stdout,
        }

    except HTTPException:
        raise
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Git command timed out")
    except Exception as e:
        logger.error(f"Git show error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════
# Git File at Ref (for compare wizard)
# ═══════════════════════════════════════════════════════════════════════

@router.get("/file-at-ref")
async def get_git_file_at_ref(file: str, ref: str, cwd: str = None):
    """
    Get file content at a specific git ref (commit hash or branch name).
    """
    try:
        work_dir = resolve_work_dir(cwd)

        # Validate ref: allow hex hashes, branch names, HEAD~N, tags.
        # Forbid a leading '-'/'.' so the ref can't smuggle a git option.
        if not re.match(r'^(?![-.])[a-zA-Z0-9_./-]+(?:~\d+)?(?:\^\d+)?$', ref):
            raise HTTPException(status_code=400, detail="Invalid ref")

        stdout, rc = await _run_git(
            ["git", "show", f"{ref}:{file}"], str(work_dir), timeout=10
        )

        if rc != 0:
            raise HTTPException(status_code=404, detail="File not found at ref")

        return {"content": stdout, "file": file, "ref": ref}

    except HTTPException:
        raise
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Git command timed out")
    except Exception as e:
        logger.error(f"Git file-at-ref error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════
# Git File Log (commits touching a specific file)
# ═══════════════════════════════════════════════════════════════════════

@router.get("/file-log")
async def get_git_file_log(file: str, cwd: str = None, limit: int = 30):
    """
    Get commit history for a specific file.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        stdout, returncode = await _run_git(
            [
                "git", "log",
                f"-{limit}",
                "--format=%H|%h|%an|%at|%s",
                "--follow",
                "--", file
            ],
            str(work_dir), timeout=30
        )

        if returncode != 0 or not stdout.strip():
            return {"commits": [], "total": 0, "file": file}

        commits = []
        for line in stdout.strip().split('\n'):
            if not line:
                continue
            parts = line.split('|', 4)
            if len(parts) >= 5:
                commits.append({
                    "hash": parts[0],
                    "hashShort": parts[1],
                    "author": parts[2],
                    "timestamp": int(parts[3]) if parts[3].isdigit() else 0,
                    "subject": parts[4],
                })

        return {"commits": commits, "total": len(commits), "file": file}

    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Git command timed out")
    except Exception as e:
        logger.error(f"Git file-log error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════
# Git Branches
# ═══════════════════════════════════════════════════════════════════════

@router.get("/branches")
async def get_git_branches(cwd: str = None):
    """
    List all local branches with latest commit info.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        # Get current branch
        cur_stdout, _ = await _run_git(
            ["git", "branch", "--show-current"], str(work_dir), timeout=5
        )
        current_branch = cur_stdout.strip()

        # Get all branches with commit info
        stdout, returncode = await _run_git(
            [
                "git", "branch",
                "--format=%(refname:short)|%(objectname:short)|%(committerdate:unix)|%(subject)"
            ],
            str(work_dir), timeout=10
        )

        if returncode != 0:
            return {"branches": [], "current": current_branch}

        branches = []
        for line in stdout.strip().split('\n'):
            if not line:
                continue
            parts = line.split('|', 3)
            if len(parts) >= 4:
                branches.append({
                    "name": parts[0],
                    "hashShort": parts[1],
                    "timestamp": int(parts[2]) if parts[2].isdigit() else 0,
                    "subject": parts[3],
                    "isCurrent": parts[0] == current_branch,
                })

        return {"branches": branches, "current": current_branch}

    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Git command timed out")
    except Exception as e:
        logger.error(f"Git branches error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
