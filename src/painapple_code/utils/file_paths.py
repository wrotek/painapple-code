"""
File Path Extraction and Verification

Utilities for extracting file paths from Claude's output text and verifying
that they exist on disk. Used for server-side linkification.
"""

import os
import re
from pathlib import Path


# Known file extensions for linkification
# IMPORTANT: Longer extensions MUST come before shorter prefixes (css before c, hpp before h, etc.)
# otherwise regex alternation will match the shorter one first (e.g., .c instead of .css)
FILE_EXTENSIONS = r'dockerignore|gitignore|graphql|makefile|prisma|svelte|astro|cmake|scss|sass|less|html|json|yaml|toml|bash|lock|conf|cpp|css|csv|cfg|hpp|htm|ini|jsx|log|sql|tsx|vue|xml|yml|env|txt|zsh|go|js|kt|md|py|rb|rs|sh|ts|c|h|java|swift'

# Regex patterns for file path extraction
PATH_PATTERN = re.compile(
    r'(' +
        r'(?:~\/|\.{0,2}/)?' +        # Optional ~/ or ./ or ../ or /
        r'(?:[\w@.-]+/)' +            # At least one directory with /
        r'(?:[\w@.-]+/)*' +           # Additional directories
        r'[\w@.-]+' +                 # Final filename
        r'(?:\.(?:' + FILE_EXTENSIONS + r'))?' +  # Optional extension
    r')' +
    r'(:\d+(?:[-:]\d+)?|#L\d+(?:-L\d+)?)?',  # Optional :line or #Lline (GitHub-style)
    re.IGNORECASE
)

STANDALONE_PATTERN = re.compile(
    r'(?<![\w./])' +                # Not preceded by word char, dot, or slash
    r'([A-Za-z0-9_]' +               # Start with letter, digit, or underscore
    r'[A-Za-z0-9_-]*' +              # Followed by alphanumeric, underscore, or hyphen
    r'(?:\.[A-Za-z0-9_-]+)*' +       # Optional .middle.parts
    r'\.(?:' + FILE_EXTENSIONS + r'))' +  # Required .extension
    r'(:\d+(?:[-:]\d+)?|#L\d+(?:-L\d+)?)?',  # Optional :line or #Lline (GitHub-style)
    re.IGNORECASE
)

# Common subdirectories to search for files
COMMON_SUBDIRS = [
    '', 'src', 'static', 'static/js', 'static/js/widgets',
    'static/js/controllers', 'static/css', 'lib', 'app',
    'components', 'utils', 'tests', 'docs'
]

# Directory names the fuzzy filename search never descends into. Exact
# paths and context hints still resolve inside them (those are direct
# existence checks) — this list only stops the ranked walk from wandering
# into dependency/build trees and returning e.g. node_modules/*/index.md
# over docs/index.md.
IGNORED_SEARCH_DIRS = {
    'node_modules', '.git', '.hg', '.svn',
    'venv', '.venv', 'env', 'virtualenv',
    '__pycache__', '.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache',
    '.tox', '.nox', 'site-packages',
    'dist', 'build', '.next', '.nuxt', 'target',
}

# Bounds for the ranked fuzzy walk
_SEARCH_MAX_DEPTH = 4     # directories below base a match may live in
_SEARCH_MAX_DIRS = 4000   # hard cap on directories visited per walk
_MAX_HINT_DIRS = 8

# Linux limits: PATH_MAX=4096, NAME_MAX=255 — conservative values to skip
# obviously non-path strings before any filesystem call
MAX_PATH_LEN = 1000
MAX_NAME_LEN = 250


def extract_file_paths(text: str) -> set:
    """Extract potential file paths from text content."""
    paths = set()

    # Extract paths with directories
    for match in PATH_PATTERN.finditer(text):
        path = match.group(1)
        if '/' in path and not path.startswith(('http://', 'https://')):
            # Skip version-like patterns
            if not re.match(r'^\d+\.\d+', path) and not re.match(r'^\d+/\d+', path):
                paths.add(path)

    # Extract standalone filenames
    for match in STANDALONE_PATTERN.finditer(text):
        filename = match.group(1)
        # Skip version patterns
        if not re.match(r'^\d+\.\d+', filename):
            paths.add(filename)

    return paths


