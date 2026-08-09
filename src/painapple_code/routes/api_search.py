"""
Search API Routes - Project-wide content search ("Search in Files" widget)

GET /api/search runs ripgrep against a project directory and returns matches
grouped per file, with char-offset highlight spans for the client to render.
Falls back to a pure-Python walker when ripgrep isn't installed (degraded:
.gitignore not respected — the response says so via `engine`/`gitignore_respected`).

Design notes (session fP--zppLO6s plan, 2026-05-21):
- subprocess via argv-list `asyncio.create_subprocess_exec` (never shell=True —
  the search term is an argv element, so no injection surface)
- rg `--json` NDJSON stream is read incrementally so we can stop at `limit`
  and kill the process instead of buffering unbounded output
- byte offsets from rg submatches are converted to char offsets server-side
  so the client can slice JS strings directly
"""

import asyncio
import base64
import fnmatch
import json
import logging
import os
import re
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException

from painapple_code.utils.file_paths import is_path_allowed_for_read, safe_resolve

logger = logging.getLogger(__name__)

router = APIRouter(tags=["search"])

# Directories never searched, regardless of ignore settings — mirrors the
# hardcoded exclude list api_files._enumerate_files uses for file listing.
EXCLUDED_DIRS = (
    "node_modules", ".git", "__pycache__", "venv", ".venv",
    "dist", "build", ".next", "coverage",
)

MAX_FILESIZE = "1M"            # rg --max-filesize (skip huge/minified files)
MAX_FILESIZE_BYTES = 1_000_000  # same cap for the python fallback
MAX_PER_FILE = 100             # per-file match ceiling (rg --max-count)
DEFAULT_LIMIT = 500            # total match cap unless the client asks lower
MAX_LIMIT = 2000
MAX_QUERY_LEN = 1000
SEARCH_TIMEOUT = 20.0          # overall wall-clock budget for rg (seconds)
FALLBACK_TIMEOUT = 10.0        # python fallback budget
MAX_LINE_CHARS = 400           # long lines clipped to a window around the match
# rg emits one JSON line per match incl. the full matched line; --max-filesize
# bounds lines at ~1MB, JSON-escaping can inflate ~6x worst case.
STREAM_LIMIT = 8 * 1024 * 1024


def _event_text(obj) -> str:
    """Extract text from an rg JSON data object ({"text": ...} or {"bytes": b64})."""
    if not obj:
        return ""
    if "text" in obj:
        return obj["text"]
    try:
        return base64.b64decode(obj.get("bytes", "")).decode("utf-8", errors="replace")
    except Exception:
        return ""


def _clip_line(text: str, spans: list) -> tuple[str, list, bool, bool]:
    """Clip very long lines to a window around the first match.

    Returns (text, adjusted_spans, clipped_start, clipped_end).
    Spans are [start, end] char offsets into the returned text.
    """
    if len(text) <= MAX_LINE_CHARS:
        return text, spans, False, False
    first = spans[0][0] if spans else 0
    start = max(0, first - 80)
    end = min(len(text), start + MAX_LINE_CHARS)
    clipped = text[start:end]
    out_spans = []
    for s, e in spans:
        s2, e2 = max(s - start, 0), min(e - start, len(clipped))
        if e2 > s2 and s2 < len(clipped):
            out_spans.append([s2, e2])
    return clipped, out_spans, start > 0, end < len(text)


def _parse_globs(raw: str) -> list[str]:
    """Split a comma-separated glob string into a clean list."""
    return [g.strip() for g in (raw or "").split(",") if g.strip()]


# ═══════════════════════════════════════════════════════════════════════
# ripgrep engine
# ═══════════════════════════════════════════════════════════════════════

def _build_rg_args(q, regex, case_sensitive, whole_word,
                   include, exclude, include_ignored) -> list[str]:
    args = [
        "rg", "--json", "--no-config",
        f"--max-count={MAX_PER_FILE}",
        f"--max-filesize={MAX_FILESIZE}",
    ]
    if not case_sensitive:
        args.append("-i")
    if whole_word:
        args.append("-w")
    if not regex:
        args.append("-F")
    if include_ignored:
        args += ["--no-ignore", "--hidden"]
    # Hardcoded excludes always apply (gitignore-style: bare name = any depth)
    for d in EXCLUDED_DIRS:
        args += ["-g", f"!{d}"]
    for g in include:
        args += ["-g", g]
    for g in exclude:
        args += ["-g", f"!{g}"]
    args += ["-e", q]
    return args


