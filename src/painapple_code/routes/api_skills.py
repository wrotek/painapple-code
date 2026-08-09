"""Skills Manager API.

Endpoints for discovering, viewing, and editing Claude Code skills.

Skill locations (priority order — higher wins on name collisions):
  personal:  ~/.claude/skills/<name>/SKILL.md           (editable)
  project:   <cwd>/.claude/skills/<name>/SKILL.md       (editable)
  plugin:    ~/.claude/plugins/marketplaces/*/plugins/*/skills/<name>/SKILL.md  (read-only)

This API only returns folder-form skills (`SKILL.md` inside a directory).
Legacy flat-file commands (`commands/<name>.md`) are managed by `routes/api_commands.py`,
which also hosts the upgrade-to-skill action.

See docs-ai/plans/2026-04-20-skills-manager-widget.md for the full design.
"""
from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path
from typing import Any, Optional

import yaml
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from painapple_code.utils.file_paths import safe_resolve

router = APIRouter(prefix="/api/skills", tags=["skills"])

NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?(.*)\Z", re.DOTALL)


# ---------- helpers ---------------------------------------------------------


def _validate_name(name: str) -> None:
    if not NAME_RE.match(name):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid skill name {name!r} — must match {NAME_RE.pattern}",
        )


def _scope_roots(cwd: str) -> dict[str, Path]:
    """Return the editable-scope roots (project + personal)."""
    return {
        "project": Path(cwd) / ".claude",
        "personal": Path.home() / ".claude",
    }


def _safe_under(base: Path, candidate: Path) -> bool:
    """True iff candidate is inside base (after resolution), preventing traversal."""
    try:
        candidate.resolve().relative_to(base.resolve())
        return True
    except (ValueError, OSError):
        return False


