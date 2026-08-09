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

import functools
import json
from pathlib import Path

from fastapi import APIRouter, Request
from pydantic import BaseModel

from painapple_code import bridge_paths
from painapple_code.session_store import SessionStore

router = APIRouter(tags=["bridge:project-config"])


# ═══════════════════════════════════════════════════════════════════
# Project Config API
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/project/config")
async def get_project_config(cwd: str):
    """Get project-specific configuration (merged with global)."""
    resolved_cwd = str(Path(cwd).expanduser().resolve())
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
    resolved_cwd = str(Path(cwd).expanduser().resolve())
    body = await request.json()

    bridge_paths.save_project_config(resolved_cwd, body)

    return await get_project_config(cwd)


@router.patch("/api/project/config")
async def patch_project_config(cwd: str, request: Request):
    """Partially update project configuration (merge with existing)."""
    resolved_cwd = str(Path(cwd).expanduser().resolve())
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
    resolved_cwd = str(Path(cwd).expanduser().resolve())
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
    resolved_cwd = str(Path(cwd).expanduser().resolve())
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


@functools.lru_cache(maxsize=1)
def _cli_command_descriptions() -> dict[str, str]:
    """Extract slash command descriptions from the Claude CLI binary.

    Parses `name:"xxx",description:"yyy"` and `name:"xxx",description:'yyy'` patterns
    from the embedded JS. Some skills use single-quoted descriptions because their
    text contains double quotes (e.g. update-config's description references
    "from now on when X" in quotes).

    Lazily computed on first use and cached for the server's lifetime —
    running `strings` over the ~100MB CLI bundle takes ~1s, which must not
    happen at import time (it made every `painapple` CLI invocation slow).
    """
    import re
    import shutil
    import subprocess
    descriptions = {}
    # Match either "..." (no embedded doubles) or '...' (no embedded singles).
    # Group 2 = double-quoted body, group 3 = single-quoted body.
    pattern = re.compile(
        r'name:"([a-z][a-z0-9-]*)",description:(?:"([^"]+)"|\'([^\']+)\')'
    )
    try:
        claude_bin = shutil.which("claude")
        if claude_bin:
            real_path = Path(claude_bin).resolve()
            result = subprocess.run(
                ["strings", str(real_path)],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10,
            )
            if result.returncode == 0:
                for m in pattern.finditer(result.stdout):
                    name = m.group(1)
                    desc = m.group(2) if m.group(2) is not None else m.group(3)
                    # Skip non-command entries (CLI args, system tools, etc.)
                    if name.startswith("--") or name in ("command", "count", "duration", "definition"):
                        continue
                    # Decode unicode escapes like –
                    desc = desc.encode("utf-8").decode("unicode_escape", errors="replace")
                    # Truncate multi-line descriptions (skills with trigger rules)
                    if "\n" in desc:
                        desc = desc.split("\n")[0].rstrip()
                    # Keep first match for duplicates (real command defs appear before library defs)
                    if name not in descriptions:
                        descriptions[name] = desc
    except Exception:
        pass
    return descriptions


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
    resolved_cwd = str(Path(cwd).expanduser().resolve())
    commands = SessionStore.get_project_commands(resolved_cwd)
    user_commands = _get_user_command_names(resolved_cwd)
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
