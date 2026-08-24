"""
Shadow Git - Configurable commit sections.

The section definitions in `BUILTIN_SECTIONS` drive what the summary fork emits in
each rich commit: each entry becomes a key in the JSON schema fed to the model
and a `## Title` block in the resulting markdown commit body. Users can extend
or override sections via per-project config (`shadow_git.commit_sections`).

Public functions (consumed by ShadowGit and `routes/api_app_commit_sections.py`):
- `get_sections_config` — merge builtins with user overrides
- `build_commit_schema` — JSON schema for `--json-schema` output mode
- `build_commit_prompt_for_json` — natural-language prompt that mirrors the schema
- `structured_to_markdown` — render the summary fork's JSON response back into commit-body markdown

Also exposes `COMMIT_PROMPT_COMPACTION` — the prompt used when capturing a
compaction-checkpoint commit (no schema; freeform text).
"""

# Built-in sections that users can enable/disable but not delete
# Each section has:
#   - id: unique identifier (used in config)
#   - title: markdown header (## Title)
#   - prompt: instructions for the summarizer
#   - required: if True, cannot be disabled
#   - default_enabled: initial state
#   - order: default sort order (10, 20, 30...)
#   - applies_to: list of prompt types ["file_changes", "tool_only"]

BUILTIN_SECTIONS = {
    "summary": {
        "id": "summary",
        "title": "Summary",
        "prompt": "ONE SENTENCE: what was accomplished this turn. Future turns will see this as journey context, so make it concrete and informative — reference earlier turns when building on them (e.g., \"Fixed the CORS issue from turn 2 by switching to Authorization headers\"). Just the sentence, no prefix.",
        "prompt_tool_only": "ONE SENTENCE: what was investigated and the key finding. Future turns will see this as journey context, so include the discovery (e.g., \"Investigated API routing — found 12 handlers across 4 controllers, all using JWT auth\"). Just the sentence, no prefix.",
        "required": True,
        "default_enabled": True,
        "order": 10,
        "applies_to": ["file_changes", "tool_only"],
    },
    "tags": {
        "id": "tags",
        "title": "Tags",
        "prompt": "Searchable tags for this work. Include relevant: work type (bugfix, feature, refactor), domain (ui, api, auth), code elements (class names, functions, components), and technical concepts.",
        "field_type": "array",
        "required": False,
        "default_enabled": True,
        "order": 11,
        "applies_to": ["file_changes", "tool_only"],
    },
    "entities": {
        "id": "entities",
        "title": "Entities",
        "prompt": "Named code elements referenced or modified. Format: name:type (e.g., SessionManager:class, handleClick:function, deploy:endpoint). Skip filenames — they are tracked separately. Use consistent type labels.",
        "prompt_tool_only": "Named code elements examined or discussed. Format: name:type (e.g., SessionManager:class, handleClick:function, deploy:endpoint). Skip filenames — they are tracked separately. Use consistent type labels.",
        "field_type": "array",
        "required": False,
        "default_enabled": True,
        "order": 12,
        "applies_to": ["file_changes", "tool_only"],
    },
    "plan_title": {
        "id": "plan_title",
        "title": "Plan Title",
        "prompt": "Short title (3-6 words) for the plan designed in this turn. What is being planned? Examples: 'Background Tasks Feature', 'JWT Auth Refactor', 'DuckDB Plan Tracking'. Just the title, no prefix.",
        "required": False,
        "default_enabled": True,
        "order": 14,
        "applies_to": ["file_changes", "tool_only"],
        "only_when_tools": ["EnterPlanMode", "ExitPlanMode"],
    },
    "plan_summary": {
        "id": "plan_summary",
        "title": "Plan Summary",
        "prompt": "2-3 sentence summary of what this plan proposes. What problem does it solve? What's the approach? What are the key components or changes?",
        "required": False,
        "default_enabled": True,
        "order": 15,
        "applies_to": ["file_changes", "tool_only"],
        "only_when_tools": ["EnterPlanMode", "ExitPlanMode"],
    },
    "work_done": {
        "id": "work_done",
        "title": "Work Done",
        "prompt": "- Bullet points of specific changes\n- Include patterns introduced or modified",
        "required": False,
        "default_enabled": True,
        "order": 20,
        "applies_to": ["file_changes"],
    },
    "investigation": {
        "id": "investigation",
        "title": "Investigation",
        "prompt": "- What you examined and why\n- Hypothesis tested",
        "required": False,
        "default_enabled": True,
        "order": 20,
        "applies_to": ["tool_only"],
    },
    "findings": {
        "id": "findings",
        "title": "Findings",
        "prompt": "- Key discoveries\n- Conclusions reached\n- Questions answered",
        "required": False,
        "default_enabled": True,
        "order": 25,
        "applies_to": ["tool_only"],
    },
    "decisions": {
        "id": "decisions",
        "title": "Decisions",
        "prompt": "- Why this approach (vs alternatives considered)\n- Trade-offs made\n- Patterns chosen and why",
        "required": False,
        "default_enabled": True,
        "order": 30,
        "applies_to": ["file_changes"],
    },
    "problems_solved": {
        "id": "problems_solved",
        "title": "Problems Solved",
        "prompt": "- What issue/bug was fixed (if any)\n- Root cause identified\n- Solution approach\n- Reference previous turns if this fixes an earlier issue",
        "required": False,
        "default_enabled": True,
        "order": 40,
        "applies_to": ["file_changes"],
    },
    "verification": {
        "id": "verification",
        "title": "Verification",
        "prompt": "Commands to verify/test this work (only if tests/checks were run). Format: `command` - what it verifies\nExample: `pytest test_session.py::test_reconnect -v` - WebSocket reconnect\nExample: `curl localhost:8765/api/sessions | jq length` - API returns sessions\nSkip if no verification was done.",
        "prompt_tool_only": "Commands used to investigate/verify. Format: `command` - what it checked\nExample: `curl -s localhost:8765/api/sessions | jq .` - checked API response\nSkip if no commands worth remembering.",
        "required": False,
        "default_enabled": True,
        "order": 45,
        "applies_to": ["file_changes", "tool_only"],
    },
    "commands": {
        "id": "commands",
        "title": "Commands",
        "prompt": (
            "Reusable shell commands from this turn worth remembering. "
            "Include: diagnostic one-liners, curl/API calls, build/install commands, "
            "project-specific scripts, data extraction pipelines, "
            "and any command someone might search for later.\n"
            "Exclude: trivial navigation (cd, ls, cat), routine git (add, commit, push), "
            "and simple file reads.\n"
            "Format: `command` - what it does\n"
            "Example: `curl -s localhost:8765/api/sessions | jq '.[].name'` - list session names\n"
            "Example: `lsof -i :8880 -t | xargs kill` - kill process on dev port\n"
            "Example: `python3 -c \"import ast; ast.parse(open('server.py').read())\"` - syntax check\n"
            "Skip if no interesting commands were run."
        ),
        "prompt_tool_only": (
            "Reusable shell commands from this investigation worth remembering. "
            "Include: diagnostic one-liners, curl/API calls, search commands with useful flags, "
            "project-specific scripts, data extraction pipelines, "
            "and any command someone might search for later.\n"
            "Exclude: trivial navigation (cd, ls, cat), routine git (add, commit, push), "
            "and simple file reads.\n"
            "Format: `command` - what it does\n"
            "Example: `du -sh ~/.painapple-code/projects/*/shadow-git/` - shadow git repo sizes\n"
            "Example: `shadow-query 'SELECT count(*) FROM turns'` - total turn count via /api/shadow-db/sql\n"
            "Example: `grep -rn 'ORPHAN_PROCESS_TIMEOUT' services/` - find timeout constant\n"
            "Skip if no interesting commands were run."
        ),
        "field_type": "array",
        "required": False,
        "default_enabled": True,
        "order": 47,
        "applies_to": ["file_changes", "tool_only"],
    },
    "tools_used": {
        "id": "tools_used",
        "title": "Tools Used",
        "prompt": "- Tool: input → key finding",
        "required": False,
        "default_enabled": True,
        "order": 50,
        "applies_to": ["file_changes", "tool_only"],
    },
    "context_for_resume": {
        "id": "context_for_resume",
        "title": "Context for Resume",
        "prompt": "- Current state: what works now\n- Open items: what's left to do\n- Gotchas: things to remember",
        "prompt_tool_only": "- Current understanding\n- Next steps to try\n- Related areas to explore",
        "required": False,
        "default_enabled": True,
        "order": 60,
        "applies_to": ["file_changes", "tool_only"],
    },
    "learnings": {
        "id": "learnings",
        "title": "Learnings",
        "prompt": "- Discoveries worth remembering\n- Warnings for future work",
        "prompt_tool_only": "- Things discovered worth remembering\n- Gotchas or warnings",
        "required": False,
        "default_enabled": True,
        "order": 70,
        "applies_to": ["file_changes", "tool_only"],
    },
    "session_title": {
        "id": "session_title",
        "title": "Session Title",
        "prompt": """A SHORT title (3-6 words) for this entire session. This helps identify the session later.
- Capture the main goal or theme of the work
- Update if the focus has shifted from previous turns
- Examples: "JWT Auth Refactor", "Widget Empty Fix", "Cost Analytics Feature"
- Just the title, no prefix or formatting.""",
        "required": True,
        "default_enabled": True,
        "order": 10,
        "applies_to": ["file_changes", "tool_only"],
    },
}


