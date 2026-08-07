"""Agents Manager API.

Endpoints for discovering, viewing, creating, editing, and deleting Claude Code
agent definitions.

Agent locations (priority order — higher wins on name collisions):
  personal:  ~/.claude/agents/<name>.md
  project:   <cwd>/.claude/agents/<name>.md       (overrides personal)

Agents are flat `.md` files (one per agent), not folder-form like skills.
Frontmatter keys: `name`, `description`, optionally `tools`, `model`.

Mirrors `routes/api_skills.py` in shape so the frontend agents widget can be
a near-clone of the skills widget.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Optional

import yaml
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/agents", tags=["agents"])

NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?(.*)\Z", re.DOTALL)


# ---------- helpers ---------------------------------------------------------


def _validate_name(name: str) -> None:
    if not NAME_RE.match(name):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid agent name {name!r} — must match {NAME_RE.pattern}",
        )


def _scope_root(scope: str, cwd: str) -> Path:
    """Return the agents directory for a given scope."""
    if scope == "project":
        return Path(cwd) / ".claude" / "agents"
    if scope == "personal":
        return Path.home() / ".claude" / "agents"
    raise HTTPException(status_code=400, detail=f"Unknown scope {scope!r}")


def _safe_under(base: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(base.resolve())
        return True
    except (ValueError, OSError):
        return False


def _parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Split agent .md contents into (frontmatter dict, body string)."""
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


def _serialize_agent(frontmatter: dict[str, Any], body: str) -> str:
    """Rebuild an agent .md-formatted string from parsed parts."""
    if not frontmatter:
        return body
    clean = {k: v for k, v in frontmatter.items() if not k.startswith("_")}
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


def _iter_agents(cwd: str):
    """Yield agent file descriptors across personal + project scopes."""
    home = Path.home()
    cwd_path = Path(cwd)

    for scope, base in (("project", cwd_path), ("personal", home)):
        agents_root = base / ".claude" / "agents"
        if not agents_root.is_dir():
            continue
        for entry in sorted(agents_root.glob("*.md")):
            if not entry.is_file():
                continue
            yield {
                "scope": scope,
                "name": entry.stem,
                "path": entry,
            }


def _resolve_path(scope: str, name: str, cwd: str) -> Path:
    """Locate an agent .md file on disk."""
    _validate_name(name)
    if scope not in ("project", "personal"):
        raise HTTPException(status_code=400, detail=f"Unknown scope {scope!r}")
    base = _scope_root(scope, cwd)
    agent_file = base / f"{name}.md"
    if agent_file.is_file() and _safe_under(base, agent_file):
        return agent_file
    raise HTTPException(status_code=404, detail=f"Agent {name!r} not found in {scope}")


def _all_names_in_scope(scope: str, cwd: str) -> set[str]:
    base = _scope_root(scope, cwd)
    if not base.is_dir():
        return set()
    return {entry.stem for entry in base.glob("*.md") if entry.is_file()}


# ---------- endpoints -------------------------------------------------------


@router.get("")
async def list_agents(cwd: Optional[str] = None):
    """List every agent across scopes, with rich metadata for the gallery."""
    resolved_cwd = str(Path(cwd).expanduser().resolve()) if cwd else str(Path.cwd())
    agents = []
    by_name: dict[str, list[tuple[str, str]]] = {}
    counts = {"project": 0, "personal": 0}

    for rec in _iter_agents(resolved_cwd):
        try:
            text = rec["path"].read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        fm, body = _parse_frontmatter(text)
        agent_id = f"{rec['scope']}:{rec['name']}"
        item = {
            "id": agent_id,
            "name": rec["name"],
            "scope": rec["scope"],
            "scope_label": rec["scope"].capitalize(),
            "path": str(rec["path"]),
            "editable": True,
            "frontmatter": fm,
            "description": fm.get("description") or "",
            "body_preview": _body_preview(body),
            "body_length": len(body),
            # Back-compat: snippets-autocomplete consumer also reads
            # `file` and `source` (we map source <- scope, with personal=='global').
            "file": rec["path"].name,
            "source": "global" if rec["scope"] == "personal" else "project",
        }
        agents.append(item)
        counts[rec["scope"]] += 1
        by_name.setdefault(rec["name"], []).append((rec["scope"], agent_id))

    # Mark conflicts: project shadows personal
    priority = {"personal": 0, "project": 1}
    for item in agents:
        peers = by_name.get(item["name"], [])
        if len(peers) <= 1:
            continue
        winner = max(peers, key=lambda p: priority.get(p[0], -1))
        if item["id"] != winner[1]:
            item["shadowed_by"] = winner[1]

    return {
        "cwd": resolved_cwd,
        "agents": agents,
        "counts": counts,
        "total": len(agents),
    }


