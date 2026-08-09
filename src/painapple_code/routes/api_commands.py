"""Commands Manager API.

Endpoints for discovering, viewing, editing, and upgrading legacy `.md`
command files. Built-in Claude CLI commands are surfaced as read-only
entries for reference.

Sources:
  builtin:  Claude CLI binary (extracted via `strings`, ~77 names)
  project:  <cwd>/.claude/commands/<name>.md           (editable)
  personal: ~/.claude/commands/<name>.md               (editable)
  plugin:   ~/.claude/plugins/marketplaces/*/plugins/*/commands/<name>.md (read-only)

Folder-form skills (`skills/<name>/SKILL.md`) live in `routes/api_skills.py`.
"""
from __future__ import annotations

import os
import re
import shutil
from pathlib import Path
from typing import Any, Optional

import yaml
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from painapple_code.utils.file_paths import safe_resolve

router = APIRouter(prefix="/api/commands", tags=["commands"])

NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?(.*)\Z", re.DOTALL)


# ---------- helpers ---------------------------------------------------------


def _validate_name(name: str) -> None:
    if not NAME_RE.match(name):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid command name {name!r} — must match {NAME_RE.pattern}",
        )


def _safe_under(base: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(base.resolve())
        return True
    except (ValueError, OSError):
        return False


def _parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
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


def _serialize(frontmatter: dict[str, Any], body: str) -> str:
    if not frontmatter:
        return body
    clean = {k: v for k, v in frontmatter.items() if not k.startswith("_")}
    if not clean:
        return body
    yaml_text = yaml.safe_dump(
        clean, sort_keys=False, default_flow_style=False, allow_unicode=True
    ).rstrip()
    body_part = body if body.startswith("\n") else "\n" + body
    return f"---\n{yaml_text}\n---{body_part}"


def _body_preview(body: str, n: int = 280) -> str:
    body = body.strip()
    if len(body) <= n:
        return body
    return body[:n].rstrip() + "…"


def _iter_legacy_commands(cwd: str):
    """Yield legacy `.md` command files across project/personal/plugin scopes."""
    home = Path.home()
    cwd_path = Path(cwd)

    for scope, base in (("project", cwd_path), ("personal", home)):
        cmd_dir = base / ".claude" / "commands"
        if cmd_dir.is_dir():
            for f in cmd_dir.iterdir():
                if f.is_file() and f.suffix == ".md":
                    yield {
                        "scope": scope,
                        "name": f.stem,
                        "path": f,
                        "editable": True,
                        "plugin_label": None,
                    }

    plugins_root = home / ".claude" / "plugins" / "marketplaces"
    if plugins_root.is_dir():
        for marketplace in plugins_root.iterdir():
            plugins_dir = marketplace / "plugins"
            if not plugins_dir.is_dir():
                continue
            for plugin in plugins_dir.iterdir():
                cmd_dir = plugin / "commands"
                if cmd_dir.is_dir():
                    for f in cmd_dir.iterdir():
                        if f.is_file() and f.suffix == ".md":
                            yield {
                                "scope": "plugin",
                                "name": f.stem,
                                "path": f,
                                "editable": False,
                                "plugin_label": f"{plugin.name} ({marketplace.name})",
                            }


def _resolve_path(scope: str, name: str, cwd: str, allow_plugin: bool = False) -> dict[str, Any]:
    """Locate a legacy `.md` command on disk."""
    _validate_name(name)
    if scope == "plugin":
        if not allow_plugin:
            raise HTTPException(status_code=405, detail="Plugin commands are read-only")
        for rec in _iter_legacy_commands(cwd):
            if rec["scope"] == "plugin" and rec["name"] == name:
                return rec
        raise HTTPException(status_code=404, detail=f"Plugin command {name!r} not found")

    if scope not in ("project", "personal"):
        raise HTTPException(status_code=400, detail=f"Unknown scope {scope!r}")

    base = (Path(cwd) if scope == "project" else Path.home()) / ".claude"
    cmd_file = base / "commands" / f"{name}.md"
    if cmd_file.is_file() and _safe_under(base, cmd_file):
        return {
            "scope": scope,
            "name": name,
            "path": cmd_file,
            "editable": True,
            "plugin_label": None,
        }
    raise HTTPException(status_code=404, detail=f"Command {name!r} not found in {scope}")


# ---------- endpoints -------------------------------------------------------


@router.get("")
async def list_commands(cwd: str):
    """List built-in CLI commands and legacy `.md` files."""
    # Lazy import to avoid load-order issues
    from painapple_code.routes.api_project_config import _cli_command_descriptions, _get_command_descriptions

    resolved_cwd = str(safe_resolve(cwd))
    descriptions = _get_command_descriptions(resolved_cwd)
    commands: list[dict[str, Any]] = []
    counts = {"builtin": 0, "project": 0, "personal": 0, "plugin": 0}

    # Built-in CLI commands (read-only — extracted from binary)
    for name, desc in sorted(_cli_command_descriptions().items()):
        commands.append({
            "id": f"builtin:{name}",
            "name": name,
            "scope": "builtin",
            "scope_label": "Built-in",
            "kind": "builtin",
            "path": None,
            "description": desc,
            "editable": False,
            "frontmatter": {},
            "body_preview": "",
            "body_length": 0,
        })
        counts["builtin"] += 1

    # Legacy `.md` files
    for rec in _iter_legacy_commands(resolved_cwd):
        try:
            text = rec["path"].read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        fm, body = _parse_frontmatter(text)
        desc = (
            fm.get("description")
            or descriptions.get(rec["name"])
            or _body_preview(body, 80)
        )
        commands.append({
            "id": f"{rec['scope']}:{rec['name']}",
            "name": rec["name"],
            "scope": rec["scope"],
            "scope_label": rec["plugin_label"] or rec["scope"].capitalize(),
            "kind": "file",
            "path": str(rec["path"]),
            "description": desc,
            "editable": rec["editable"],
            "frontmatter": fm,
            "body_preview": _body_preview(body),
            "body_length": len(body),
        })
        counts[rec["scope"]] += 1

    return {
        "cwd": resolved_cwd,
        "commands": commands,
        "counts": counts,
        "total": len(commands),
    }


@router.get("/{scope}/{name}")
async def get_command(scope: str, name: str, cwd: str):
    """Return full command metadata + body. Builtins return description only."""
    if scope == "builtin":
        from painapple_code.routes.api_project_config import _cli_command_descriptions
        cli_descriptions = _cli_command_descriptions()
        if name not in cli_descriptions:
            raise HTTPException(status_code=404, detail=f"Built-in command {name!r} not found")
        return {
            "id": f"builtin:{name}",
            "name": name,
            "scope": "builtin",
            "scope_label": "Built-in",
            "kind": "builtin",
            "path": None,
            "description": cli_descriptions[name],
            "editable": False,
            "frontmatter": {},
            "body": "",
            "raw": "",
            "mtime": 0,
        }

    resolved_cwd = str(safe_resolve(cwd))
    rec = _resolve_path(scope, name, resolved_cwd, allow_plugin=True)
    text = rec["path"].read_text(encoding="utf-8", errors="replace")
    fm, body = _parse_frontmatter(text)
    return {
        "id": f"{scope}:{name}",
        "name": name,
        "scope": scope,
        "scope_label": rec["plugin_label"] or scope.capitalize(),
        "kind": "file",
        "path": str(rec["path"]),
        "editable": rec["editable"],
        "frontmatter": fm,
        "body": body,
        "raw": text,
        "description": fm.get("description") or "",
        "mtime": rec["path"].stat().st_mtime,
    }


class UpdateCommandBody(BaseModel):
    frontmatter: Optional[dict[str, Any]] = None
    body: Optional[str] = None
    raw: Optional[str] = None
    expected_mtime: Optional[float] = None


@router.put("/{scope}/{name}")
async def update_command(scope: str, name: str, cwd: str, payload: UpdateCommandBody):
    """Update a legacy `.md` command file (project or personal scope only)."""
    if scope == "builtin":
        raise HTTPException(status_code=405, detail="Built-in commands are not editable")
    resolved_cwd = str(safe_resolve(cwd))
    rec = _resolve_path(scope, name, resolved_cwd, allow_plugin=False)
    path: Path = rec["path"]

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
        existing = path.read_text(encoding="utf-8", errors="replace")
        ex_fm, ex_body = _parse_frontmatter(existing)
        fm = payload.frontmatter if payload.frontmatter is not None else ex_fm
        body = payload.body if payload.body is not None else ex_body
        new_text = _serialize(fm, body)
    else:
        raise HTTPException(status_code=400, detail="No content provided")

    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
    tmp.write_text(new_text, encoding="utf-8", newline="")
    os.replace(tmp, path)

    return {
        "ok": True,
        "path": str(path),
        "mtime": path.stat().st_mtime,
        "bytes": len(new_text.encode("utf-8")),
    }


@router.delete("/{scope}/{name}")
async def delete_command(scope: str, name: str, cwd: str):
    """Delete a legacy `.md` command file."""
    if scope == "builtin":
        raise HTTPException(status_code=405, detail="Built-in commands cannot be deleted")
    resolved_cwd = str(safe_resolve(cwd))
    rec = _resolve_path(scope, name, resolved_cwd, allow_plugin=False)
    path: Path = rec["path"]

    parts = path.resolve().parts
    if ".claude" not in parts:
        raise HTTPException(status_code=400, detail="Refusing to delete outside .claude/")

    try:
        path.unlink()
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "removed": str(path), "kind": "file"}


