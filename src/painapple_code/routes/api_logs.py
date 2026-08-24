"""
Session Logs API Routes - Log explorer and file changes tracking

These endpoints provide:
- Session log overview (file sizes, message counts)
- Parsed message retrieval with pagination and filtering
- Raw I/O log access for debugging
- Tool output file management
- File changes tracking (Edit/Write tool usage analysis)
"""

import asyncio
import difflib
import json
import logging
import re
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from painapple_code import paths
from painapple_code.session_store import SessionStore
from painapple_code.routes.dependencies import get_session_store

logger = logging.getLogger(__name__)

router = APIRouter(tags=["logs"])

# Raster image types safe to serve inline (needed for <img> preview / image
# re-attach). These cannot execute script. Everything else — notably .svg
# (image-shaped but scriptable) and .html/.js — is served as an inert
# attachment so an uploaded file can never run in the authenticated origin.
_INLINE_IMAGE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


# ═══════════════════════════════════════════════════════════════════
# Session Log Overview
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/sessions/{session_id}/logs")
async def get_session_logs_overview(session_id: str):
    """Get overview of session logs - files and their sizes."""
    store, meta = SessionStore._find_session(session_id)
    if not store:
        raise HTTPException(status_code=404, detail="Session not found")

    session_dir = store._session_dir(session_id)

    messages_path = store._messages_path(session_id)
    raw_path = store._raw_log_path(session_id)
    tools_dir = store._tools_dir(session_id)

    def count_lines(path):
        if not path.exists():
            return 0
        with open(path, encoding="utf-8") as f:
            return sum(1 for line in f if line.strip())

    def count_user_lines(path):
        """Count lines where role is 'user' in messages.jsonl."""
        if not path.exists():
            return 0
        count = 0
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and ('"role": "user"' in line or '"role":"user"' in line):
                    count += 1
        return count

    tool_files = []
    if tools_dir.exists():
        for f in sorted(tools_dir.iterdir()):
            if f.is_file():
                tool_files.append({
                    "name": f.name,
                    "size": f.stat().st_size,
                    "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat() + "Z"
                })

    return {
        "session_id": session_id,
        "meta": meta,
        "files": {
            "messages": {
                "path": str(messages_path),
                "exists": messages_path.exists(),
                "size": messages_path.stat().st_size if messages_path.exists() else 0,
                "lines": count_lines(messages_path),
                "user_lines": count_user_lines(messages_path)
            },
            "raw": {
                "path": str(raw_path),
                "exists": raw_path.exists(),
                "size": raw_path.stat().st_size if raw_path.exists() else 0,
                "lines": count_lines(raw_path)
            },
            "tools": {
                "path": str(tools_dir),
                "exists": tools_dir.exists(),
                "count": len(tool_files),
                "files": tool_files
            }
        }
    }