@router.get("/{scope}/{name}")
async def get_agent(scope: str, name: str, cwd: str):
    """Return full agent metadata + body for viewing or editing."""
    resolved_cwd = str(Path(cwd).expanduser().resolve())
    path = _resolve_path(scope, name, resolved_cwd)
    text = path.read_text(encoding="utf-8", errors="replace")
    fm, body = _parse_frontmatter(text)
    return {
        "id": f"{scope}:{name}",
        "name": name,
        "scope": scope,
        "scope_label": scope.capitalize(),
        "path": str(path),
        "editable": True,
        "frontmatter": fm,
        "body": body,
        "raw": text,
        "mtime": path.stat().st_mtime,
    }


class UpdateAgentBody(BaseModel):
    frontmatter: Optional[dict[str, Any]] = None
    body: Optional[str] = None
    raw: Optional[str] = None
    expected_mtime: Optional[float] = None


@router.put("/{scope}/{name}")
async def update_agent(scope: str, name: str, cwd: str, payload: UpdateAgentBody):
    """Update an existing agent file."""
    resolved_cwd = str(Path(cwd).expanduser().resolve())
    path = _resolve_path(scope, name, resolved_cwd)

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
        new_text = _serialize_agent(fm, body)
    else:
        raise HTTPException(status_code=400, detail="No content provided")

    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
    tmp.write_text(new_text, encoding="utf-8")
    os.replace(tmp, path)

    return {
        "ok": True,
        "path": str(path),
        "mtime": path.stat().st_mtime,
        "bytes": len(new_text.encode("utf-8")),
    }


# ---------- create / delete / duplicate -------------------------------------


TEMPLATES: dict[str, dict[str, Any]] = {
    "blank": {
        "frontmatter": {},
        "body": (
            "\n"
            "Describe what this agent does, when to use it, and what it should "
            "return.\n"
        ),
    },
    "researcher": {
        "frontmatter": {
            "tools": "Read, Grep, Glob, Bash",
        },
        "body": (
            "\n"
            "You are a research agent. Investigate the user's question and report "
            "findings concisely.\n\n"
            "Steps:\n"
            "1. Identify the relevant files and code paths\n"
            "2. Read enough context to answer the question\n"
            "3. Return a concise summary with file:line references\n"
        ),
    },
    "reviewer": {
        "frontmatter": {
            "tools": "Read, Grep, Glob, Bash",
        },
        "body": (
            "\n"
            "You are a code-reviewer agent. Review the diff or changes the user "
            "describes and report issues you find.\n\n"
            "Focus on:\n"
            "- Correctness bugs\n"
            "- Security issues\n"
            "- Performance pitfalls\n"
            "- Style/readability — only when impactful\n\n"
            "Return findings grouped by severity.\n"
        ),
    },
    "implementer": {
        "frontmatter": {
            "tools": "Read, Edit, Write, Grep, Glob, Bash",
        },
        "body": (
            "\n"
            "You are an implementation agent. Make the requested code change "
            "carefully and verify it.\n\n"
            "Steps:\n"
            "1. Read the relevant files first\n"
            "2. Make the minimal change required\n"
            "3. Run tests / type checks where appropriate\n"
            "4. Report what you changed with diffs\n"
        ),
    },
}


def _next_duplicate_name(existing_names: set[str], base: str) -> str:
    candidate = f"duplicate-of-{base}"[:64]
    if candidate not in existing_names:
        return candidate
    for i in range(2, 100):
        cand = f"{candidate}-{i}"[:64]
        if cand not in existing_names:
            return cand
    raise HTTPException(status_code=409, detail="Too many duplicates")