def get_sections_config(project_config: dict) -> dict:
    """
    Merge user's section config with built-in defaults.

    Args:
        project_config: Project config dict (from load_project_config)

    Returns:
        Dict of section_id -> merged section config
    """
    user_sections = project_config.get("shadow_git", {}).get("commit_sections", {})
    result = {}

    # Start with built-in sections
    for section_id, builtin in BUILTIN_SECTIONS.items():
        merged = builtin.copy()

        # Apply user overrides
        if section_id in user_sections:
            user = user_sections[section_id]
            if "enabled" in user:
                # Can't disable required sections
                if not builtin["required"]:
                    merged["enabled"] = user["enabled"]
                else:
                    merged["enabled"] = True
            else:
                merged["enabled"] = builtin["default_enabled"]

            if "order" in user:
                merged["order"] = user["order"]

            # Allow customizing prompt for non-required sections
            if "prompt" in user and not builtin["required"]:
                merged["prompt"] = user["prompt"]
        else:
            merged["enabled"] = builtin["default_enabled"]

        merged["builtin"] = True
        result[section_id] = merged

    # Add custom user sections
    for section_id, user_section in user_sections.items():
        if section_id not in BUILTIN_SECTIONS:
            # Custom section - must have title and prompt
            if "title" in user_section and "prompt" in user_section:
                result[section_id] = {
                    "id": section_id,
                    "title": user_section["title"],
                    "prompt": user_section["prompt"],
                    "prompt_tool_only": user_section.get("prompt_tool_only", user_section["prompt"]),
                    "required": False,
                    "enabled": user_section.get("enabled", True),
                    "order": user_section.get("order", 55),  # Default between tools_used and context
                    "applies_to": user_section.get("applies_to", ["file_changes", "tool_only"]),
                    "field_type": user_section.get("field_type", "array"),  # "string" or "array"
                    "builtin": False,
                }

    return result