def extract_file_paths_with_positions(text: str) -> list:
    """
    Extract potential file paths from text with their positions.
    Returns list of {path, start, end, line_info} dicts.
    """
    results = []

    # Extract paths with directories
    for match in PATH_PATTERN.finditer(text):
        path = match.group(1)
        line_info = match.group(2) or ''
        if '/' in path and not path.startswith(('http://', 'https://')):
            # Skip version-like patterns
            if not re.match(r'^\d+\.\d+', path) and not re.match(r'^\d+/\d+', path):
                results.append({
                    'path': path,
                    'start': match.start(),
                    'end': match.end(),
                    'line_info': line_info
                })

    # Extract standalone filenames
    for match in STANDALONE_PATTERN.finditer(text):
        filename = match.group(1)
        line_info = match.group(2) or ''
        # Skip version patterns
        if not re.match(r'^\d+\.\d+', filename):
            results.append({
                'path': filename,
                'start': match.start(),
                'end': match.end(),
                'line_info': line_info
            })

    return results


def extract_file_links(text: str, cwd: str) -> list:
    """
    Extract file paths with positions and verify which exist.
    Returns list of {path, resolved, start, end, line_info} for verified files only.
    """
    candidates = extract_file_paths_with_positions(text)
    if not candidates:
        return []

    # Get unique paths for verification
    unique_paths = set(c['path'] for c in candidates)
    verified = verify_file_paths(unique_paths, cwd)

    # Filter to only verified files and add resolved paths
    file_links = []
    for c in candidates:
        resolved = verified.get(c['path'])
        if resolved:
            file_links.append({
                'path': c['path'],
                'resolved': resolved,
                'start': c['start'],
                'end': c['end'],
                'line_info': c['line_info']
            })

    return file_links


def _normalize_hint_dirs(hints, base: Path) -> list:
    """Turn raw hint strings (from terminal context, etc.) into existing
    directory Paths. Relative hints resolve against base; junk and
    duplicates are dropped. Order is preserved — callers pass hints
    most-relevant-first."""
    dirs = []
    seen = set()
    for hint in hints or ():
        if not isinstance(hint, str):
            continue
        hint = hint.strip().rstrip('/')
        if not hint or hint in ('.', '..', '~') or len(hint) > MAX_PATH_LEN:
            continue
        hint_dir = Path(hint).expanduser() if hint.startswith(('~', '/')) else base / hint
        try:
            if not hint_dir.is_dir():
                continue
            hint_dir = hint_dir.resolve()
        except OSError:
            continue
        key = str(hint_dir)
        if key not in seen:
            seen.add(key)
            dirs.append(hint_dir)
        if len(dirs) >= _MAX_HINT_DIRS:
            break
    return dirs


def _resolve_direct(name: str, base: Path, hint_dirs: list):
    """Direct (no-walk) resolution tiers: absolute/~ paths, exact
    base/name, hint dirs, then COMMON_SUBDIRS for bare filenames."""
    if name.startswith('~') or name.startswith('/'):
        check_path = Path(name).expanduser()
        return str(check_path) if check_path.is_file() else None

    exact = base / name
    if exact.is_file():
        return str(exact)

    # Context hints beat every heuristic tier — they reflect what the user
    # was actually looking at, and they work for slashed names too
    for hint_dir in hint_dirs:
        check_path = hint_dir / name
        if check_path.is_file():
            return str(check_path)

    # Relative multi-segment paths must match exactly — no fuzzy search
    if '/' in name:
        return None

    for subdir in COMMON_SUBDIRS:
        check_path = base / subdir / name if subdir else base / name
        if check_path.is_file():
            return str(check_path)
    return None


def _find_files_ranked(base: Path, names: set, prune: bool = True) -> dict:
    """One bounded walk under base collecting every file whose basename is
    in names. With prune=True (default) IGNORED_SEARCH_DIRS are skipped;
    prune=False is the last-resort pass that descends into dependency and
    build trees (still bounded by the same depth/dir caps). Candidates per
    name are ranked shallowest-first, then newest-mtime-first (a recently
    touched file is the likelier referent among same-depth twins).
    Returns {name: [Path, ...] best-first}."""
    found = {n: [] for n in names}
    if not names:
        return found

    base_str = str(base)
    visited = 0
    for root, dirs, files in os.walk(base_str):
        visited += 1
        if visited > _SEARCH_MAX_DIRS:
            break
        rel = os.path.relpath(root, base_str)
        depth = 0 if rel == '.' else rel.count(os.sep) + 1
        if depth >= _SEARCH_MAX_DEPTH:
            dirs[:] = []
        elif prune:
            dirs[:] = [
                d for d in dirs
                if d not in IGNORED_SEARCH_DIRS and not d.endswith('.egg-info')
            ]
        for name in names.intersection(files):
            found[name].append(Path(root) / name)

    def rank_key(p: Path):
        try:
            mtime = p.stat().st_mtime
        except OSError:
            mtime = 0.0
        return (len(p.relative_to(base).parts), -mtime)

    for candidates in found.values():
        candidates.sort(key=rank_key)
    return found


