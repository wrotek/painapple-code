"""
Project Config API Routes - project-specific configuration & slash commands.

These endpoints manage:
- Project-specific configuration (get/put/patch)
- Project rename (human-friendly display name)
- Project slash commands (cached list, descriptions, source paths)

Also exposes module-level helpers used by `routes.api_commands`:
- `_cli_command_descriptions()` (lazily extracted from the Claude CLI binary, memoized)
- `_get_command_descriptions` (CLI defaults + .md frontmatter overrides)
"""

import asyncio
import contextlib
import functools
import json
import logging
import mmap
import re
from pathlib import Path

from fastapi import APIRouter, Request
from pydantic import BaseModel

from painapple_code import bridge_paths
from painapple_code.session_store import SessionStore
from painapple_code.utils.file_paths import safe_resolve

logger = logging.getLogger(__name__)

router = APIRouter(tags=["bridge:project-config"])


# ═══════════════════════════════════════════════════════════════════
# Project Config API
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/project/config")
async def get_project_config(cwd: str):
    """Get project-specific configuration (merged with global)."""
    resolved_cwd = str(safe_resolve(cwd))
    config = bridge_paths.load_project_config(resolved_cwd)

    project_hash = bridge_paths.get_project_hash(resolved_cwd)
    project_dir = bridge_paths.get_project_dir(resolved_cwd)

    return {
        "config": config,
        "project": {
            "hash": project_hash,
            "path": resolved_cwd,
            "name": Path(resolved_cwd).name,
            "has_shadow_git": (project_dir / "shadow-git").exists(),
            "color": bridge_paths.get_project_color(resolved_cwd),
        }
    }


@router.put("/api/project/config")
async def update_project_config(cwd: str, request: Request):
    """Update project-specific configuration."""
    resolved_cwd = str(safe_resolve(cwd))
    body = await request.json()

    bridge_paths.save_project_config(resolved_cwd, body)

    return await get_project_config(cwd)