def build_commit_schema(project_config: dict, prompt_type: str) -> dict:
    """
    Build JSON schema for structured commit message output.

    The schema is dynamic based on which sections are enabled.

    Args:
        project_config: Project config dict
        prompt_type: "file_changes" or "tool_only"

    Returns:
        JSON schema dict for --json-schema flag
    """
    sections_config = get_sections_config(project_config)

    # Filter enabled sections for this prompt type
    enabled_sections = [
        s for s in sections_config.values()
        if s.get("enabled", True) and prompt_type in s.get("applies_to", [])
    ]

    # Build properties for each enabled section
    properties = {}
    required = []

    for section in enabled_sections:
        section_id = section["id"]

        # Determine field type - user can override, defaults based on section
        # field_type: "string" for single value, "array" for bullet points
        field_type = section.get("field_type")
        if not field_type:
            # Default: summary/title are strings, rest are arrays
            if section_id in ("summary", "session_title"):
                field_type = "string"
            else:
                field_type = "array"

        if field_type == "string":
            properties[section_id] = {
                "type": "string",
                "description": section.get("prompt", "")
            }
        else:
            properties[section_id] = {
                "type": "array",
                "items": {"type": "string"},
                "description": section.get("prompt", "")
            }

        # Required sections must be present
        if section.get("required"):
            required.append(section_id)

    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False
    }


