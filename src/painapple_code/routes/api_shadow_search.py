"""
Shadow Git Search & Analysis API Routes

Endpoints for searching, parsing, and extracting insights from shadow git commits:
- Commit search with filtering
- Parsed commit details and diffs
- Extracted decisions, problems, learnings
- Tag listing and tag-filtered commits
"""

import logging
import re
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException

from painapple_code.shadow_git import get_shadow_git
from painapple_code.shadow_parser import (
    parse_commit_message,
    parse_diff_output,
    search_commits,
    extract_decisions,
    extract_problems,
    extract_learnings,
)
from painapple_code.utils.file_paths import resolve_work_dir

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/shadow", tags=["shadow"])


# ═══════════════════════════════════════════════════════════════════════════════
# Search
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/search")
async def shadow_search(
    cwd: str = None,
    q: str = "",
    tags: str = "",
    files: str = "",
    session_id: str = None,
    since: str = None,
    until: str = None,
    limit: int = 100,
):
    """
    Search shadow git commits with filtering.

    Args:
        cwd: Project directory
        q: Text search query
        tags: Comma-separated tags (e.g., "#feature,#bugfix")
        files: Comma-separated file patterns
        session_id: Filter by session
        since: ISO date filter (inclusive)
        until: ISO date filter (inclusive)
        limit: Max results
    """
    try:
        work_dir = resolve_work_dir(cwd)

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            return {"commits": [], "total": 0, "message": "Shadow git not initialized"}

        # Get raw commits
        raw_commits = await shadow.get_full_log(limit * 2)  # Get extra for filtering

        # Parse each commit
        parsed_commits = []
        for raw in raw_commits:
            # Get full commit message
            msg_out, _, _ = await shadow._run([
                "log", "-1", "--format=%B", raw['hash']
            ], check=False)

            # Parse timestamp
            ts_str = raw.get('timestamp', '')
            ts_int = 0
            if ts_str:
                try:
                    # Format: "2025-12-30 09:06:05 +0100"
                    from datetime import datetime
                    dt = datetime.strptime(ts_str[:19], "%Y-%m-%d %H:%M:%S")
                    ts_int = int(dt.timestamp())
                except (ValueError, TypeError):
                    pass

            parsed = parse_commit_message(
                msg_out,
                hash_full=raw['hash'],
                hash_short=raw['hash'][:8],
                timestamp=ts_int,
            )
            parsed_commits.append(parsed.to_dict())

        # Apply filters
        tag_list = [t.strip() for t in tags.split(',') if t.strip()] if tags else None
        file_list = [f.strip() for f in files.split(',') if f.strip()] if files else None

        filtered = search_commits(
            parsed_commits,
            query=q,
            tags=tag_list,
            files=file_list,
            session_id=session_id,
        )

        # Date filtering
        if since or until:
            from datetime import datetime
            since_dt = datetime.fromisoformat(since) if since else None
            until_dt = datetime.fromisoformat(until) if until else None

            def in_range(commit):
                ts = commit.get('timestamp')
                if not ts:
                    return True
                try:
                    commit_dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
                    if since_dt and commit_dt < since_dt:
                        return False
                    if until_dt and commit_dt > until_dt:
                        return False
                    return True
                except (ValueError, TypeError):
                    return True

            filtered = [c for c in filtered if in_range(c)]

        # Limit results
        filtered = filtered[:limit]

        # Build facets for filtering UI
        all_tags = set()
        all_files = set()
        for c in parsed_commits:
            all_tags.update(c.get('tags', []))
            all_files.update(c.get('files', []))

        return {
            "commits": filtered,
            "total": len(filtered),
            "facets": {
                "tags": sorted(all_tags),
                "files": sorted(all_files)[:50],  # Limit file list
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Shadow search error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════════════
# Parsed Commit Details
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/commits/{commit_hash}/parsed")
async def get_shadow_commit_parsed(commit_hash: str, cwd: str = None):
    """
    Get fully parsed commit with YAML frontmatter and sections.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        if not re.match(r'^[a-fA-F0-9]{7,40}$', commit_hash):
            raise HTTPException(status_code=400, detail="Invalid commit hash")

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            raise HTTPException(status_code=404, detail="Shadow git not initialized")

        # Get full commit message
        msg_out, stderr, code = await shadow._run([
            "log", "-1", "--format=%H%n%at%n%B", commit_hash
        ], check=False)

        if code != 0:
            raise HTTPException(status_code=404, detail="Commit not found")

        lines = msg_out.split('\n')
        hash_full = lines[0] if lines else commit_hash
        timestamp = int(lines[1]) if len(lines) > 1 and lines[1].isdigit() else 0
        full_message = '\n'.join(lines[2:]) if len(lines) > 2 else ''

        parsed = parse_commit_message(
            full_message,
            hash_full=hash_full,
            hash_short=hash_full[:8],
            timestamp=timestamp,
        )

        return parsed.to_dict()

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Shadow commit parsed error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/commits/{commit_hash}/diff")
async def get_shadow_commit_diff(commit_hash: str, cwd: str = None):
    """
    Get structured diff for a commit.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        if not re.match(r'^[a-fA-F0-9]{7,40}$', commit_hash):
            raise HTTPException(status_code=400, detail="Invalid commit hash")

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            raise HTTPException(status_code=404, detail="Shadow git not initialized")

        # Get diff
        diff_out, stderr, code = await shadow._run([
            "show", "--no-color", "--format=", commit_hash
        ], check=False)

        if code != 0:
            raise HTTPException(status_code=404, detail="Commit not found")

        parsed_diff = parse_diff_output(diff_out)

        return {
            "commitHash": commit_hash,
            **parsed_diff,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Shadow diff error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════════════
# Extracted Information (Decisions, Problems, Learnings)
# ═══════════════════════════════════════════════════════════════════════════════

async def _get_parsed_commits(shadow, limit: int):
    """Helper to get and parse commits."""
    raw_commits = await shadow.get_full_log(limit * 2)
    parsed_commits = []

    for raw in raw_commits[:limit]:
        msg_out, _, _ = await shadow._run([
            "log", "-1", "--format=%at%n%B", raw['hash']
        ], check=False)

        lines = msg_out.split('\n')
        ts = int(lines[0]) if lines and lines[0].isdigit() else 0
        msg = '\n'.join(lines[1:])

        parsed = parse_commit_message(msg, raw['hash'], raw['hash'][:8], ts)
        parsed_commits.append(parsed.to_dict())

    return parsed_commits


@router.get("/decisions")
async def get_shadow_decisions(cwd: str = None, limit: int = 100):
    """
    Extract all Decisions sections from commits.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            return {"decisions": [], "total": 0}

        parsed_commits = await _get_parsed_commits(shadow, limit)
        decisions = extract_decisions(parsed_commits)

        return {
            "decisions": decisions,
            "total": len(decisions),
        }

    except Exception as e:
        logger.exception(f"Shadow decisions error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/problems")
async def get_shadow_problems(cwd: str = None, limit: int = 100):
    """
    Extract all Problems Solved sections from commits.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            return {"problems": [], "total": 0}

        parsed_commits = await _get_parsed_commits(shadow, limit)
        problems = extract_problems(parsed_commits)

        return {
            "problems": problems,
            "total": len(problems),
        }

    except Exception as e:
        logger.exception(f"Shadow problems error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/learnings")
async def get_shadow_learnings(cwd: str = None, limit: int = 100):
    """
    Extract all Learnings sections from commits.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            return {"learnings": [], "total": 0}

        parsed_commits = await _get_parsed_commits(shadow, limit)
        learnings = extract_learnings(parsed_commits)

        return {
            "learnings": learnings,
            "total": len(learnings),
        }

    except Exception as e:
        logger.exception(f"Shadow learnings error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════════════
# Tags
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/tags")
async def get_shadow_tags(cwd: str = None, limit: int = 100, recent: int = 20):
    """
    Get all unique tags from commits with counts and metadata.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            return {"tags": [], "total": 0, "recentTags": []}

        raw_commits = await shadow.get_full_log(limit)

        # Collect tag data
        tag_data = {}  # tag -> {count, firstSeen, lastSeen, recentCount, commits}

        for idx, raw in enumerate(raw_commits):
            msg_out, _, _ = await shadow._run([
                "log", "-1", "--format=%at%n%B", raw['hash']
            ], check=False)

            lines = msg_out.split('\n')
            ts = int(lines[0]) if lines and lines[0].isdigit() else 0
            msg = '\n'.join(lines[1:])

            parsed = parse_commit_message(msg, raw['hash'], raw['hash'][:8], ts)

            is_recent = idx < recent

            for tag in parsed.tags:
                if tag not in tag_data:
                    tag_data[tag] = {
                        'name': tag,
                        'count': 0,
                        'firstSeen': ts,
                        'lastSeen': ts,
                        'recentCount': 0,
                        'commits': []
                    }

                td = tag_data[tag]
                td['count'] += 1
                td['commits'].append(raw['hash'][:8])

                # Update timestamps (firstSeen = oldest, lastSeen = newest)
                if ts < td['firstSeen']:
                    td['firstSeen'] = ts
                if ts > td['lastSeen']:
                    td['lastSeen'] = ts

                if is_recent:
                    td['recentCount'] += 1

        # Convert to list and sort by count (most used first)
        tags_list = sorted(tag_data.values(), key=lambda t: (-t['count'], t['name']))

        # Limit commits array to 10 most recent per tag
        for t in tags_list:
            t['commits'] = t['commits'][:10]

        # Get recent tags (tags appearing in recent commits, sorted by recent count)
        recent_tags = sorted(
            [t for t in tags_list if t['recentCount'] > 0],
            key=lambda t: (-t['recentCount'], -t['count'])
        )[:10]

        return {
            "tags": tags_list,
            "total": len(tags_list),
            "recentTags": [t['name'] for t in recent_tags]
        }

    except Exception as e:
        logger.exception(f"Shadow tags error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/tags/{tag_name}/commits")
async def get_shadow_tag_commits(tag_name: str, cwd: str = None, limit: int = 50):
    """
    Get all commits with a specific tag.
    """
    try:
        work_dir = resolve_work_dir(cwd)

        shadow = get_shadow_git(str(work_dir))

        if not shadow.git_dir.exists():
            return {"commits": [], "total": 0, "tag": tag_name}

        # URL decode the tag name (e.g., %23feature -> #feature)
        decoded_tag = unquote(tag_name)

        raw_commits = await shadow.get_full_log(limit * 3)  # Fetch more to filter
        matching_commits = []

        for raw in raw_commits:
            if len(matching_commits) >= limit:
                break

            msg_out, _, _ = await shadow._run([
                "log", "-1", "--format=%at%n%B", raw['hash']
            ], check=False)

            lines = msg_out.split('\n')
            ts = int(lines[0]) if lines and lines[0].isdigit() else 0
            msg = '\n'.join(lines[1:])

            parsed = parse_commit_message(msg, raw['hash'], raw['hash'][:8], ts)

            if decoded_tag in parsed.tags:
                matching_commits.append(parsed.to_dict())

        return {
            "commits": matching_commits,
            "total": len(matching_commits),
            "tag": decoded_tag
        }

    except Exception as e:
        logger.exception(f"Shadow tag commits error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