# ═══════════════════════════════════════════════════════════════════
# Session Messages
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/sessions/{session_id}/logs/messages")
async def get_session_messages(
    session_id: str,
    offset: int = 0,
    limit: int = 50,
    role: str = None,
    sort: str = "asc",
    since: str = None,
    store: SessionStore = Depends(get_session_store),
):
    """Get parsed messages with pagination, filtering, and timestamp filtering."""
    messages_path = store._messages_path(session_id)
    if not messages_path.exists():
        return {"messages": [], "total": 0, "offset": offset, "limit": limit, "since": since}

    # Load favorites set for quick lookup
    favorites_data = paths.load_prompt_favorites()
    favorite_ids = set(favorites_data.get("prompts", {}).keys())

    all_messages = []
    line_number = 0
    with open(messages_path, 'r', encoding="utf-8") as f:
        for line in f:
            line_number += 1
            line = line.strip()
            if line:
                try:
                    msg = json.loads(line)
                    if since and msg.get("timestamp", "") < since:
                        continue
                    if role is None or msg.get("role") == role:
                        # Stable server identity for client-side dedup: an explicit
                        # stored id wins (e.g. compact-<uuid> on boundary rows);
                        # otherwise derive from the append-only line number — the
                        # same "{session}:{line}" scheme promptId already uses, so
                        # every historical message gets identity retroactively.
                        # Client matching/dedup keys on this (`sid`), never on
                        # content+time heuristics when both sides carry one.
                        msg["sid"] = msg.get("id") or f"{session_id}:{line_number}"
                        if msg.get("role") == "user":
                            prompt_id = f"{session_id}:{line_number}"
                            msg["promptId"] = prompt_id
                            msg["isFavorite"] = prompt_id in favorite_ids
                        all_messages.append(msg)
                except json.JSONDecodeError:
                    continue

    # Hydrate tool outputs
    for msg in all_messages:
        store._hydrate_tool_output(session_id, msg)

    total = len(all_messages)

    if sort == "desc":
        all_messages = all_messages[::-1]

    paginated = all_messages[offset:offset + limit]

    return {
        "messages": paginated,
        "total": total,
        "offset": offset,
        "limit": limit,
        "has_more": offset + limit < total,
        "since": since
    }