def resolve_project_files(names, cwd: str, hints=()) -> dict:
    """
    Resolve file names/paths against a project directory, optionally
    guided by context hint directories (e.g. scraped from the terminal
    lines around a clicked filename, or the shell's live cwd).

    Resolution order per name:
      1. `~/...` and absolute paths — checked directly.
      2. Exact `base/name`.
      3. `hint/name` for each hint dir in order — the only tier that
         resolves inside IGNORED_SEARCH_DIRS.
      4. Bare filenames only: COMMON_SUBDIRS, then one ranked walk
         (shallowest match wins, newer mtime breaks ties; dependency and
         build trees are pruned).
      5. Last resort, bare filenames still unresolved: a second ranked
         walk with pruning off, so node_modules/venv/build trees can
         match — but only when nothing else in the project does.

    Returns {name: resolved_absolute_path_or_None}.
    """
    results = {n: None for n in names}
    if not cwd:
        return results

    base = Path(cwd).expanduser().resolve()
    if not base.is_dir():
        return results

    hint_dirs = _normalize_hint_dirs(hints, base)

    walk_names = set()
    for name in names:
        # Skip over-long names (prevents ENAMETOOLONG) before touching disk
        if len(name) > MAX_PATH_LEN or any(len(part) > MAX_NAME_LEN for part in name.split('/')):
            continue
        try:
            resolved = _resolve_direct(name, base, hint_dirs)
        except (PermissionError, OSError):
            resolved = None
        if resolved:
            results[name] = resolved
        elif '/' not in name:
            walk_names.add(name)

    if walk_names:
        try:
            ranked = _find_files_ranked(base, walk_names)
        except (PermissionError, OSError):
            ranked = {}
        for name in walk_names:
            candidates = ranked.get(name)
            if candidates:
                results[name] = str(candidates[0])

        # Last-resort pass: names with no match anywhere outside ignored
        # dirs get one unpruned walk, so a genuine node_modules/venv file
        # still resolves — at the lowest possible priority.
        leftover = {n for n in walk_names if results[n] is None}
        if leftover:
            try:
                ranked = _find_files_ranked(base, leftover, prune=False)
            except (PermissionError, OSError):
                ranked = {}
            for name in leftover:
                candidates = ranked.get(name)
                if candidates:
                    results[name] = str(candidates[0])

    return results


def resolve_project_dir(name: str, cwd: str, hints=()):
    """
    Resolve a directory reference using the same direct tiers as file
    resolution: absolute/~ paths, exact base/name, then hint dirs. No
    ranked walk — bare directory names (src, build, …) are too ambiguous
    to search for project-wide.

    Returns the resolved absolute path string, or None.
    """
    if not name or len(name) > MAX_PATH_LEN:
        return None
    try:
        if name.startswith('~') or name.startswith('/'):
            check_path = Path(name).expanduser()
            return str(check_path) if check_path.is_dir() else None
        if not cwd:
            return None
        base = Path(cwd).expanduser().resolve()
        if not base.is_dir():
            return None
        exact = base / name
        if exact.is_dir():
            return str(exact)
        for hint_dir in _normalize_hint_dirs(hints, base):
            check_path = hint_dir / name
            if check_path.is_dir():
                return str(check_path)
    except (PermissionError, OSError):
        return None
    return None


def verify_file_paths(paths: set, cwd: str, hints=()) -> dict:
    """
    Verify which file paths exist, searching subdirectories if needed.
    Returns {original_path: resolved_full_path or None}
    """
    if not cwd:
        return {p: None for p in paths}
    return resolve_project_files(paths, cwd, hints)