class CreateAgentBody(BaseModel):
    description: Optional[str] = ""
    template: Optional[str] = "blank"
    frontmatter: Optional[dict[str, Any]] = None
    body: Optional[str] = None


@router.post("/{scope}/{name}")
async def create_agent(scope: str, name: str, cwd: str, payload: CreateAgentBody):
    """Create a new agent .md from a template."""
    _validate_name(name)
    resolved_cwd = str(Path(cwd).expanduser().resolve())

    base = _scope_root(scope, resolved_cwd)
    target = base / f"{name}.md"

    existing = _all_names_in_scope(scope, resolved_cwd)
    if name in existing:
        raise HTTPException(status_code=409, detail=f"Agent {name!r} already exists in {scope}")

    template_key = payload.template or "blank"
    template = TEMPLATES.get(template_key, TEMPLATES["blank"])
    fm: dict[str, Any] = {"name": name}
    if payload.description:
        fm["description"] = payload.description
    fm.update(template.get("frontmatter") or {})
    if payload.frontmatter:
        fm.update(payload.frontmatter)
    body = payload.body if payload.body is not None else (template.get("body") or "")

    base.mkdir(parents=True, exist_ok=True)
    text = _serialize_agent(fm, body)
    tmp = target.with_suffix(target.suffix + f".tmp.{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, target)

    return {
        "ok": True,
        "id": f"{scope}:{name}",
        "scope": scope,
        "name": name,
        "path": str(target),
        "mtime": target.stat().st_mtime,
    }


@router.delete("/{scope}/{name}")
async def delete_agent(scope: str, name: str, cwd: str):
    """Delete an agent .md file."""
    resolved_cwd = str(Path(cwd).expanduser().resolve())
    path = _resolve_path(scope, name, resolved_cwd)

    parts = path.resolve().parts
    if ".claude" not in parts:
        raise HTTPException(status_code=400, detail="Refusing to delete outside .claude/")
    if path.parent.name != "agents":
        raise HTTPException(status_code=400, detail="Unexpected agent file layout")

    try:
        path.unlink()
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "removed": str(path), "kind": "file"}


class DuplicateBody(BaseModel):
    target_scope: Optional[str] = None
    target_name: Optional[str] = None


@router.post("/{scope}/{name}/duplicate")
async def duplicate_agent(scope: str, name: str, cwd: str, payload: DuplicateBody):
    """Copy an agent into a new name/scope."""
    resolved_cwd = str(Path(cwd).expanduser().resolve())
    src = _resolve_path(scope, name, resolved_cwd)

    target_scope = payload.target_scope or scope
    if target_scope not in ("project", "personal"):
        raise HTTPException(status_code=400, detail=f"Cannot duplicate to scope {target_scope!r}")

    existing = _all_names_in_scope(target_scope, resolved_cwd)
    new_name = payload.target_name or _next_duplicate_name(existing, name)
    _validate_name(new_name)
    if new_name in existing:
        raise HTTPException(status_code=409, detail=f"Agent {new_name!r} already exists in {target_scope}")

    target_base = _scope_root(target_scope, resolved_cwd)
    target = target_base / f"{new_name}.md"

    src_text = src.read_text(encoding="utf-8", errors="replace")
    fm, body = _parse_frontmatter(src_text)

    fm = dict(fm or {})
    fm = {k: v for k, v in fm.items() if not k.startswith("_")}
    fm["name"] = new_name
    original_desc = fm.get("description") or ""
    if original_desc:
        fm["description"] = f"Duplicate of {name}: {original_desc}"
    else:
        fm["description"] = f"Duplicate of {name}"

    target_base.mkdir(parents=True, exist_ok=True)
    new_text = _serialize_agent(fm, body)
    tmp = target.with_suffix(target.suffix + f".tmp.{os.getpid()}")
    tmp.write_text(new_text, encoding="utf-8")
    os.replace(tmp, target)

    return {
        "ok": True,
        "id": f"{target_scope}:{new_name}",
        "scope": target_scope,
        "name": new_name,
        "path": str(target),
    }
