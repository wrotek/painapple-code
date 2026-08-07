"""
Welcome Search - Shadow Git powered session discovery.

Replaces the dumb AI search with intelligent queries against shadow git commit data.
Parses natural language queries and structured queries into git commands.

Usage:
    searcher = WelcomeSearcher(project_paths)
    results = await searcher.search("auth bug fix from last week")
"""

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

from painapple_code.bridge_paths import (
    BRIDGE_HOME,
    get_project_display_name,
    get_shadow_git_dir,
    get_sessions_dir,
    list_projects,
)
from painapple_code.shadow_git import parse_yaml_frontmatter

logger = logging.getLogger("painapple-code.welcome-search")


# ═══════════════════════════════════════════════════════════════════════════
# Query Parsing
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class ParsedQuery:
    """Structured representation of a search query."""
    raw: str
    keywords: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    code_pattern: Optional[str] = None
    project_filter: Optional[str] = None
    time_filter: Optional[str] = None  # git --since format
    time_until: Optional[str] = None   # git --until format
    model_filter: Optional[str] = None
    intent: str = "search"  # search or task


# Time expressions to git date format
TIME_EXPRESSIONS = {
    "today": ("today", None),
    "yesterday": ("yesterday", "today"),
    "this week": ("1 week ago", None),
    "last week": ("2 weeks ago", "1 week ago"),
    "this month": ("1 month ago", None),
    "last month": ("2 months ago", "1 month ago"),
    "recently": ("3 days ago", None),
}


def parse_query(query: str) -> ParsedQuery:
    """
    Parse a natural language or structured query.

    Supports:
    - Natural: "that session where I fixed auth"
    - Tags: "#bugfix #api"
    - Files: "files:server.py"
    - Code: "code:handleAuth"
    - Time: "yesterday", "last week"
    - Project: "in:ai-sysop"
    - Model: "with:opus"

    Args:
        query: Raw query string

    Returns:
        ParsedQuery with extracted components
    """
    parsed = ParsedQuery(raw=query)
    remaining = query.lower()

    # Detect task intent (user wants to do something, not just search)
    task_words = ["help me", "i want to", "let's", "add", "fix", "implement", "create"]

    if any(w in remaining for w in task_words):
        parsed.intent = "task"

    # Extract tags (#bugfix, #auth, etc.)
    tag_pattern = r'#(\w+)'
    tags = re.findall(tag_pattern, query)
    parsed.tags = [f"#{t}" for t in tags]
    remaining = re.sub(tag_pattern, '', remaining)

    # Extract file filters (files:path or file:path)
    file_pattern = r'files?:(\S+)'
    files = re.findall(file_pattern, query, re.IGNORECASE)
    parsed.files = files
    remaining = re.sub(file_pattern, '', remaining, flags=re.IGNORECASE)

    # Extract code pattern (code:pattern)
    code_pattern = r'code:(\S+)'
    code_match = re.search(code_pattern, query, re.IGNORECASE)
    if code_match:
        parsed.code_pattern = code_match.group(1)
        remaining = re.sub(code_pattern, '', remaining, flags=re.IGNORECASE)

    # Extract project filter (in:project)
    project_pattern = r'in:(\S+)'
    project_match = re.search(project_pattern, query, re.IGNORECASE)
    if project_match:
        parsed.project_filter = project_match.group(1)
        remaining = re.sub(project_pattern, '', remaining, flags=re.IGNORECASE)

    # Extract model filter (with:opus, with:haiku)
    model_pattern = r'with:(opus|sonnet|haiku)'
    model_match = re.search(model_pattern, query, re.IGNORECASE)
    if model_match:
        parsed.model_filter = model_match.group(1).lower()
        remaining = re.sub(model_pattern, '', remaining, flags=re.IGNORECASE)

    # Extract time expressions
    for expr, (since, until) in TIME_EXPRESSIONS.items():
        if expr in remaining:
            parsed.time_filter = since
            parsed.time_until = until
            remaining = remaining.replace(expr, '')
            break

    # Also check for "from last week", "since yesterday" patterns
    if "last week" in remaining:
        parsed.time_filter = "1 week ago"
        remaining = remaining.replace("last week", "")
    elif "last month" in remaining:
        parsed.time_filter = "1 month ago"
        remaining = remaining.replace("last month", "")

    # Clean up common filler words
    filler_words = [
        "that", "session", "where", "i", "the", "a", "an", "on", "in",
        "from", "with", "was", "did", "worked", "fixed", "about", "for",
        "show", "me", "find", "search"
    ]
    words = remaining.split()
    keywords = [w.strip() for w in words if w.strip() and w not in filler_words]

    # Remove punctuation from keywords
    keywords = [re.sub(r'[^\w]', '', k) for k in keywords]
    keywords = [k for k in keywords if k and len(k) > 1]

    parsed.keywords = keywords

    return parsed