async def _search_ripgrep(work_dir: Path, q, regex, case_sensitive, whole_word,
                          include, exclude, include_ignored, limit):
    """Run rg --json, streaming events so we can stop at `limit`.

    Returns (matches_by_file, order, total, truncated).
    Raises FileNotFoundError if rg isn't installed, HTTPException(400) on
    a bad pattern.
    """
    args = _build_rg_args(q, regex, case_sensitive, whole_word,
                          include, exclude, include_ignored)
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=str(work_dir),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=STREAM_LIMIT,
    )

    matches_by_file: dict[str, list] = {}
    order: list[str] = []
    total = 0
    truncated = False
    loop = asyncio.get_running_loop()
    deadline = loop.time() + SEARCH_TIMEOUT

    try:
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                truncated = True
                break
            try:
                line = await asyncio.wait_for(proc.stdout.readline(), timeout=remaining)
            except asyncio.TimeoutError:
                truncated = True
                break
            except (ValueError, asyncio.LimitOverrunError):
                # Single event line exceeded STREAM_LIMIT — skip the rest of it
                continue
            if not line:
                break
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("type") != "match":
                continue

            data = event.get("data", {})
            # ripgrep emits OS-native separators; normalize so the client
            # and the Python fallback engine agree on the shape.
            #
            # Keyed off os.sep, NOT an unconditional '\\' -> '/'. On
            # Linux/macOS a backslash is an ordinary filename byte, so the
            # blanket rewrite turned a real `src/weird\name.txt` into
            # `src/weird/name.txt` — a path that doesn't exist, 404ing in
            # the preview — while _search_python's relative_to().as_posix()
            # preserved it. Same query, two answers, depending only on
            # whether rg happened to be installed.
            path = _event_text(data.get("path")).replace(os.sep, "/")
            lines_obj = data.get("lines", {})
            raw = _event_text(lines_obj).rstrip("\r\n")

            spans = []
            if "text" in lines_obj:
                # Submatch offsets are bytes into the utf-8 line; convert to chars
                lb = lines_obj["text"].encode("utf-8")
                for sm in data.get("submatches", []):
                    try:
                        s = len(lb[:sm["start"]].decode("utf-8"))
                        e = len(lb[:sm["end"]].decode("utf-8"))
                    except (UnicodeDecodeError, KeyError, TypeError):
                        continue
                    s, e = min(s, len(raw)), min(e, len(raw))
                    if e > s:
                        spans.append([s, e])

            text, spans, clipped_start, clipped_end = _clip_line(raw, spans)
            entry = {"line": data.get("line_number"), "text": text, "spans": spans}
            if clipped_start:
                entry["clipped_start"] = True
            if clipped_end:
                entry["clipped_end"] = True

            if path not in matches_by_file:
                matches_by_file[path] = []
                order.append(path)
            matches_by_file[path].append(entry)

            total += 1
            if total >= limit:
                truncated = True
                break
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass

    # Reap the process and collect stderr (for pattern errors)
    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=5.0)
    except asyncio.TimeoutError:
        stderr = b""

    # Exit 2 = rg error. Only surface it when we got nothing back — rg also
    # exits 2 on partial per-file errors (e.g. one unreadable file) with
    # perfectly good matches alongside.
    if total == 0 and not truncated and proc.returncode == 2:
        # rg's parse errors span multiple lines; the human-useful part is the
        # last "error: …" line (e.g. "error: unclosed character class").
        lines = [l.strip() for l in stderr.decode(errors="replace").splitlines() if l.strip()]
        detail = lines[0] if lines else "Search failed"
        for l in reversed(lines):
            if l.startswith("error:"):
                detail = f"Invalid pattern: {l[len('error:'):].strip()}"
                break
        raise HTTPException(status_code=400, detail=detail)

    return matches_by_file, order, total, truncated


# ═══════════════════════════════════════════════════════════════════════
# Python fallback engine (no ripgrep installed)
# ═══════════════════════════════════════════════════════════════════════

def _glob_match(rel: str, name: str, glob: str) -> bool:
    """gitignore-lite: glob with '/' matches the relative path, else the basename."""
    if "/" in glob:
        return fnmatch.fnmatch(rel, glob.lstrip("/"))
    return fnmatch.fnmatch(name, glob)