def build_commit_prompt_for_json(
    project_config: dict,
    prompt_type: str,
    journey_section: str,
    user_prompt: str,
    files: str = "",
    tools: str = ""
) -> str:
    """
    Build prompt for JSON structured output (used with --json-schema).

    Simpler than markdown prompt since schema enforces structure.

    Args:
        project_config: Project config dict
        prompt_type: "file_changes" or "tool_only"
        journey_section: Formatted journey context
        user_prompt: User's original request
        files: Comma-separated file list (for file_changes)
        tools: Formatted tools list

    Returns:
        Prompt string for the summarizer (JSON output)
    """
    sections_config = get_sections_config(project_config)

    # Parse tool names from the tools string for conditional section filtering
    tools_set = set(t.strip() for t in tools.split(",")) if tools else set()

    # Filter and sort enabled sections for this prompt type
    enabled_sections = []
    for s in sections_config.values():
        if not s.get("enabled", True):
            continue
        if prompt_type not in s.get("applies_to", []):
            continue
        # Conditional sections: only include when specific tools were used
        only_when = s.get("only_when_tools")
        if only_when and not (set(only_when) & tools_set):
            continue
        enabled_sections.append(s)
    enabled_sections.sort(key=lambda s: s.get("order", 50))

    # Build intro
    if prompt_type == "file_changes":
        intro = "You just completed a turn helping the user. Generate a structured commit message as JSON."
    else:
        intro = "You just completed a turn (no files modified). Generate a structured commit message documenting your investigation as JSON."

    # Build context
    parts = [intro, ""]

    if journey_section:
        parts.append(journey_section)

    parts.append(f"USER'S REQUEST:\n{user_prompt}")
    parts.append("")

    if prompt_type == "file_changes" and files:
        parts.append(f"FILES MODIFIED: {files}")
        parts.append("")

    parts.append(f"TOOLS USED: {tools}")
    parts.append("")

    # Field instructions
    parts.append("Fill each JSON field according to these guidelines:")
    parts.append("")

    for section in enabled_sections:
        section_id = section["id"]
        if prompt_type == "tool_only" and "prompt_tool_only" in section:
            prompt_text = section["prompt_tool_only"]
        else:
            prompt_text = section["prompt"]

        clean_prompt = prompt_text.replace("\n", " ").strip()
        parts.append(f"- {section_id}: {clean_prompt}")

    parts.append("")
    parts.append("Be concise. Use keywords that are searchable.")

    return "\n".join(parts)


def structured_to_markdown(structured: dict, project_config: dict, prompt_type: str) -> str:
    """
    Convert structured JSON response back to markdown for git commit message.

    Args:
        structured: Parsed JSON response from the summary fork
        project_config: Project config dict
        prompt_type: "file_changes" or "tool_only"

    Returns:
        Markdown formatted commit message body
    """
    sections_config = get_sections_config(project_config)

    # Filter and sort enabled sections
    enabled_sections = [
        s for s in sections_config.values()
        if s.get("enabled", True) and prompt_type in s.get("applies_to", [])
    ]
    enabled_sections.sort(key=lambda s: s.get("order", 50))

    # Internal-only fields: produced by the summary fork and consumed elsewhere
    # (session.name update, etc.) but not rendered as a commit-body section.
    INTERNAL_ONLY = {"session_title"}

    parts = []

    for section in enabled_sections:
        section_id = section["id"]
        if section_id in INTERNAL_ONLY:
            continue
        title = section["title"]
        value = structured.get(section_id)

        if not value:
            continue

        parts.append(f"## {title}")

        if isinstance(value, list):
            for item in value:
                if item:
                    parts.append(f"- {item}")
        else:
            parts.append(str(value))

        parts.append("")

    return "\n".join(parts).strip()


COMMIT_PROMPT_COMPACTION = """This conversation is about to be compacted. Generate a COMPREHENSIVE summary to preserve important context that will be lost.

Generate with this EXACT structure:

## Session Overview
What was the user trying to accomplish? Key goals.

## Tags
All relevant tags from the session: #feature #bugfix etc. + domain tags

## Work Completed
- Major features/changes implemented
- Key milestones reached

## Decisions Made
- Architectural decisions and rationale
- Trade-offs chosen
- Patterns established

## Problems Solved
- Issues debugged
- Root causes found
- Solutions that worked

## Files Changed
- Key files modified and why
- New files created
- Dependencies added

## Current State
- What works now
- What's partially done
- Known issues

## Critical Context
- Things that MUST be remembered
- Gotchas discovered
- Warnings for future work

## Open Items
- What's left to do
- Blockers encountered
- Questions unanswered

Be THOROUGH - this is the only record of the full context."""