# ═══════════════════════════════════════════════════════════════════════════
# Session Result
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class SessionResult:
    """Enriched session search result."""
    session_id: str
    project: str
    project_path: str

    # From meta.json
    name: Optional[str] = None
    created_at: Optional[str] = None
    last_activity: Optional[str] = None
    message_count: int = 0
    total_cost: float = 0.0

    # Fork relationship
    forked_from: Optional[dict] = None  # {store_id, provider_session_id}
    is_comment_thread: bool = False

    # From shadow git commits
    summary: Optional[str] = None
    tags: list[str] = field(default_factory=list)
    files_changed: list[str] = field(default_factory=list)
    journey_snippet: Optional[str] = None
    key_decisions: list[str] = field(default_factory=list)

    # Shadow stats
    turn_count: int = 0
    tools_summary: dict = field(default_factory=dict)

    # Fallback when no summary yet
    first_prompt: Optional[str] = None

    # Search relevance
    match_score: float = 0.0
    match_reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "project": self.project,
            "project_path": self.project_path,
            "name": self.name,
            "created_at": self.created_at,
            "last_activity": self.last_activity,
            "message_count": self.message_count,
            "total_cost": self.total_cost,
            "forked_from": self.forked_from,
            "is_comment_thread": self.is_comment_thread,
            "summary": self.summary,
            "tags": self.tags,
            "files_changed": self.files_changed[:10],  # Limit
            "journey_snippet": self.journey_snippet,
            "key_decisions": self.key_decisions[:3],
            "turn_count": self.turn_count,
            "tools_summary": self.tools_summary,
            "first_prompt": self.first_prompt,
            "match_score": self.match_score,
            "match_reasons": self.match_reasons,
        }


# ═══════════════════════════════════════════════════════════════════════════
# Welcome Searcher
# ═══════════════════════════════════════════════════════════════════════════