def parse_edit_line_number(tool_output: str, new_string: str) -> int:
    """
    Parse starting line number from Edit tool output.

    Claude returns format like: "  1234→    content here" (older) or "1234\tcontent here" (current).
    We find the line that matches the first line of new_string.

    Returns the line number or None if not found.
    """
    if not tool_output or not new_string:
        return None

    import re
    line_pattern = re.compile(r'^\s*(\d+)(?:→|\t)(.*)$', re.MULTILINE)
    first_new_line = new_string.split('\n')[0] if new_string else ''

    for match in line_pattern.finditer(tool_output):
        line_num, content = match.groups()
        # Match if content matches first line of new_string (trim to handle padding)
        if content.strip() == first_new_line.strip():
            return int(line_num)
    return None


def add_verified_files_to_message(msg: dict, cwd: str) -> dict:
    """
    Extract file paths from message content and add fileLinks with positions.
    Adds fileLinks array to each content block (positions relative to block text).
    Also maintains verifiedFiles map for backwards compatibility.
    Modifies the message in place and returns it.
    """
    msg_type = msg.get("type")
    if msg_type not in ("assistant", "user"):
        return msg

    message = msg.get("message", {})
    content = message.get("content", [])

    if not isinstance(content, list):
        return msg

    all_verified = {}  # For backwards compat verifiedFiles

    for block in content:
        text = None

        if msg_type == "assistant" and block.get("type") == "text":
            text = block.get("text", "")
        elif msg_type == "user" and block.get("type") == "tool_result":
            # Tool result content can be string or list
            tool_content = block.get("content", "")
            if isinstance(tool_content, str):
                text = tool_content
            elif isinstance(tool_content, list):
                # Combine list content for this block
                parts = []
                for item in tool_content:
                    if isinstance(item, dict) and item.get("type") == "text":
                        parts.append(item.get("text", ""))
                    elif isinstance(item, str):
                        parts.append(item)
                text = "\n".join(parts)

        if not text:
            continue

        # Extract file links with positions for this block
        file_links = extract_file_links(text, cwd)
        if file_links:
            block["fileLinks"] = file_links
            # Also collect for backwards compat
            for link in file_links:
                all_verified[link['path']] = link['resolved']

    # Always set verifiedFiles (even if empty) so client knows verification was done
    msg["verifiedFiles"] = all_verified

    return msg


# ═══════════════════════════════════════════════════════════════════════
# Path Security
# ═══════════════════════════════════════════════════════════════════════

# Kernel-special filesystems we don't want clients walking into via the
# Open dialog / file browser — listing or reading them is at best useless
# and at worst causes massive blocking reads (/proc/kcore is a 128TB file
# on x86_64, kernel-traversing /sys directories hang on slow buses, etc.).
# This is the ONLY path restriction the bridge applies, and it exists for
# practical reasons, not security ones.
_DENY_ROOTS = (
    Path("/proc"),
    Path("/sys"),
    Path("/dev"),
)

PATH_DENIED_DETAIL = ("Path not allowed — /proc, /sys and /dev are off limits "
                      "(kernel-special files, not a security boundary)")


def is_path_allowed_for_read(path: Path) -> bool:
    """
    Allow anywhere on the filesystem except the kernel-special trees above.

    OS file permissions still apply — the bridge process can only touch what
    its OS user can touch, so this doesn't broaden actual access beyond what
    the user already has via their shell.
    """
    resolved = path.resolve()
    return not any(
        resolved == deny or deny in resolved.parents
        for deny in _DENY_ROOTS
    )


# Writes follow the exact same policy as reads. There used to be a separate,
# stricter allowlist here ($HOME + /tmp, later + the workspace and opted-in
# roots), but it was security theater: every caller is already past the
# password gate, and an authenticated user has a full PTY terminal, `!bang`
# commands, and an agent running as the same OS user — anything the editor
# could be stopped from writing is one shell line away. All the allowlist
# actually did was 403 legitimate edits to projects that don't live under
# home (/data, /srv, /mnt, Docker's /workspace). OS permissions are the real
# boundary and they still apply.
is_path_allowed = is_path_allowed_for_read


def resolve_work_dir(cwd: str = None) -> Path:
    """Resolve a cwd string to a validated Path.

    Raises HTTPException(403) for the kernel-special trees only.
    """
    from fastapi import HTTPException
    work_dir = Path(cwd).expanduser().resolve() if cwd else Path.cwd()
    if not is_path_allowed(work_dir):
        raise HTTPException(status_code=403, detail=PATH_DENIED_DETAIL)
    return work_dir