# ═══════════════════════════════════════════════════════════════════
# Raw Log
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/sessions/{session_id}/logs/raw")
async def get_session_raw_log(
    session_id: str,
    offset: int = 0,
    limit: int = 100,
    direction: str = None,
    errors_only: bool = False,
    sort: str = "asc",
    store: SessionStore = Depends(get_session_store),
):
    """Get raw Claude I/O log with filtering."""
    raw_path = store._raw_log_path(session_id)
    if not raw_path.exists():
        return {"entries": [], "total": 0, "offset": offset, "limit": limit}

    all_entries = []
    with open(raw_path, 'r', encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entry = json.loads(line)
                    if errors_only and entry.get("dir") != "error":
                        continue
                    if direction and entry.get("dir") != direction:
                        continue
                    all_entries.append(entry)
                except json.JSONDecodeError:
                    continue

    total = len(all_entries)

    if sort == "desc":
        all_entries = all_entries[::-1]

    paginated = all_entries[offset:offset + limit]

    return {
        "entries": paginated,
        "total": total,
        "offset": offset,
        "limit": limit,
        "has_more": offset + limit < total
    }


# ═══════════════════════════════════════════════════════════════════
# Tool Output Files
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/sessions/{session_id}/logs/tools")
async def get_session_tool_files(session_id: str, store: SessionStore = Depends(get_session_store)):
    """List all tool output files for a session."""
    tools_dir = store._tools_dir(session_id)
    if not tools_dir.exists():
        return {"files": []}

    files = []
    for f in sorted(tools_dir.iterdir()):
        if f.is_file():
            name_parts = f.stem.rsplit("_", 1)
            tool_name = name_parts[0] if len(name_parts) > 1 else f.stem

            files.append({
                "name": f.name,
                "tool_name": tool_name,
                "size": f.stat().st_size,
                "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat() + "Z"
            })

    return {"files": files, "count": len(files)}


@router.get("/api/sessions/{session_id}/logs/tools/{filename}")
async def get_session_tool_output(session_id: str, filename: str, store: SessionStore = Depends(get_session_store)):
    """Get content of a specific tool output file."""
    tools_dir = store._tools_dir(session_id)
    file_path = tools_dir / filename

    try:
        file_path = file_path.resolve()
        # is_relative_to, not startswith: a string prefix test would also accept
        # a sibling directory whose name merely starts with the same characters
        # (".../tools" is a prefix of ".../tools_extra").
        if not file_path.is_relative_to(tools_dir.resolve()):
            raise HTTPException(status_code=403, detail="Access denied")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid filename")

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    try:
        content = file_path.read_text(encoding="utf-8", errors='replace')
        return {
            "filename": filename,
            "size": len(content),
            "content": content
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'}


@router.get("/api/sessions/{session_id}/uploads")
async def list_session_uploads(session_id: str, scope: str = "session", store: SessionStore = Depends(get_session_store)):
    """List uploaded files. scope='session' (default) lists this session only;
    scope='project' lists uploads across every session in the same project."""
    def _entry(path, sid: str) -> dict:
        stat = path.stat()
        return {
            "name": path.name,
            "session_id": sid,
            # Absolute path — non-image uploads re-attach to the chat input by
            # path (the prompt carries "Uploaded file: <path>"), so the browser
            # needs it without a second round-trip.
            "path": str(path.resolve()),
            "size": stat.st_size,
            "modified": datetime.fromtimestamp(stat.st_mtime).isoformat() + "Z",
            "is_image": path.suffix.lower() in IMAGE_EXTENSIONS,
        }

    if scope == "project":
        files = []
        for sess_dir in store.base_dir.iterdir():
            if not sess_dir.is_dir():
                continue
            uploads_dir = sess_dir / "uploads"
            if not uploads_dir.exists():
                continue
            for f in uploads_dir.iterdir():
                if f.is_file():
                    files.append(_entry(f, sess_dir.name))
        files.sort(key=lambda x: x["modified"], reverse=True)
        return {"files": files, "count": len(files), "scope": "project"}

    uploads_dir = store._uploads_dir(session_id)
    if not uploads_dir.exists():
        return {"files": [], "count": 0, "scope": "session"}

    files = [_entry(f, session_id) for f in sorted(uploads_dir.iterdir()) if f.is_file()]
    return {"files": files, "count": len(files), "scope": "session"}


@router.get("/api/sessions/{session_id}/uploads/{filename}")
async def get_session_upload(session_id: str, filename: str, base64_encode: bool = False, store: SessionStore = Depends(get_session_store)):
    """Serve an uploaded file (image/file) from a session's uploads directory.
    With ?base64_encode=true, returns JSON with base64-encoded data (for image restore)."""
    uploads_dir = store._uploads_dir(session_id)
    file_path = (uploads_dir / filename).resolve()

    # Path traversal protection. is_relative_to, not startswith: a string prefix
    # test would also accept a sibling directory whose name merely starts with
    # the same characters (".../uploads" is a prefix of ".../uploads_old").
    if not file_path.is_relative_to(uploads_dir.resolve()):
        raise HTTPException(status_code=403, detail="Access denied")

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    if not base64_encode:
        ext = file_path.suffix.lower()
        # Never cache authenticated user content in shared/proxy caches.
        headers = {
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        }
        inline_type = _INLINE_IMAGE_TYPES.get(ext)
        if inline_type:
            # Raster image: safe to render inline (can't execute).
            return FileResponse(file_path, media_type=inline_type, headers=headers)
        # Anything else (.svg, .html, .js, arbitrary uploads): force an inert
        # download so it cannot execute in the app origin.
        return FileResponse(
            file_path,
            media_type="application/octet-stream",
            filename=file_path.name,
            headers=headers,
        )

    # Return base64-encoded data for image restoration after page refresh
    import base64 as b64
    content = file_path.read_bytes()
    ext = file_path.suffix.lower()
    media_type = _INLINE_IMAGE_TYPES.get(ext, 'application/octet-stream')
    encoded = b64.standard_b64encode(content).decode('utf-8')
    return {"filename": filename, "media_type": media_type, "size": len(content), "data": encoded}


# ═══════════════════════════════════════════════════════════════════
# Session Changes (Edit/Write tracking)
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/sessions/{session_id}/changes")
async def get_session_changes(session_id: str, store: SessionStore = Depends(get_session_store)):
    """Get file changes made by Claude during this session."""
    return await asyncio.to_thread(compute_session_changes, store, session_id)


def compute_session_changes(store, session_id: str) -> dict:
    """Compute file changes from messages.jsonl. Reusable helper.

    Returns: {"files": [...], "summary": {...}}
    """
    messages_path = store._messages_path(session_id)
    tools_dir = store._session_dir(session_id) / "tools"
    if not messages_path.exists():
        return {"files": [], "summary": {"totalFiles": 0, "modified": 0, "created": 0, "linesAdded": 0, "linesRemoved": 0}}

    changes_by_file = {}

    def count_lines(text):
        if not text:
            return 0
        return len([line for line in text.split('\n') if line.strip()])

    def count_diff_changes(old_string, new_string):
        old_lines = old_string.split('\n') if old_string else []
        new_lines = new_string.split('\n') if new_string else []

        matcher = difflib.SequenceMatcher(None, old_lines, new_lines)

        added = 0
        removed = 0

        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == 'replace':
                removed += (i2 - i1)
                added += (j2 - j1)
            elif tag == 'delete':
                removed += (i2 - i1)
            elif tag == 'insert':
                added += (j2 - j1)

        return added, removed

    def load_tool_output(tool_output, tool_output_file):
        if tool_output and tool_output.startswith('[Stored in ') and tool_output.endswith(']'):
            ref_file = tool_output[11:-1]
            file_path = tools_dir / ref_file
            if file_path.exists():
                try:
                    return file_path.read_text(encoding="utf-8")
                except Exception:
                    pass
        if tool_output_file:
            file_path = tools_dir / tool_output_file
            if file_path.exists():
                try:
                    return file_path.read_text(encoding="utf-8")
                except Exception:
                    pass
        return tool_output or ''

    def parse_line_number(tool_output, new_string):
        if not tool_output or not new_string:
            return None
        line_pattern = re.compile(r'^\s*(\d+)(?:\u2192|\t)(.*)$', re.MULTILINE)
        first_new_line = new_string.split('\n')[0] if new_string else ''

        for match in line_pattern.finditer(tool_output):
            line_num, content = match.groups()
            if content.strip() == first_new_line.strip():
                return int(line_num)
        return None

    def process_tool(tool_name, tool_id, tool_input, tool_output, tool_output_file, timestamp):
        if tool_name not in ('Edit', 'Write'):
            return

        file_path = tool_input.get('file_path', '')
        if not file_path:
            return

        if file_path not in changes_by_file:
            changes_by_file[file_path] = {
                'filePath': file_path,
                'fileName': Path(file_path).name,
                'fileType': Path(file_path).suffix.lstrip('.'),
                'status': 'created' if tool_name == 'Write' else 'modified',
                'edits': [],
                'firstChange': timestamp,
                'lastChange': timestamp,
                'linesAdded': 0,
                'linesRemoved': 0,
            }

        file_entry = changes_by_file[file_path]
        file_entry['lastChange'] = timestamp

        if tool_name == 'Edit':
            old_string = tool_input.get('old_string', '')
            new_string = tool_input.get('new_string', '')

            lines_added, lines_removed = count_diff_changes(old_string, new_string)

            actual_output = load_tool_output(tool_output, tool_output_file)
            start_line = parse_line_number(actual_output, new_string)

            edit = {
                'toolId': tool_id,
                'timestamp': timestamp,
                'type': 'edit',
                'oldString': old_string,
                'newString': new_string,
                'linesAdded': lines_added,
                'linesRemoved': lines_removed,
                'startLine': start_line,
            }
            file_entry['edits'].append(edit)
            file_entry['linesAdded'] += edit['linesAdded']
            file_entry['linesRemoved'] += edit['linesRemoved']
            if len(file_entry['edits']) == 1 and file_entry['status'] == 'created':
                file_entry['status'] = 'modified'

        elif tool_name == 'Write':
            content = tool_input.get('content', '')
            new_lines = count_lines(content)

            edit = {
                'toolId': tool_id,
                'timestamp': timestamp,
                'type': 'write',
                'content': content,
                'linesAdded': new_lines,
                'linesRemoved': 0,
                'startLine': 1,
            }
            file_entry['edits'].append(edit)
            file_entry['linesAdded'] += new_lines
            file_entry['status'] = 'created'

    # Read messages and extract changes
    with open(messages_path, 'r', encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
                timestamp = msg.get('timestamp', '')

                if msg.get('role') == 'tool':
                    process_tool(
                        msg.get('tool_name', ''),
                        msg.get('tool_id', ''),
                        msg.get('tool_input', {}),
                        msg.get('tool_output', ''),
                        msg.get('tool_output_file', ''),
                        timestamp
                    )

                if msg.get('role') == 'thinking' and msg.get('tools'):
                    for tool in msg['tools']:
                        process_tool(
                            tool.get('toolName', ''),
                            tool.get('toolId', ''),
                            tool.get('toolInput', {}),
                            tool.get('toolOutput', ''),
                            tool.get('toolOutputFile', ''),
                            timestamp
                        )

            except json.JSONDecodeError:
                continue

    files = list(changes_by_file.values())
    files.sort(key=lambda f: f['lastChange'], reverse=True)

    for f in files:
        f['editCount'] = len(f['edits'])

    summary = {
        'totalFiles': len(files),
        'modified': sum(1 for f in files if f['status'] == 'modified'),
        'created': sum(1 for f in files if f['status'] == 'created'),
        'linesAdded': sum(f['linesAdded'] for f in files),
        'linesRemoved': sum(f['linesRemoved'] for f in files),
    }

    return {"files": files, "summary": summary}


# ═══════════════════════════════════════════════════════════════════
# Session Reads (Read tool tracking)
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/sessions/{session_id}/read-files")
async def get_session_read_files(session_id: str, store: SessionStore = Depends(get_session_store)):
    """Get files Claude opened with the Read tool during this session.

    Unlike /changes (Edit/Write), reads aren't persisted anywhere queryable,
    so we reconstruct them by scanning messages.jsonl for Read tool calls.
    Returns files most-recently-read first.
    """
    return await asyncio.to_thread(compute_session_read_files, store, session_id)


def compute_session_read_files(store, session_id: str) -> dict:
    """Scan messages.jsonl for Read tool calls → unique files, recent first.

    Returns: {"files": [{filePath, fileName, readCount, firstRead, lastRead}], "summary": {...}}
    """
    messages_path = store._messages_path(session_id)
    if not messages_path.exists():
        return {"files": [], "summary": {"totalFiles": 0, "totalReads": 0}}

    reads_by_file = {}

    def process_tool(tool_name, tool_input, timestamp):
        if tool_name != 'Read':
            return
        file_path = (tool_input or {}).get('file_path', '')
        if not file_path:
            return
        entry = reads_by_file.get(file_path)
        if entry is None:
            reads_by_file[file_path] = {
                'filePath': file_path,
                'fileName': Path(file_path).name,
                'fileType': Path(file_path).suffix.lstrip('.'),
                'readCount': 1,
                'firstRead': timestamp,
                'lastRead': timestamp,
            }
        else:
            entry['readCount'] += 1
            if timestamp:
                entry['lastRead'] = timestamp

    with open(messages_path, 'r', encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            timestamp = msg.get('timestamp', '')

            if msg.get('role') == 'tool':
                process_tool(msg.get('tool_name', ''), msg.get('tool_input', {}), timestamp)

            if msg.get('role') == 'thinking' and msg.get('tools'):
                for tool in msg['tools']:
                    process_tool(tool.get('toolName', ''), tool.get('toolInput', {}), timestamp)

    files = list(reads_by_file.values())
    files.sort(key=lambda f: f['lastRead'], reverse=True)

    summary = {
        'totalFiles': len(files),
        'totalReads': sum(f['readCount'] for f in files),
    }
    return {"files": files, "summary": summary}