class WelcomeSearcher:
    """
    Smart session search using shadow git archaeology.

    Replaces the dumb AI search that sent summaries to Claude.
    """

    def __init__(self):
        """Initialize searcher."""
        self.bridge_dir = BRIDGE_HOME

    @staticmethod
    def _read_first_prompt(sessions_dir: Path, session_id: str) -> Optional[str]:
        """Read the first user prompt from messages.jsonl (truncated to 200 chars)."""
        messages_file = sessions_dir / session_id / "messages.jsonl"
        if not messages_file.exists():
            return None
        try:
            with open(messages_file) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    msg = json.loads(line)
                    if msg.get("role") == "user":
                        content = msg.get("content", "")
                        if isinstance(content, str) and content:
                            return content[:200]
                        break
        except Exception:
            pass
        return None

    async def search(
        self,
        query: str,
        limit: int = 10
    ) -> dict:
        """
        Search sessions using shadow git data.

        Args:
            query: Natural language or structured query
            limit: Maximum results to return

        Returns:
            Dict with results, parsed query, suggestions
        """
        # Parse the query
        parsed = parse_query(query)

        logger.info(f"Searching: {query}")
        logger.debug(f"Parsed: keywords={parsed.keywords}, tags={parsed.tags}, "
                    f"time={parsed.time_filter}, files={parsed.files}")

        # Get all projects
        projects = list_projects()

        if parsed.project_filter:
            # Filter to matching project
            projects = [
                p for p in projects
                if parsed.project_filter.lower() in p["path"].lower()
            ]

        # Search each project's shadow git
        all_results = []

        for project in projects:
            project_path = project["path"]
            project_hash = project["hash"]

            try:
                results = await self._search_project(
                    project_path, project_hash, parsed
                )
                all_results.extend(results)
            except Exception as e:
                logger.warning(f"Error searching {project_path}: {e}")

        # Rank results
        ranked = self._rank_results(all_results, parsed)

        # Limit
        results = ranked[:limit]

        # Generate suggestions
        suggestions = self._generate_suggestions(parsed, results)

        return {
            "query": query,
            "parsed": {
                "keywords": parsed.keywords,
                "tags": parsed.tags,
                "files": parsed.files,
                "code_pattern": parsed.code_pattern,
                "time_filter": parsed.time_filter,
                "project_filter": parsed.project_filter,
                "intent": parsed.intent,
            },
            "results": [r.to_dict() for r in results],
            "total_found": len(all_results),
            "suggestions": suggestions,
        }

    async def _search_project(
        self,
        project_path: str,
        project_hash: str,
        parsed: ParsedQuery
    ) -> list[SessionResult]:
        """Search a single project's shadow git."""

        shadow_dir = get_shadow_git_dir(project_path)
        sessions_dir = get_sessions_dir(project_path)

        if not shadow_dir.exists():
            # No shadow git - fall back to session metadata only
            return await self._search_sessions_only(
                project_path, project_hash, sessions_dir, parsed
            )

        # Build git log command
        cmd = [
            "git",
            f"--git-dir={shadow_dir}",
            f"--work-tree={project_path}",
            "log",
            "--format=%H|%s|%ai|%B§END§",
            "-n", "200",  # Search last 200 commits
        ]

        # Add grep filters for tags
        if parsed.tags:
            for tag in parsed.tags:
                cmd.extend(["--grep", tag])
            cmd.append("--all-match")

        # Add grep filters for keywords (match any)
        if parsed.keywords:
            for kw in parsed.keywords:
                cmd.extend(["--grep", kw])

        # Add time filters
        if parsed.time_filter:
            cmd.extend(["--since", parsed.time_filter])
        if parsed.time_until:
            cmd.extend(["--until", parsed.time_until])

        # Add file filters
        if parsed.files:
            cmd.append("--")
            for f in parsed.files:
                cmd.append(f"*{f}*")

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=project_path
            )

            stdout, stderr = await proc.communicate()

            if proc.returncode != 0:
                logger.debug(f"Git log returned {proc.returncode}: {stderr.decode()[:100]}")
                return []

            output = stdout.decode()

        except Exception as e:
            logger.warning(f"Git command failed: {e}")
            return []

        # Parse commits and group by session
        shadow_results = self._parse_commits_to_sessions(
            output, project_path, project_hash, sessions_dir, parsed
        )

        # Also include sessions from the session store that have NO shadow git
        # commits yet (e.g., fresh sessions before first turn completes).
        # Only do this for browse queries (no keywords/tags/files) to avoid
        # polluting search results with empty sessions.
        if not parsed.keywords and not parsed.tags and not parsed.files:
            shadow_session_ids = {r.session_id for r in shadow_results}
            orphan_results = await self._search_sessions_only(
                project_path, project_hash, sessions_dir, parsed
            )
            for orphan in orphan_results:
                if orphan.session_id not in shadow_session_ids:
                    shadow_results.append(orphan)

        return shadow_results

    async def _search_sessions_only(
        self,
        project_path: str,
        project_hash: str,
        sessions_dir: Path,
        parsed: ParsedQuery
    ) -> list[SessionResult]:
        """Fallback search using only session metadata (no shadow git)."""

        results = []

        if not sessions_dir.exists():
            return results

        project_name = get_project_display_name(project_path)

        for session_dir in sessions_dir.iterdir():
            if not session_dir.is_dir():
                continue

            meta_file = session_dir / "meta.json"
            if not meta_file.exists():
                continue

            try:
                meta = json.loads(meta_file.read_text())

                # Check if matches query
                name = meta.get("name", "")

                score = 0.0
                reasons = []

                for kw in parsed.keywords:
                    if kw.lower() in name.lower():
                        score += 0.5
                        reasons.append(f"Name contains '{kw}'")

                if not parsed.keywords or score > 0:
                    first_prompt = self._read_first_prompt(sessions_dir, session_dir.name)
                    result = SessionResult(
                        session_id=session_dir.name,
                        project=project_name,
                        project_path=project_path,
                        name=name,
                        created_at=meta.get("created_at"),
                        last_activity=meta.get("last_activity"),
                        message_count=meta.get("message_count", 0),
                        total_cost=meta.get("total_cost", 0.0),
                        forked_from=meta.get("forked_from"),
                        is_comment_thread=meta.get("isCommentThread", False),
                        first_prompt=first_prompt,
                        match_score=score,
                        match_reasons=reasons,
                    )
                    results.append(result)

            except Exception as e:
                logger.debug(f"Failed to parse session {session_dir.name}: {e}")

        return results

    def _parse_commits_to_sessions(
        self,
        git_output: str,
        project_path: str,
        project_hash: str,
        sessions_dir: Path,
        parsed: ParsedQuery
    ) -> list[SessionResult]:
        """Parse git log output and group commits by session."""

        # Split by our delimiter
        commit_blocks = git_output.split("§END§")

        # Group by session
        session_commits: dict[str, list[dict]] = {}

        for block in commit_blocks:
            block = block.strip()
            if not block:
                continue

            # Parse: hash|subject|date|body
            try:
                first_line, _, body = block.partition('\n')
                parts = first_line.split('|', 3)
                if len(parts) < 3:
                    continue

                commit_hash = parts[0]
                subject = parts[1]
                date = parts[2]
                full_body = body.strip() if len(parts) > 3 else ""

                # The subject line contains embedded YAML frontmatter
                # Format: "--- session: ABC123 turn: 1 timestamp: ... tags: [#tag1, #tag2] ..."
                # OR: "[ABC123] Turn 1: message"

                # Try to extract session ID from YAML-style subject
                session_match = re.search(r'session:\s*([A-Za-z0-9_-]+)', subject)
                if not session_match:
                    # Fallback: try [session_id] format
                    session_match = re.match(r'\[([A-Za-z0-9_-]+)', subject)

                if not session_match:
                    continue

                session_id_prefix = session_match.group(1)

                # Parse embedded YAML data from subject line
                # Extract key fields directly since they're on one line
                yaml_data = {}

                # Extract tags: [#tag1, #tag2, ...]
                tags_match = re.search(r'tags:\s*\[(.*?)\]', subject)
                if tags_match:
                    tags_str = tags_match.group(1)
                    yaml_data['tags'] = [t.strip() for t in tags_str.split(',') if t.strip()]

                # Extract files: [file1, file2, ...]
                files_match = re.search(r'files:\s*\[(.*?)\]', subject)
                if files_match:
                    files_str = files_match.group(1)
                    yaml_data['files'] = [f.strip() for f in files_str.split(',') if f.strip()]

                # Extract summary from subject (comes after ---)
                summary_match = re.search(r'summary:\s*"([^"]*)"', subject)
                if summary_match:
                    yaml_data['summary'] = summary_match.group(1)

                # If there's a body, also try to parse YAML frontmatter from it
                if full_body:
                    body_yaml = parse_yaml_frontmatter(full_body)
                    # Merge, preferring body data
                    for k, v in body_yaml.items():
                        if v:  # Only use non-empty values
                            yaml_data[k] = v

                commit_data = {
                    "hash": commit_hash,
                    "subject": subject,
                    "date": date,
                    "body": full_body,
                    "yaml": yaml_data,
                }

                # Find full session ID
                full_session_id = None
                if sessions_dir.exists():
                    for sd in sessions_dir.iterdir():
                        if sd.name.startswith(session_id_prefix):
                            full_session_id = sd.name
                            break

                if not full_session_id:
                    full_session_id = session_id_prefix

                if full_session_id not in session_commits:
                    session_commits[full_session_id] = []
                session_commits[full_session_id].append(commit_data)

            except Exception as e:
                logger.debug(f"Failed to parse commit block: {e}")

        # Convert to SessionResult objects
        results = []
        project_name = get_project_display_name(project_path)

        for session_id, commits in session_commits.items():
            # Get latest commit for summary
            latest = commits[0] if commits else {}
            yaml_data = latest.get("yaml", {})

            # Extract tags from all commits
            all_tags = set()
            all_files = set()
            journey_entries = []
            decisions = []

            for c in commits:
                c_yaml = c.get("yaml", {})

                if c_yaml.get("tags"):
                    all_tags.update(c_yaml["tags"])
                if c_yaml.get("files"):
                    all_files.update(c_yaml["files"])
                if c_yaml.get("journey"):
                    for j in c_yaml["journey"]:
                        if j.get("summary"):
                            journey_entries.append(j["summary"])

            # Extract summary from body
            summary = yaml_data.get("summary") or self._extract_section(latest.get("body", ""), "Summary")

            # Load session metadata for enrichment
            meta = {}
            meta_file = sessions_dir / session_id / "meta.json"
            if meta_file.exists():
                try:
                    meta = json.loads(meta_file.read_text())
                except Exception:
                    pass

            shadow_meta = meta.get("shadow", {})

            # Calculate match score
            score, reasons = self._calculate_match_score(
                parsed,
                summary or "",
                list(all_tags),
                list(all_files),
                journey_entries,
                meta.get("name", "")
            )

            first_prompt = self._read_first_prompt(sessions_dir, session_id) if not summary else None

            result = SessionResult(
                session_id=session_id,
                project=project_name,
                project_path=project_path,
                name=meta.get("name"),
                created_at=meta.get("created_at"),
                last_activity=meta.get("last_activity"),
                message_count=meta.get("message_count", 0),
                total_cost=meta.get("total_cost", 0.0),
                forked_from=meta.get("forked_from"),
                is_comment_thread=meta.get("isCommentThread", False),
                summary=summary,
                first_prompt=first_prompt,
                tags=list(all_tags)[:10],
                files_changed=list(all_files)[:15],
                journey_snippet=journey_entries[-1] if journey_entries else None,
                turn_count=shadow_meta.get("turn_count", len(commits)),
                tools_summary=shadow_meta.get("tools_summary", {}),
                match_score=score,
                match_reasons=reasons,
            )

            results.append(result)

        return results

    def _extract_section(self, body: str, section: str) -> Optional[str]:
        """Extract a section from commit body (## Section)."""
        pattern = rf'## {section}\s*\n(.*?)(?:\n##|\n---|\Z)'
        match = re.search(pattern, body, re.DOTALL | re.IGNORECASE)
        if match:
            content = match.group(1).strip()
            # Get first non-empty line
            for line in content.split('\n'):
                line = line.strip()
                if line and not line.startswith('-') and not line.startswith('*'):
                    return line[:200]
        return None

    def _calculate_match_score(
        self,
        parsed: ParsedQuery,
        summary: str,
        tags: list[str],
        files: list[str],
        journey: list[str],
        name: str
    ) -> tuple[float, list[str]]:
        """Calculate relevance score and reasons."""

        score = 0.0
        reasons = []

        summary_lower = summary.lower()
        name_lower = name.lower()
        journey_text = " ".join(journey).lower()

        # Tag matches (high weight)
        for tag in parsed.tags:
            if tag in tags:
                score += 1.0
                reasons.append(f"Has {tag} tag")

        # Keyword matches in summary
        for kw in parsed.keywords:
            kw_lower = kw.lower()
            if kw_lower in summary_lower:
                score += 0.8
                reasons.append(f"Summary mentions '{kw}'")
            elif kw_lower in name_lower:
                score += 0.6
                reasons.append(f"Name contains '{kw}'")
            elif kw_lower in journey_text:
                score += 0.4
                reasons.append(f"Journey mentions '{kw}'")

        # File matches
        for f in parsed.files:
            f_lower = f.lower()
            for file in files:
                if f_lower in file.lower():
                    score += 0.7
                    reasons.append(f"Modified {file}")
                    break

        # Recency bonus (if no time filter, boost recent)
        if not parsed.time_filter:
            score += 0.1  # Small boost, actual ranking uses last_activity

        return score, reasons

    def _rank_results(
        self,
        results: list[SessionResult],
        parsed: ParsedQuery
    ) -> list[SessionResult]:
        """Rank results by relevance and recency."""

        def sort_key(r: SessionResult):
            # Primary: match score (higher is better)
            # Secondary: recency (more recent is better)
            recency = 0.0
            if r.last_activity:
                try:
                    dt = datetime.fromisoformat(r.last_activity.replace('Z', '+00:00'))
                    days_ago = (datetime.now(dt.tzinfo) - dt).days
                    recency = max(0, 30 - days_ago) / 30  # 0-1 based on last 30 days
                except Exception:
                    pass

            # If explicit query, prioritize match score
            # If browsing (no query), prioritize recency
            if parsed.keywords or parsed.tags:
                return (r.match_score * 2 + recency, recency)
            else:
                return (recency * 2 + r.match_score, r.match_score)

        return sorted(results, key=sort_key, reverse=True)

    def _generate_suggestions(
        self,
        parsed: ParsedQuery,
        results: list[SessionResult]
    ) -> list[str]:
        """Generate helpful search suggestions."""

        suggestions = []

        # If no results, suggest alternatives
        if not results:
            if parsed.tags:
                suggestions.append(f"Try searching without tags: {' '.join(parsed.keywords)}")
            if parsed.time_filter:
                suggestions.append("Try 'this month' for a wider time range")
            if not parsed.keywords:
                suggestions.append("Try adding keywords like 'auth', 'bug', 'feature'")

        # Suggest related queries based on results
        if results:
            # Collect common tags from results
            all_tags = set()
            for r in results[:5]:
                all_tags.update(r.tags)

            # Suggest unexplored tags
            searched_tags = set(parsed.tags)
            new_tags = all_tags - searched_tags
            if new_tags:
                tag = list(new_tags)[0]
                suggestions.append(f"Try: '{parsed.raw} {tag}'")

        # General suggestions
        if not parsed.time_filter:
            suggestions.append("Add 'yesterday' or 'last week' to filter by time")

        return suggestions[:3]


