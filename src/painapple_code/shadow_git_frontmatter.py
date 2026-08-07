"""
Shadow Git - YAML frontmatter and summary-response parsers.

Each rich commit message starts with a YAML frontmatter block carrying
session/turn/cost metadata plus a `journey:` list of previous turns'
summaries. Future turns parse this block to rebuild context without re-running
the summarizer.

This module owns:
- `CostInfo` / `SummaryCost` dataclasses (used as commit_turn parameters)
- `parse_yaml_frontmatter` / `format_yaml_frontmatter` round-trip helpers
- Markdown-section extractors used by the non-structured summary fallback path
  (`extract_summary_line`, `extract_session_title`, `extract_tags_from_response`)
- `build_journey_section` which renders the journey list into prompt text

Public re-exports (consumed by other modules via `shadow_git`):
- `parse_yaml_frontmatter`, `YAML_FRONTMATTER_PATTERN` — `shadow_parser.py`,
  `welcome_search.py`
- `CostInfo` — `services/agent_session.py`
"""

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional


@dataclass
class CostInfo:
    """Token and cost information for a turn."""
    duration: float = 0.0
    cost: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0


@dataclass
class SummaryCost:
    """Cost info from the summary fork for rich commits."""
    cost: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    duration: float = 0.0


# Maximum turns to include in journey context (keeps prompt size reasonable)
MAX_JOURNEY_TURNS = 15

# Regex to parse YAML frontmatter from commit messages
YAML_FRONTMATTER_PATTERN = re.compile(r'^---\n(.*?)\n---\n', re.DOTALL)


def parse_yaml_frontmatter(commit_message: str) -> dict:
    """
    Extract YAML frontmatter from a commit message.

    Args:
        commit_message: Full commit message text

    Returns:
        Dict of parsed YAML fields, or empty dict if no frontmatter
    """
    match = YAML_FRONTMATTER_PATTERN.match(commit_message)
    if not match:
        return {}

    yaml_text = match.group(1)
    result = {}

    # Simple YAML parser for our known structure (avoids PyYAML dependency)
    current_key = None
    current_list = None

    for line in yaml_text.split('\n'):
        line = line.rstrip()

        # Skip empty lines
        if not line:
            continue

        # List item under current key
        if line.startswith('  - ') and current_key == 'journey':
            if current_list is None:
                current_list = []
                result[current_key] = current_list
            # Parse journey entry: "  - turn: N"
            item_match = re.match(r'  - turn: (\d+)', line)
            if item_match:
                current_list.append({'turn': int(item_match.group(1))})
        elif line.startswith('    summary: ') and current_list:
            # Journey summary line
            summary = line[13:].strip().strip('"\'')
            if current_list:
                current_list[-1]['summary'] = summary
        elif line.startswith('  ') and current_key and current_key != 'journey':
            # Continuation of multi-line value
            continue
        elif ': ' in line or line.endswith(':'):
            # New key-value pair
            if ': ' in line:
                key, value = line.split(': ', 1)
                current_key = key.strip()
                value = value.strip()

                # Parse value types
                if value.startswith('[') and value.endswith(']'):
                    # List in compact form: [a, b, c]
                    items = value[1:-1].split(', ')
                    result[current_key] = [i.strip().strip('"\'') for i in items if i.strip()]
                elif value.isdigit():
                    result[current_key] = int(value)
                elif value.replace('.', '').isdigit():
                    result[current_key] = float(value)
                elif value.lower() in ('true', 'false'):
                    result[current_key] = value.lower() == 'true'
                elif value.startswith('"') and value.endswith('"'):
                    result[current_key] = value[1:-1]
                elif value.startswith("'") and value.endswith("'"):
                    result[current_key] = value[1:-1]
                elif value:
                    result[current_key] = value
                else:
                    # Key with no value - might be a list or nested object
                    current_list = None
            else:
                # Key ending with : (start of list or nested object)
                current_key = line[:-1].strip()
                current_list = None

    return result