@router.post("/{scope}/{name}/upgrade")
async def upgrade_to_skill(scope: str, name: str, cwd: str):
    """Convert a legacy `commands/<name>.md` to `skills/<name>/SKILL.md` folder.

    The original flat file is removed after the new directory is in place.
    """
    if scope == "builtin":
        raise HTTPException(status_code=405, detail="Built-in commands cannot be upgraded")
    resolved_cwd = str(safe_resolve(cwd))
    rec = _resolve_path(scope, name, resolved_cwd, allow_plugin=False)
    src_file: Path = rec["path"]

    scope_base = Path(resolved_cwd) / ".claude" if scope == "project" else Path.home() / ".claude"
    target_dir = scope_base / "skills" / name
    if target_dir.exists():
        raise HTTPException(status_code=409, detail=f"Skill folder already exists: {target_dir}")

    text = src_file.read_text(encoding="utf-8", errors="replace")
    fm, body = _parse_frontmatter(text)
    fm = dict(fm or {})
    fm = {k: v for k, v in fm.items() if not k.startswith("_")}
    fm.setdefault("name", name)

    target_dir.mkdir(parents=True, exist_ok=False)
    (target_dir / "SKILL.md").write_text(_serialize(fm, body), encoding="utf-8", newline="")

    try:
        src_file.unlink()
    except OSError as e:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Could not remove legacy file: {e}")

    return {
        "ok": True,
        "id": f"skill:{scope}:{name}",
        "scope": scope,
        "name": name,
        "path": str(target_dir / "SKILL.md"),
        "dir": str(target_dir),
        "removed_legacy": str(src_file),
    }