def _parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Split SKILL.md contents into (frontmatter dict, body string).

    Returns ({}, text) if no frontmatter block is present.
    On YAML parse error, returns ({"_parse_error": str}, text).
    """
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    try:
        data = yaml.safe_load(m.group(1)) or {}
        if not isinstance(data, dict):
            data = {"_parse_error": "frontmatter is not a mapping"}
        return data, m.group(2)
    except yaml.YAMLError as e:
        return {"_parse_error": str(e)}, m.group(2)


def _serialize_skill(frontmatter: dict[str, Any], body: str) -> str:
    """Rebuild a SKILL.md-formatted string from parsed parts."""
    if not frontmatter:
        return body
    # Strip internal parse-error marker if present
    clean = {k: v for k, v in frontmatter.items() if not k.startswith("_")}
    yaml_text = yaml.safe_dump(
        clean, sort_keys=False, default_flow_style=False, allow_unicode=True
    ).rstrip()
    body_part = body if body.startswith("\n") else "\n" + body
    return f"---\n{yaml_text}\n---{body_part}"


def _invocation_mode(fm: dict[str, Any]) -> str:
    """Derive user-facing invocation mode from frontmatter flags."""
    disable_model = bool(fm.get("disable-model-invocation"))
    user = fm.get("user-invocable")
    user_ok = True if user is None else bool(user)
    if disable_model and user_ok:
        return "manual-only"
    if (not disable_model) and (not user_ok):
        return "auto-only"
    if (not disable_model) and user_ok:
        return "auto-and-manual"
    return "none"  # both disabled — unusual


def _list_supporting(skill_dir: Path) -> list[dict[str, Any]]:
    """List sibling files in a skill directory (excluding SKILL.md, dotfiles)."""
    out: list[dict[str, Any]] = []
    if not skill_dir.is_dir():
        return out
    for entry in sorted(skill_dir.rglob("*")):
        if entry.name == "SKILL.md" or entry.name.startswith("."):
            continue
        # Skip entries under any dotdir (e.g. .git inside a skill dir)
        rel = entry.relative_to(skill_dir)
        if any(part.startswith(".") for part in rel.parts[:-1]):
            continue
        if entry.is_file():
            try:
                size = entry.stat().st_size
            except OSError:
                size = 0
            out.append({"path": rel.as_posix(), "size": size})
    return out


def _body_preview(body: str, n: int = 280) -> str:
    body = body.strip()
    if len(body) <= n:
        return body
    return body[:n].rstrip() + "…"


# ---------- scope discovery -------------------------------------------------


def _load_installed_plugin_keys() -> set[str]:
    """Return `{plugin@marketplace}` keys from `~/.claude/plugins/installed_plugins.json`.

    Claude Code's plugin manager walks every marketplace it knows about and
    caches the *entire* catalog under `~/.claude/plugins/marketplaces/`, but only
    a subset is actually installed. `installed_plugins.json` is the authoritative
    list — its top-level `plugins` map is keyed by `<plugin>@<marketplace>`.
    Returns an empty set if the file is missing or malformed (treat as "nothing
    installed" rather than "show everything", to match user expectation that the
    picker reflects their /plugin install state).
    """
    path = Path.home() / ".claude" / "plugins" / "installed_plugins.json"
    try:
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return set()
    plugins = data.get("plugins")
    if not isinstance(plugins, dict):
        return set()
    return set(plugins.keys())


def _iter_skills(cwd: str):
    """Yield folder-form skill descriptors (SKILL.md inside a directory).

    Order: project skills + personal skills + plugin skills.
    Legacy flat `commands/<name>.md` files are NOT included — they live in
    `routes/api_commands.py`.
    """
    home = Path.home()
    cwd_path = Path(cwd)

    # Editable: skill dirs under project + personal .claude/skills/
    for scope, base in (("project", cwd_path), ("personal", home)):
        skill_root = base / ".claude" / "skills"
        if skill_root.is_dir():
            for entry in skill_root.iterdir():
                if entry.is_dir() and (entry / "SKILL.md").is_file():
                    yield {
                        "scope": scope,
                        "name": entry.name,
                        "path": entry / "SKILL.md",
                        "dir": entry,
                        "editable": True,
                        "plugin_label": None,
                    }

    # Read-only: plugin marketplace skills — filtered by installed_plugins.json
    plugins_root = home / ".claude" / "plugins" / "marketplaces"
    if plugins_root.is_dir():
        installed = _load_installed_plugin_keys()
        for marketplace in plugins_root.iterdir():
            plugins_dir = marketplace / "plugins"
            if not plugins_dir.is_dir():
                continue
            for plugin in plugins_dir.iterdir():
                if f"{plugin.name}@{marketplace.name}" not in installed:
                    continue
                label = f"{plugin.name} ({marketplace.name})"
                skill_root = plugin / "skills"
                if skill_root.is_dir():
                    for entry in skill_root.iterdir():
                        if entry.is_dir() and (entry / "SKILL.md").is_file():
                            yield {
                                "scope": "plugin",
                                "name": entry.name,
                                "path": entry / "SKILL.md",
                                "dir": entry,
                                "editable": False,
                                "plugin_label": label,
                            }


def _resolve_path(scope: str, name: str, cwd: str, allow_plugin: bool = False) -> dict[str, Any]:
    """Locate a folder-form skill on disk. Plugin scope is read-only."""
    _validate_name(name)
    if scope == "plugin":
        if not allow_plugin:
            raise HTTPException(status_code=405, detail="Plugin skills are read-only")
        for rec in _iter_skills(cwd):
            if rec["scope"] == "plugin" and rec["name"] == name:
                return rec
        raise HTTPException(status_code=404, detail=f"Plugin skill {name!r} not found")

    if scope not in ("project", "personal"):
        raise HTTPException(status_code=400, detail=f"Unknown scope {scope!r}")

    roots = _scope_roots(cwd)
    base = roots[scope]
    skill_dir = base / "skills" / name
    skill_file = skill_dir / "SKILL.md"

    if skill_file.is_file() and _safe_under(base, skill_file):
        return {
            "scope": scope,
            "name": name,
            "path": skill_file,
            "dir": skill_dir,
            "editable": True,
            "plugin_label": None,
        }
    raise HTTPException(status_code=404, detail=f"Skill {name!r} not found in {scope}")


# ---------- endpoints -------------------------------------------------------


@router.get("")
async def list_skills(cwd: str):
    """List every skill across scopes. Returns rich metadata for the gallery."""
    resolved_cwd = str(safe_resolve(cwd))
    skills = []
    # Track name-per-scope for conflict detection
    by_name: dict[str, list[tuple[str, str]]] = {}
    counts = {"project": 0, "personal": 0, "plugin": 0}

    for rec in _iter_skills(resolved_cwd):
        try:
            text = rec["path"].read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        fm, body = _parse_frontmatter(text)
        item = {
            "id": f"{rec['scope']}:{rec['name']}",
            "name": rec["name"],
            "scope": rec["scope"],
            "scope_label": rec["plugin_label"] or rec["scope"].capitalize(),
            "path": str(rec["path"]),
            "dir": str(rec["dir"]),
            "editable": rec["editable"],
            "frontmatter": fm,
            "description": fm.get("description") or "",
            "body_preview": _body_preview(body),
            "body_length": len(body),
            "supporting_files": _list_supporting(rec["dir"]),
            "invocation_mode": _invocation_mode(fm),
        }
        skills.append(item)
        counts[rec["scope"]] += 1
        by_name.setdefault(rec["name"], []).append((rec["scope"], item["id"]))

    # Mark conflicts: same name in multiple scopes → note shadowing
    priority = {"personal": 0, "project": 1, "plugin": 2}
    for item in skills:
        peers = by_name.get(item["name"], [])
        if len(peers) <= 1:
            continue
        # Sort by priority; lower number wins
        winner = min(peers, key=lambda p: priority.get(p[0], 99))
        if item["id"] != winner[1]:
            item["shadowed_by"] = winner[1]

    return {
        "cwd": resolved_cwd,
        "skills": skills,
        "counts": counts,
        "total": len(skills),
    }


@router.get("/{scope}/{name}")
async def get_skill(scope: str, name: str, cwd: str):
    """Return full skill metadata + body for viewing or editing."""
    resolved_cwd = str(safe_resolve(cwd))
    rec = _resolve_path(scope, name, resolved_cwd, allow_plugin=True)
    text = rec["path"].read_text(encoding="utf-8", errors="replace")
    fm, body = _parse_frontmatter(text)
    return {
        "id": f"{scope}:{name}",
        "name": name,
        "scope": scope,
        "scope_label": rec["plugin_label"] or scope.capitalize(),
        "path": str(rec["path"]),
        "dir": str(rec["dir"]),
        "editable": rec["editable"],
        "frontmatter": fm,
        "body": body,
        "raw": text,
        "supporting_files": _list_supporting(rec["dir"]),
        "invocation_mode": _invocation_mode(fm),
        "mtime": rec["path"].stat().st_mtime,
    }


class UpdateSkillBody(BaseModel):
    frontmatter: Optional[dict[str, Any]] = None
    body: Optional[str] = None
    raw: Optional[str] = None  # full file contents — takes precedence if set
    expected_mtime: Optional[float] = None  # optimistic concurrency check


@router.put("/{scope}/{name}")
async def update_skill(scope: str, name: str, cwd: str, payload: UpdateSkillBody):
    """Update an existing skill's SKILL.md.

    Supply either `raw` (wins) or `frontmatter`+`body`. Plugin scope rejected.
    """
    resolved_cwd = str(safe_resolve(cwd))
    rec = _resolve_path(scope, name, resolved_cwd, allow_plugin=False)
    path: Path = rec["path"]

    # Optimistic concurrency — refuse if file changed under us
    if payload.expected_mtime is not None:
        try:
            current = path.stat().st_mtime
            if abs(current - payload.expected_mtime) > 0.5:
                raise HTTPException(
                    status_code=409,
                    detail="File changed on disk since you started editing",
                )
        except OSError:
            pass

    if payload.raw is not None:
        new_text = payload.raw
    elif payload.frontmatter is not None or payload.body is not None:
        # Read existing parts to fill in whichever side was omitted
        existing = path.read_text(encoding="utf-8", errors="replace")
        ex_fm, ex_body = _parse_frontmatter(existing)
        fm = payload.frontmatter if payload.frontmatter is not None else ex_fm
        body = payload.body if payload.body is not None else ex_body
        new_text = _serialize_skill(fm, body)
    else:
        raise HTTPException(status_code=400, detail="No content provided")

    # Atomic write
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
    tmp.write_text(new_text, encoding="utf-8", newline="")
    os.replace(tmp, path)

    return {
        "ok": True,
        "path": str(path),
        "mtime": path.stat().st_mtime,
        "bytes": len(new_text.encode("utf-8")),
    }


# ---------- v2: create, delete, duplicate, upgrade --------------------------


TEMPLATES: dict[str, dict[str, Any]] = {
    "blank": {
        "frontmatter": {},
        "body": "\nWrite your skill's instructions here. Claude reads this text when the skill is invoked.\n",
    },
    "task": {
        "frontmatter": {
            "disable-model-invocation": True,
            "argument-hint": "[arg]",
        },
        "body": (
            "\n"
            "Describe the task that runs when the user invokes this skill.\n\n"
            "1. Step one\n"
            "2. Step two\n"
            "3. Step three\n"
        ),
    },
    "reference": {
        "frontmatter": {},
        "body": (
            "\n"
            "Reference content Claude applies while relevant (conventions, style guides,\n"
            "domain knowledge). Write it as standing instructions, not one-time steps.\n"
        ),
    },
    "fork": {
        "frontmatter": {"context": "fork", "agent": "Explore"},
        "body": (
            "\n"
            "Task for an isolated subagent. The skill content becomes the agent's prompt —\n"
            "it won't see your conversation history.\n\n"
            "Investigate $ARGUMENTS and return findings with file + line references.\n"
        ),
    },
    "visual": {
        "frontmatter": {
            "allowed-tools": "Bash(python *)",
        },
        "body": (
            "\n"
            "Skill that runs a bundled script to produce visual output.\n\n"
            "Run the script:\n\n"
            "```bash\n"
            "python ${CLAUDE_SKILL_DIR}/scripts/run.py\n"
            "```\n"
        ),
    },
}


def _scope_skill_dir(scope: str, name: str, cwd: str) -> Path:
    """Return the target directory for a new skill (project or personal)."""
    if scope == "project":
        return Path(cwd) / ".claude" / "skills" / name
    if scope == "personal":
        return Path.home() / ".claude" / "skills" / name
    raise HTTPException(status_code=400, detail=f"Cannot write to scope {scope!r}")


def _write_skill_dir(target_dir: Path, frontmatter: dict[str, Any], body: str) -> Path:
    """Create `target_dir/SKILL.md` with serialized contents. Fails if exists."""
    if target_dir.exists():
        raise HTTPException(
            status_code=409,
            detail=f"Path already exists: {target_dir}",
        )
    target_dir.mkdir(parents=True, exist_ok=False)
    skill_path = target_dir / "SKILL.md"
    text = _serialize_skill(frontmatter, body)
    # Atomic write
    tmp = skill_path.with_suffix(skill_path.suffix + f".tmp.{os.getpid()}")
    tmp.write_text(text, encoding="utf-8", newline="")
    os.replace(tmp, skill_path)
    return skill_path


def _next_duplicate_name(existing_names: set[str], base: str) -> str:
    """Pick a name like `duplicate-of-<base>[-N]` avoiding collisions."""
    candidate = f"duplicate-of-{base}"[:64]
    if candidate not in existing_names:
        return candidate
    for i in range(2, 100):
        cand = f"{candidate}-{i}"[:64]
        if cand not in existing_names:
            return cand
    raise HTTPException(status_code=409, detail="Too many duplicates")


def _all_names_in_scope(scope: str, cwd: str) -> set[str]:
    """Collect all skill/command names already present in the given scope."""
    names: set[str] = set()
    if scope == "project":
        base = Path(cwd) / ".claude"
    elif scope == "personal":
        base = Path.home() / ".claude"
    else:
        return names
    for sub in (base / "skills", base / "commands"):
        if sub.is_dir():
            for entry in sub.iterdir():
                if entry.is_dir() and (entry / "SKILL.md").is_file():
                    names.add(entry.name)
                elif entry.is_file() and entry.suffix == ".md":
                    names.add(entry.stem)
    return names


class CreateSkillBody(BaseModel):
    description: Optional[str] = ""
    template: Optional[str] = "blank"
    frontmatter: Optional[dict[str, Any]] = None
    body: Optional[str] = None


@router.post("/{scope}/{name}")
async def create_skill(scope: str, name: str, cwd: str, payload: CreateSkillBody):
    """Create a new skill directory with SKILL.md from a template."""
    _validate_name(name)
    resolved_cwd = str(safe_resolve(cwd))
    target_dir = _scope_skill_dir(scope, name, resolved_cwd)

    existing = _all_names_in_scope(scope, resolved_cwd)
    if name in existing:
        raise HTTPException(status_code=409, detail=f"Skill {name!r} already exists in {scope}")

    template_key = payload.template or "blank"
    template = TEMPLATES.get(template_key, TEMPLATES["blank"])
    fm: dict[str, Any] = {"name": name}
    if payload.description:
        fm["description"] = payload.description
    # Merge template frontmatter (template keys win over just name+description)
    fm.update(template.get("frontmatter") or {})
    # If caller supplied explicit frontmatter, merge on top (caller wins)
    if payload.frontmatter:
        fm.update(payload.frontmatter)
    body = payload.body if payload.body is not None else (template.get("body") or "")

    skill_path = _write_skill_dir(target_dir, fm, body)

    return {
        "ok": True,
        "id": f"{scope}:{name}",
        "scope": scope,
        "name": name,
        "path": str(skill_path),
        "dir": str(target_dir),
        "mtime": skill_path.stat().st_mtime,
    }


@router.delete("/{scope}/{name}")
async def delete_skill(scope: str, name: str, cwd: str):
    """Delete a skill directory (rmtree)."""
    resolved_cwd = str(safe_resolve(cwd))
    rec = _resolve_path(scope, name, resolved_cwd, allow_plugin=False)
    path: Path = rec["path"]

    parts = path.resolve().parts
    if ".claude" not in parts:
        raise HTTPException(status_code=400, detail="Refusing to delete outside .claude/")

    skill_dir: Path = rec["dir"]
    if skill_dir.parent.name != "skills":
        raise HTTPException(status_code=400, detail="Unexpected skill dir layout")
    try:
        shutil.rmtree(skill_dir)
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "removed": str(skill_dir), "kind": "dir"}


class DuplicateBody(BaseModel):
    target_scope: Optional[str] = None  # "project" | "personal"; defaults to source scope
    target_name: Optional[str] = None   # if omitted, auto "duplicate-of-<name>"


@router.post("/{scope}/{name}/duplicate")
async def duplicate_skill(scope: str, name: str, cwd: str, payload: DuplicateBody):
    """Copy a skill into a new name/scope. Description is prefixed "Duplicate of …"."""
    resolved_cwd = str(safe_resolve(cwd))
    src = _resolve_path(scope, name, resolved_cwd, allow_plugin=True)

    target_scope = payload.target_scope or (scope if scope != "plugin" else "personal")
    if target_scope not in ("project", "personal"):
        raise HTTPException(status_code=400, detail=f"Cannot duplicate to scope {target_scope!r}")

    existing = _all_names_in_scope(target_scope, resolved_cwd)
    new_name = payload.target_name or _next_duplicate_name(existing, name)
    _validate_name(new_name)
    if new_name in existing:
        raise HTTPException(status_code=409, detail=f"Skill {new_name!r} already exists in {target_scope}")

    target_dir = _scope_skill_dir(target_scope, new_name, resolved_cwd)

    # Copy the directory tree if source has supporting files; else just write SKILL.md
    src_text = src["path"].read_text(encoding="utf-8", errors="replace")
    fm, body = _parse_frontmatter(src_text)

    # Prefix description and rename the `name` field
    fm = dict(fm or {})
    # Strip internal parse-error markers that aren't real frontmatter fields
    fm = {k: v for k, v in fm.items() if not k.startswith("_")}
    fm["name"] = new_name
    original_desc = fm.get("description") or ""
    if original_desc:
        fm["description"] = f"Duplicate of {name}: {original_desc}"
    else:
        fm["description"] = f"Duplicate of {name}"

    if target_dir.exists():
        raise HTTPException(status_code=409, detail=f"Path already exists: {target_dir}")

    # Copy the whole source dir, then rewrite SKILL.md with patched frontmatter
    try:
        shutil.copytree(src["dir"], target_dir)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Copy failed: {e}")
    new_skill = target_dir / "SKILL.md"
    new_skill.write_text(_serialize_skill(fm, body), encoding="utf-8", newline="")

    return {
        "ok": True,
        "id": f"{target_scope}:{new_name}",
        "scope": target_scope,
        "name": new_name,
        "path": str(target_dir / "SKILL.md"),
        "dir": str(target_dir),
    }