@router.patch("/api/project/config")
async def patch_project_config(cwd: str, request: Request):
    """Partially update project configuration (merge with existing)."""
    resolved_cwd = str(safe_resolve(cwd))
    body = await request.json()

    config_path = bridge_paths.get_project_config_path(resolved_cwd)
    existing = {}
    if config_path.exists():
        try:
            existing = json.loads(config_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    def deep_merge(base, update):
        result = base.copy()
        for key, value in update.items():
            if key in result and isinstance(result[key], dict) and isinstance(value, dict):
                result[key] = deep_merge(result[key], value)
            else:
                result[key] = value
        return result

    merged = deep_merge(existing, body)
    bridge_paths.save_project_config(resolved_cwd, merged)

    return await get_project_config(cwd)


class ProjectRenameRequest(BaseModel):
    name: str


@router.post("/api/project/rename")
async def rename_project(cwd: str, request: ProjectRenameRequest):
    """Set a human-friendly display name for a project."""
    resolved_cwd = str(safe_resolve(cwd))
    bridge_paths.set_project_display_name(resolved_cwd, request.name)

    return {
        "success": True,
        "project_path": resolved_cwd,
        "display_name": bridge_paths.get_project_display_name(resolved_cwd),
        "directory_name": Path(resolved_cwd).name,
    }


class ProjectColorRequest(BaseModel):
    # Empty string / null clears the override (revert to the deterministic
    # hash color). Any non-hex value is normalized/rejected server-side.
    color: str = ""


@router.get("/api/project/colors")
async def get_project_colors():
    """Bulk map of project path → custom color for every project with one set.

    A single fetch feeds the synchronous client-side `getProjectColor`
    override lookups across the UI (tabs, welcome cards, pickers).
    """
    return {"colors": bridge_paths.list_project_colors()}


@router.post("/api/project/color")
async def set_project_color(cwd: str, request: ProjectColorRequest):
    """Assign (or clear) a custom color for a project.

    Stored under `display.color`; an empty/invalid color clears the override.
    """
    resolved_cwd = str(safe_resolve(cwd))
    stored = bridge_paths.set_project_color(resolved_cwd, request.color)

    return {
        "success": True,
        "project_path": resolved_cwd,
        "color": stored,
    }


def _get_user_command_names(cwd: str) -> list[str]:
    """Get names of user-defined commands from ~/.claude/commands/ and {cwd}/.claude/commands/."""
    names = set()
    dirs = [
        Path.home() / ".claude" / "commands",
        Path(cwd) / ".claude" / "commands",
    ]
    for d in dirs:
        if d.is_dir():
            for f in d.iterdir():
                if f.is_file() and f.suffix == ".md":
                    names.add(f.stem)
    return sorted(names)


_MAX_SCAN_BYTES = 500 * 1024 * 1024


@contextlib.contextmanager
def _mapped_bytes(path: Path):
    """The file's bytes as a scannable buffer, mmap'd when possible.

    `re` takes any buffer, so mapping instead of `read_bytes()` keeps the
    ~100-300MB CLI bundle in the page cache the OS already has it in,
    rather than copying all of it into the server's heap. Falls back to a
    real read where mmap isn't available (some network filesystems), and
    yields b"" for an unreadable or implausibly large file.
    """
    try:
        size = path.stat().st_size
    except OSError:
        yield b""
        return
    if size > _MAX_SCAN_BYTES:
        # Kept as a cap rather than removed: this scans whatever `claude`
        # resolves to on PATH, and half a gigabyte is already ~4x the real
        # bundle, so anything past it is a wrong file, not a big one — and
        # the scan is on the request path. But it is no longer SILENT; it
        # used to look identical to "the CLI has no commands", which is
        # what `strings` (unbounded) would never have reported.
        logger.warning(
            f"Skipping slash-command extraction: {path} is {size} bytes, "
            f"over the {_MAX_SCAN_BYTES}-byte scan cap"
        )
        yield b""
        return
    try:
        with open(path, "rb") as fh:
            try:
                with mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as mm:
                    yield mm
                    return
            except (OSError, ValueError):
                fh.seek(0)
                yield fh.read()
    except OSError:
        yield b""


# `name:"xxx",description:"yyy"` / `…,description:'yyy'` as it appears in
# the CLI's embedded JS, matched against the raw binary.
#
# There is no `strings` pass in front of this any more, and none is needed.
# The point of extracting printable runs first was to stop `[^"]+` from
# swallowing NUL and other binary noise into a description; restricting the
# body to printable ASCII does that directly — `[ -!#-~]` is 0x20..0x7e
# minus `"`, `[ -&(-~]` the same minus `'`. Every other byte of the pattern
# is printable too, so a match still can't span the boundary `strings`
# would have cut at, and the result is byte-identical (verified against the
# old implementation over the real 294MB bundle: same 95 commands, same
# descriptions) for ~1/40th of the work — 2.13s to 0.05s, because the old
# form built a ~100MB str of every printable run before searching it.
_COMMAND_DEF = re.compile(
    rb'name:"([a-z][a-z0-9-]*)",description:(?:"([ -!#-~]+)"|\'([ -&(-~]+)\')'
)


@functools.lru_cache(maxsize=1)
def _cli_command_descriptions() -> dict[str, str]:
    """Extract slash command descriptions from the Claude CLI binary.

    Parses `name:"xxx",description:"yyy"` and `name:"xxx",description:'yyy'` patterns
    from the embedded JS. Some skills use single-quoted descriptions because their
    text contains double quotes (e.g. update-config's description references
    "from now on when X" in quotes).

    Lazily computed on first use and cached for the server's lifetime —
    scanning the ~100MB CLI bundle takes a couple of seconds, which must
    not happen at import time (it made every `painapple` CLI invocation
    slow) and must not happen on the event loop. Blocking: call it through
    `cli_command_descriptions()` from async code, never directly.
    """
    import shutil
    descriptions = {}
    try:
        claude_bin = shutil.which("claude")
        if claude_bin:
            real_path = Path(claude_bin).resolve()
            # Was `strings <binary>`: absent on Windows and on any Linux
            # without binutils, and a whole subprocess to do what one regex
            # pass does. No dependency, and it can't hang.
            with _mapped_bytes(real_path) as data:
                # Group 2 = double-quoted body, group 3 = single-quoted.
                for m in _COMMAND_DEF.finditer(data):
                    name = m.group(1).decode("ascii")
                    # Skip non-command entries (CLI args, system tools, etc.)
                    if name.startswith("--") or name in ("command", "count", "duration", "definition"):
                        continue
                    # Keep first match for duplicates (real command defs
                    # appear before library defs). Checked before the decode
                    # work rather than after it.
                    if name in descriptions:
                        continue
                    raw = m.group(2) if m.group(2) is not None else m.group(3)
                    # Decode unicode escapes like &ndash;
                    desc = raw.decode("ascii").encode("utf-8").decode(
                        "unicode_escape", errors="replace"
                    )
                    # Truncate multi-line descriptions (skills with trigger rules)
                    if "\n" in desc:
                        desc = desc.split("\n")[0].rstrip()
                    descriptions[name] = desc
    except Exception:
        pass
    return descriptions


async def cli_command_descriptions() -> dict[str, str]:
    """Async accessor for `_cli_command_descriptions` — the only safe one.

    The scan reads and regexes the whole Claude CLI bundle: measured ~2.2s
    in-process, and it was being called straight from `async def` handlers,
    so every WS frame, turn heartbeat and unrelated request stalled behind
    it. (The `strings` subprocess it replaced was slower in wall-clock but
    released the GIL, so it never had this effect.) Same
    `asyncio.to_thread` shape as the `--version` probe in
    api_bridge_config.

    The `functools.lru_cache` underneath means only the first call pays;
    concurrent first calls can duplicate the work, which costs CPU but not
    correctness (the memo converges on one of the identical results).
    """
    return await asyncio.to_thread(_cli_command_descriptions)


def _get_command_descriptions(cwd: str) -> dict[str, str]:
    """Get descriptions for commands from CLI binary + .md frontmatter."""
    descriptions = dict(_cli_command_descriptions())
    # User command .md frontmatter descriptions override CLI defaults
    dirs = [
        Path.home() / ".claude" / "commands",
        Path(cwd) / ".claude" / "commands",
    ]
    for d in dirs:
        if d.is_dir():
            for f in d.iterdir():
                if f.is_file() and f.suffix == ".md":
                    try:
                        text = f.read_text(encoding="utf-8", errors="replace")
                        # Parse YAML frontmatter: --- ... description: ... ---
                        if text.startswith("---"):
                            end = text.find("---", 3)
                            if end != -1:
                                for line in text[3:end].splitlines():
                                    line = line.strip()
                                    if line.startswith("description:"):
                                        desc = line[len("description:"):].strip().strip('"').strip("'")
                                        if desc:
                                            descriptions[f.stem] = desc
                                        break
                    except Exception:
                        pass
    return descriptions


def _get_command_sources(cwd: str) -> dict[str, str]:
    """Resolve command names to source file paths.

    Search order (first match wins — project beats global, commands beat skills):
      1. {cwd}/.claude/commands/{name}.md
      2. ~/.claude/commands/{name}.md
      3. {cwd}/.claude/skills/{name}/SKILL.md
      4. ~/.claude/skills/{name}/SKILL.md
      5. ~/.claude/plugins/marketplaces/ * /plugins/ * /commands/{name}.md
      6. ~/.claude/plugins/marketplaces/ * /plugins/ * /skills/{name}/SKILL.md

    Returns a dict mapping command name (without leading /) to absolute file path.
    Commands whose source is baked into the CLI binary (e.g. /loop, /compact)
    or stored in browser localStorage (user custom commands) are not listed.
    """
    sources: dict[str, str] = {}
    cwd_path = Path(cwd)
    home = Path.home()

    def _add(name: str, path: Path):
        if name not in sources and path.is_file():
            sources[name] = str(path)

    # 1 & 2: command files
    for base in (cwd_path, home):
        cmd_dir = base / ".claude" / "commands"
        if cmd_dir.is_dir():
            for f in cmd_dir.iterdir():
                if f.is_file() and f.suffix == ".md":
                    _add(f.stem, f)

    # 3 & 4: skill files
    for base in (cwd_path, home):
        skill_root = base / ".claude" / "skills"
        if skill_root.is_dir():
            for skill_dir in skill_root.iterdir():
                if skill_dir.is_dir():
                    skill_file = skill_dir / "SKILL.md"
                    if skill_file.is_file():
                        _add(skill_dir.name, skill_file)

    # 5 & 6: plugin marketplace commands/skills
    plugins_root = home / ".claude" / "plugins" / "marketplaces"
    if plugins_root.is_dir():
        for marketplace in plugins_root.iterdir():
            plugins_dir = marketplace / "plugins"
            if not plugins_dir.is_dir():
                continue
            for plugin in plugins_dir.iterdir():
                # Plugin commands
                cmd_dir = plugin / "commands"
                if cmd_dir.is_dir():
                    for f in cmd_dir.iterdir():
                        if f.is_file() and f.suffix == ".md":
                            _add(f.stem, f)
                # Plugin skills
                skill_root = plugin / "skills"
                if skill_root.is_dir():
                    for skill_dir in skill_root.iterdir():
                        if skill_dir.is_dir():
                            skill_file = skill_dir / "SKILL.md"
                            if skill_file.is_file():
                                _add(skill_dir.name, skill_file)
    return sources


@router.get("/api/project/commands")
async def get_project_commands(cwd: str):
    """Get cached slash commands for a project (by CWD).

    Folder-form skills (resolving to `SKILL.md`) are filtered out — they
    are surfaced through the `~` skills picker instead, so `/` autocomplete
    only shows true slash commands.
    """
    resolved_cwd = str(safe_resolve(cwd))
    commands = SessionStore.get_project_commands(resolved_cwd)
    user_commands = _get_user_command_names(resolved_cwd)
    # Warm the binary scan off the event loop; the sync call below then
    # hits the memo instead of stalling the loop for ~2s.
    await cli_command_descriptions()
    descriptions = _get_command_descriptions(resolved_cwd)
    sources = _get_command_sources(resolved_cwd)
    # Drop names whose source is a folder-form skill — those go through `~`.
    filtered_commands = [
        name for name in commands
        if not sources.get(name, "").endswith("SKILL.md")
    ]
    return {
        "cwd": resolved_cwd,
        "commands": filtered_commands,
        "user_commands": user_commands,
        "descriptions": descriptions,
        "sources": sources,
    }