def format_yaml_frontmatter(
    session_id: str,
    turn_num: int,
    files: list[str],
    tools: list[str],
    cost: float,
    input_tokens: int,
    output_tokens: int,
    journey: list[dict],
    summary: str,
    project_git_hash: Optional[str] = None,
    project_branch: Optional[str] = None,
    model: Optional[str] = None,
) -> str:
    """
    Format YAML frontmatter for a commit message.

    Args:
        session_id: Session identifier
        turn_num: Turn number
        files: List of modified files
        tools: List of tool names used
        cost: Total cost in USD
        journey: List of previous turn summaries [{turn: 1, summary: "..."}]
        summary: One-line summary for this turn's journey entry
        project_git_hash: Project's git HEAD hash (if project has git)
        project_branch: Project's current git branch (if project has git)
        model: Primary model ID for this turn (highest cost share)

    Returns:
        Formatted YAML frontmatter string
    """
    timestamp = datetime.now(timezone.utc).isoformat()

    # Escape special characters in summary
    safe_summary = summary.replace('"', '\\"').replace('\n', ' ')[:200]

    lines = [
        "---",
        f"session: {session_id}",
        f"turn: {turn_num}",
        f"timestamp: {timestamp}",
    ]

    # Project git hash and branch (if project has git)
    if project_git_hash:
        lines.append(f"project_ref: {project_git_hash}")
    if project_branch:
        lines.append(f"project_branch: {project_branch}")

    # Files
    if files:
        lines.append(f"files: [{', '.join(files[:20])}]")

    # Tools
    if tools:
        lines.append(f"tools: [{', '.join(sorted(set(tools)))}]")

    # Cost
    lines.append(f"cost: {cost:.4f}")
    lines.append(f"tokens_in: {input_tokens}")
    lines.append(f"tokens_out: {output_tokens}")
    if model:
        lines.append(f"model: {model}")

    # Journey (previous turns)
    if journey:
        lines.append("journey:")
        for entry in journey[-MAX_JOURNEY_TURNS:]:  # Limit journey size
            lines.append(f"  - turn: {entry.get('turn', 0)}")
            entry_summary = entry.get('summary', '').replace('"', '\\"').replace('\n', ' ')[:150]
            lines.append(f'    summary: "{entry_summary}"')

    # This turn's summary (for next turn's journey)
    lines.append(f'summary: "{safe_summary}"')

    lines.append("---")
    lines.append("")

    return '\n'.join(lines)


def extract_summary_line(response: str) -> str:
    """
    Extract the one-line summary from the summary fork's response (## Summary section).

    Used by the non-structured fallback path when JSON output is unavailable.

    Args:
        response: Full response from the summary fork

    Returns:
        One-line summary, or empty string if not found
    """
    pattern = r'## Summary\s*\n(.*?)(?:\n##|\n---|\Z)'
    match = re.search(pattern, response, re.DOTALL | re.IGNORECASE)
    if match:
        content = match.group(1).strip()
        for line in content.split('\n'):
            line = line.strip()
            if line and not line.startswith('-') and not line.startswith('*'):
                return line.strip('"\'')[:200]
    return ""


def extract_tags_from_response(response: str) -> list[str]:
    """
    Extract tags from the summary fork's response.

    Args:
        response: Full response from the summary fork

    Returns:
        List of tags (e.g., ['#feature', '#auth'])
    """
    # Look for ## Tags section
    pattern = r'## Tags\s*\n(.*?)(?:\n##|\n---|\Z)'
    match = re.search(pattern, response, re.DOTALL | re.IGNORECASE)

    if match:
        content = match.group(1).strip()
        # Find all hashtags
        tags = re.findall(r'#\w+', content)
        return tags[:15]  # Limit to 15 tags

    return []


def extract_session_title(response: str) -> str:
    """
    Extract session title from the summary fork's response.

    Args:
        response: Full response from the summary fork

    Returns:
        Session title (3-6 words), or empty string if not found
    """
    # Look for ## Session Title section
    pattern = r'## Session Title\s*\n(.*?)(?:\n##|\n---|\Z)'
    match = re.search(pattern, response, re.DOTALL | re.IGNORECASE)

    if match:
        content = match.group(1).strip()
        # Get first non-empty line that's not a bullet point
        for line in content.split('\n'):
            line = line.strip()
            if line and not line.startswith('-') and not line.startswith('*'):
                # Clean up and truncate
                title = line.strip('"\'')
                return title[:60]  # Max 60 chars

    return ""


def build_journey_section(journey: list[dict]) -> str:
    """
    Build the journey context section for the prompt.

    Args:
        journey: List of previous turn summaries [{turn: 1, summary: "..."}]

    Returns:
        Formatted journey section for the prompt, or empty string if no journey
    """
    if not journey:
        return ""

    lines = [
        "",
        "JOURNEY SO FAR (previous turns this session):",
    ]

    for entry in journey[-MAX_JOURNEY_TURNS:]:
        turn = entry.get('turn', '?')
        summary = entry.get('summary', 'No summary')
        lines.append(f"- Turn {turn}: {summary}")

    lines.append("")
    return '\n'.join(lines)
