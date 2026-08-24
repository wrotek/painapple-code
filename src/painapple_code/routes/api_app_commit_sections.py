"""
Commit Sections API Routes.

Endpoints for managing commit message sections configuration for shadow git
on a per-project basis.
"""

import logging

from fastapi import APIRouter, HTTPException, Request

from painapple_code import paths
from painapple_code.shadow_git import (
    BUILTIN_SECTIONS, get_shadow_git, get_commit_sections_for_api
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["app:commit-sections"])


# ═══════════════════════════════════════════════════════════════════
# Commit Sections API
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/app/projects/{project_hash}/commit-sections")
async def get_commit_sections(project_hash: str):
    """Get commit message sections configuration for a project."""
    project_path = paths.get_project_path_from_hash(project_hash)
    if not project_path:
        raise HTTPException(status_code=404, detail="Project not found")

    project_config = paths.load_project_config(project_path)
    return get_commit_sections_for_api(project_config)


@router.put("/api/app/projects/{project_hash}/commit-sections")
async def update_commit_sections(project_hash: str, request: Request):
    """Update commit sections configuration for a project."""
    project_path = paths.get_project_path_from_hash(project_hash)
    if not project_path:
        raise HTTPException(status_code=404, detail="Project not found")

    body = await request.json()
    sections_update = body.get("sections", {})

    project_config = paths.load_project_config(project_path)

    if "shadow_git" not in project_config:
        project_config["shadow_git"] = {}
    if "commit_sections" not in project_config["shadow_git"]:
        project_config["shadow_git"]["commit_sections"] = {}

    current_sections = project_config["shadow_git"]["commit_sections"]

    for section_id, updates in sections_update.items():
        if updates.get("delete") and section_id not in BUILTIN_SECTIONS:
            current_sections.pop(section_id, None)
            continue

        if section_id in BUILTIN_SECTIONS:
            builtin = BUILTIN_SECTIONS[section_id]
            if section_id not in current_sections:
                current_sections[section_id] = {}

            if "enabled" in updates and not builtin["required"]:
                current_sections[section_id]["enabled"] = bool(updates["enabled"])
            if "order" in updates:
                current_sections[section_id]["order"] = int(updates["order"])
            if "prompt" in updates and not builtin["required"]:
                current_sections[section_id]["prompt"] = str(updates["prompt"])
        else:
            if "title" not in updates or "prompt" not in updates:
                if section_id not in current_sections:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Custom section '{section_id}' requires 'title' and 'prompt'"
                    )
            else:
                current_sections[section_id] = {
                    "title": str(updates["title"]),
                    "prompt": str(updates["prompt"]),
                    "enabled": updates.get("enabled", True),
                    "order": updates.get("order", 55),
                    "applies_to": updates.get("applies_to", ["file_changes", "tool_only"]),
                }

            if section_id in current_sections:
                if "enabled" in updates:
                    current_sections[section_id]["enabled"] = bool(updates["enabled"])
                if "order" in updates:
                    current_sections[section_id]["order"] = int(updates["order"])
                if "prompt" in updates:
                    current_sections[section_id]["prompt"] = str(updates["prompt"])
                if "title" in updates:
                    current_sections[section_id]["title"] = str(updates["title"])
                if "applies_to" in updates:
                    current_sections[section_id]["applies_to"] = updates["applies_to"]

    paths.save_project_config(project_path, project_config)
    logger.info(f"Updated commit sections for project {project_hash}")

    shadow = get_shadow_git(project_path)
    shadow.reload_config()

    return get_commit_sections_for_api(project_config)


@router.post("/api/app/projects/{project_hash}/commit-sections/reset")
async def reset_commit_sections(project_hash: str):
    """Reset commit sections to defaults."""
    project_path = paths.get_project_path_from_hash(project_hash)
    if not project_path:
        raise HTTPException(status_code=404, detail="Project not found")

    project_config = paths.load_project_config(project_path)

    if "shadow_git" in project_config:
        project_config["shadow_git"].pop("commit_sections", None)

    paths.save_project_config(project_path, project_config)
    logger.info(f"Reset commit sections to defaults for project {project_hash}")

    shadow = get_shadow_git(project_path)
    shadow.reload_config()

    return get_commit_sections_for_api(project_config)