# ═══════════════════════════════════════════════════════════════════════════
# Session summaries (lightweight map for the quick-switcher drill-in)
# ═══════════════════════════════════════════════════════════════════════════

async def get_session_summaries(project_path: str, max_commits: int = 5000) -> dict[str, str]:
    """
    Map session_id → latest AI summary, parsed from shadow-git commit subjects.

    Much lighter than WelcomeSearcher: one `git log --format=%s` (subjects
    only, no bodies), simple regex extraction, newest commit per session wins.
    Sessions older than `max_commits` shadow commits simply get no summary —
    callers treat the summary as optional enrichment. Subjects-only log is
    ~30ms per 1000 commits, so the 5000 cap bounds the worst case at ~150ms.
    """
    shadow_dir = get_shadow_git_dir(project_path)
    if not shadow_dir.exists():
        return {}

    cmd = [
        "git", f"--git-dir={shadow_dir}",
        "log", "--format=%s", "-n", str(max_commits),
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode != 0:
            return {}
    except Exception as e:
        logger.debug(f"Session summary scan failed for {project_path}: {e}")
        return {}

    summaries: dict[str, str] = {}
    for subject in stdout.decode(errors="replace").splitlines():
        sid_match = re.search(r'session:\s*([A-Za-z0-9_-]+)', subject)
        if not sid_match:
            continue
        sid = sid_match.group(1)
        if sid in summaries:
            continue  # newest-first log — first hit is the latest summary
        # The turn-level summary is the LAST `summary: "…"` in the subject
        # (earlier ones belong to embedded journey entries).
        found = re.findall(r'summary:\s*"([^"]*)"', subject)
        if found and found[-1]:
            summaries[sid] = found[-1]
    return summaries


# ═══════════════════════════════════════════════════════════════════════════
# Recent Sessions (for welcome screen)
# ═══════════════════════════════════════════════════════════════════════════

async def get_recent_sessions(limit: int = 10) -> list[dict]:
    """
    Get recent sessions with enriched shadow git data.

    This powers the welcome screen's session list with rich metadata.
    """
    searcher = WelcomeSearcher()

    # Empty query = get all, sorted by recency
    result = await searcher.search("", limit=limit)

    return result["results"]


# ═══════════════════════════════════════════════════════════════════════════
# Singleton
# ═══════════════════════════════════════════════════════════════════════════

_searcher: Optional[WelcomeSearcher] = None

def get_welcome_searcher() -> WelcomeSearcher:
    """Get or create the welcome searcher singleton."""
    global _searcher
    if _searcher is None:
        _searcher = WelcomeSearcher()
    return _searcher