def _search_python(work_dir: Path, q, regex, case_sensitive, whole_word,
                   include, exclude, include_ignored, limit):
    """os.walk + re fallback. Runs in a thread. No .gitignore awareness."""
    flags = 0 if case_sensitive else re.IGNORECASE
    pattern = q if regex else re.escape(q)
    if whole_word:
        pattern = r"\b(?:%s)\b" % pattern
    try:
        rx = re.compile(pattern, flags)
    except re.error as e:
        raise HTTPException(status_code=400, detail=f"Invalid regex: {e}")

    matches_by_file: dict[str, list] = {}
    order: list[str] = []
    total = 0
    truncated = False
    deadline = time.monotonic() + FALLBACK_TIMEOUT

    for root, dirs, files in os.walk(work_dir):
        dirs[:] = sorted(
            d for d in dirs
            if d not in EXCLUDED_DIRS and (include_ignored or not d.startswith("."))
        )
        if time.monotonic() > deadline:
            truncated = True
            break
        for fname in sorted(files):
            if time.monotonic() > deadline or total >= limit:
                truncated = True
                break
            if not include_ignored and fname.startswith("."):
                continue
            fpath = Path(root) / fname
            # as_posix, not str: on Windows str() yields "sub\\dir\\f.py",
            # which (a) reaches the client with backslashes and (b) can never
            # match an include/exclude glob like "src/**" — so user filters
            # were silently ignored rather than failing loudly.
            rel = fpath.relative_to(work_dir).as_posix()
            if include and not any(_glob_match(rel, fname, g) for g in include):
                continue
            if any(_glob_match(rel, fname, g) for g in exclude):
                continue
            try:
                if fpath.stat().st_size > MAX_FILESIZE_BYTES:
                    continue
                with open(fpath, "rb") as fh:
                    head = fh.read(8192)
                    if b"\0" in head:  # binary sniff
                        continue
                    blob = head + fh.read()
            except OSError:
                continue

            content = blob.decode("utf-8", errors="replace")
            file_matches = []
            for ln, line in enumerate(content.splitlines(), 1):
                spans = [[m.start(), m.end()] for m in rx.finditer(line) if m.end() > m.start()]
                if not spans:
                    continue
                text, spans, clipped_start, clipped_end = _clip_line(line, spans)
                entry = {"line": ln, "text": text, "spans": spans}
                if clipped_start:
                    entry["clipped_start"] = True
                if clipped_end:
                    entry["clipped_end"] = True
                file_matches.append(entry)
                total += 1
                if len(file_matches) >= MAX_PER_FILE or total >= limit:
                    break
            if file_matches:
                matches_by_file[rel] = file_matches
                order.append(rel)
        if truncated:
            break

    return matches_by_file, order, total, truncated


# ═══════════════════════════════════════════════════════════════════════
# Endpoint
# ═══════════════════════════════════════════════════════════════════════

@router.get("/api/search")
async def search_in_files(
    cwd: str,
    q: str,
    regex: bool = False,
    case_sensitive: bool = False,
    whole_word: bool = False,
    include: str = "",
    exclude: str = "",
    include_ignored: bool = False,
    limit: int = DEFAULT_LIMIT,
):
    """
    Project-wide content search.

    Args:
        cwd: Directory to search (usually the session's project root)
        q: Search text (fixed string unless regex=true)
        regex: Treat q as a regular expression
        case_sensitive: Match case exactly (default: insensitive)
        whole_word: Match whole words only
        include: Comma-separated globs to include (e.g. "*.js, src/**")
        exclude: Comma-separated globs to exclude
        include_ignored: Also search .gitignore'd and hidden files
        limit: Total match cap (default 500, max 2000)

    Returns matches grouped per file with char-offset highlight spans:
        {cwd, query, engine, gitignore_respected,
         files: [{path, matches: [{line, text, spans: [[s,e],…]}]}],
         total_matches, total_files, truncated, elapsed_ms}
    """
    if not q:
        raise HTTPException(status_code=400, detail="Empty search query")
    if len(q) > MAX_QUERY_LEN:
        raise HTTPException(status_code=400, detail="Search query too long")
    limit = max(1, min(limit, MAX_LIMIT))

    work_dir = safe_resolve(cwd)
    if not is_path_allowed_for_read(work_dir):
        raise HTTPException(status_code=403, detail="Path not allowed")
    if not work_dir.exists() or not work_dir.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")

    include_globs = _parse_globs(include)
    exclude_globs = _parse_globs(exclude)

    t0 = time.monotonic()
    engine = "ripgrep"
    try:
        matches_by_file, order, total, truncated = await _search_ripgrep(
            work_dir, q, regex, case_sensitive, whole_word,
            include_globs, exclude_globs, include_ignored, limit)
    except FileNotFoundError:
        engine = "python"
        matches_by_file, order, total, truncated = await asyncio.to_thread(
            _search_python, work_dir, q, regex, case_sensitive, whole_word,
            include_globs, exclude_globs, include_ignored, limit)

    # rg's parallel walk yields nondeterministic file order — sort for a
    # stable UI (matches within a file keep line order either way).
    order.sort()

    return {
        "cwd": str(work_dir),
        "query": q,
        "engine": engine,
        "gitignore_respected": engine == "ripgrep" and not include_ignored,
        "files": [{"path": p, "matches": matches_by_file[p]} for p in order],
        "total_matches": total,
        "total_files": len(order),
        "truncated": truncated,
        "elapsed_ms": int((time.monotonic() - t0) * 1000),
    }
