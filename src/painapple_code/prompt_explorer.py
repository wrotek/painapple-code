"""
Prompt Explorer - Extract and search user prompts across all sessions

Provides efficient access to user prompts with rich metadata:
- Content and timestamp
- Session context (name, project)
- Response preview
- Word/character counts

Features:
- Full-text search across prompts
- Filter by project, date range, session
- Recent prompts for quick access (Ctrl+R)
- Prompt statistics and patterns

Search Syntax:
- `word1 word2`      → AND (both required)
- `"exact phrase"`   → Exact phrase match
- `-exclude`         → Exclude term
- `word1 OR word2`   → Either term
- `in:response`      → Search in Claude's responses
- `project:name`     → Filter by project name (partial match)
- `after:2026-01-15` → After date
- `before:2026-01-10`→ Before date
- `long:`            → Long prompts (>500 chars)
- `short:`           → Short prompts (<100 chars)
- `has:image`        → Prompts with images
- `session:id`       → Filter by session
"""

import json
import logging
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, List, Dict, Tuple, Set
from dataclasses import dataclass, asdict, field

from painapple_code import bridge_paths

logger = logging.getLogger("painapple-code.prompts")


# ═══════════════════════════════════════════════════════════════════════
# QUERY PARSER - Advanced search syntax
# ═══════════════════════════════════════════════════════════════════════

@dataclass
class ParsedQuery:
    """Parsed search query with structured components"""
    # Terms that MUST be present
    required_terms: List[str] = field(default_factory=list)
    # Terms that MUST NOT be present
    excluded_terms: List[str] = field(default_factory=list)
    # Groups of terms where at least one must match (OR groups)
    or_groups: List[List[str]] = field(default_factory=list)
    # Exact phrases that must appear
    exact_phrases: List[str] = field(default_factory=list)
    # Search in responses too
    search_response: bool = False
    # Project filter (partial match)
    project_filter: Optional[str] = None
    # Session filter
    session_filter: Optional[str] = None
    # Date filters
    after_date: Optional[datetime] = None
    before_date: Optional[datetime] = None
    # Length filters
    min_length: Optional[int] = None
    max_length: Optional[int] = None
    # Has image filter
    has_image: Optional[bool] = None
    # Has stash filter
    has_stash: Optional[bool] = None
    # Favorites filter
    favorites_only: bool = False
    # Original query for display
    original_query: str = ""
    # Active filters for UI display
    active_filters: List[Dict] = field(default_factory=list)

    def is_empty(self) -> bool:
        """Check if query has any search criteria"""
        return (
            not self.required_terms and
            not self.excluded_terms and
            not self.or_groups and
            not self.exact_phrases and
            not self.search_response and
            not self.project_filter and
            not self.session_filter and
            not self.after_date and
            not self.before_date and
            not self.min_length and
            not self.max_length and
            self.has_image is None and
            self.has_stash is None and
            not self.favorites_only
        )


class QueryParser:
    """
    Parse search queries into structured components.

    Supports:
    - Basic terms (AND by default): `word1 word2`
    - Exact phrases: `"exact phrase"`
    - Exclusion: `-word` or `NOT word`
    - OR groups: `word1 OR word2`
    - Field filters: `in:response`, `project:name`, `after:date`
    - Special filters: `long:`, `short:`, `has:image`
    """

    # Regex patterns
    QUOTED_PHRASE = re.compile(r'"([^"]+)"')
    FILTER_PATTERN = re.compile(r'(\w+):(\S+)')

    def parse(self, query: str) -> ParsedQuery:
        """Parse a search query string into structured components"""
        result = ParsedQuery(original_query=query)

        if not query or not query.strip():
            return result

        # Extract quoted phrases first
        phrases = self.QUOTED_PHRASE.findall(query)
        for phrase in phrases:
            result.exact_phrases.append(phrase)
            result.active_filters.append({
                "type": "phrase",
                "label": f'"{phrase}"',
                "value": phrase
            })

        # Remove quoted phrases from query
        query = self.QUOTED_PHRASE.sub('', query)

        # Extract field filters
        filters = self.FILTER_PATTERN.findall(query)
        for key, value in filters:
            self._apply_filter(result, key.lower(), value)

        # Remove filters from query
        query = self.FILTER_PATTERN.sub('', query)

        # Handle special keywords
        query = self._handle_special_keywords(query, result)

        # Split remaining query into tokens
        tokens = query.split()

        i = 0
        while i < len(tokens):
            token = tokens[i]

            # Handle exclusion (-term or NOT term)
            if token.startswith('-') and len(token) > 1:
                result.excluded_terms.append(token[1:].lower())
                result.active_filters.append({
                    "type": "exclude",
                    "label": f"-{token[1:]}",
                    "value": token[1:]
                })
            elif token.upper() == 'NOT' and i + 1 < len(tokens):
                result.excluded_terms.append(tokens[i + 1].lower())
                result.active_filters.append({
                    "type": "exclude",
                    "label": f"-{tokens[i + 1]}",
                    "value": tokens[i + 1]
                })
                i += 1
            # Handle OR
            elif token.upper() == 'OR' and i > 0 and i + 1 < len(tokens):
                # Look back for the OR group start
                prev_term = None
                if result.required_terms:
                    prev_term = result.required_terms.pop()
                    # Remove from active filters too
                    result.active_filters = [
                        f for f in result.active_filters
                        if not (f.get("type") == "term" and f.get("value") == prev_term)
                    ]

                # Collect OR group
                or_group = []
                if prev_term:
                    or_group.append(prev_term.lower())

                # Add next term
                i += 1
                if i < len(tokens):
                    next_term = tokens[i]
                    if not next_term.startswith('-') and next_term.upper() not in ('OR', 'NOT'):
                        or_group.append(next_term.lower())

                # Continue collecting OR terms
                while i + 2 < len(tokens) and tokens[i + 1].upper() == 'OR':
                    or_group.append(tokens[i + 2].lower())
                    i += 2

                if or_group:
                    result.or_groups.append(or_group)
                    result.active_filters.append({
                        "type": "or",
                        "label": " OR ".join(or_group),
                        "value": or_group
                    })
            # Regular term
            elif token and not token.startswith(':'):
                result.required_terms.append(token.lower())
                result.active_filters.append({
                    "type": "term",
                    "label": token,
                    "value": token.lower()
                })

            i += 1

        return result

    def _apply_filter(self, result: ParsedQuery, key: str, value: str):
        """Apply a field:value filter"""
        if key == 'in' and value.lower() == 'response':
            result.search_response = True
            result.active_filters.append({
                "type": "field",
                "label": "in:response",
                "value": "response"
            })

        elif key == 'project':
            result.project_filter = value
            result.active_filters.append({
                "type": "project",
                "label": f"project:{value}",
                "value": value
            })

        elif key == 'session':
            result.session_filter = value
            result.active_filters.append({
                "type": "session",
                "label": f"session:{value}",
                "value": value
            })

        elif key in ('after', 'since', 'from'):
            dt = self._parse_date_value(value)
            if dt:
                result.after_date = dt
                result.active_filters.append({
                    "type": "date",
                    "label": f"after:{value}",
                    "value": value
                })

        elif key in ('before', 'until', 'to'):
            dt = self._parse_date_value(value)
            if dt:
                result.before_date = dt
                result.active_filters.append({
                    "type": "date",
                    "label": f"before:{value}",
                    "value": value
                })

        elif key == 'has' and value.lower() in ('image', 'images', 'img'):
            result.has_image = True
            result.active_filters.append({
                "type": "field",
                "label": "has:image",
                "value": "image"
            })

        elif key == 'has' and value.lower() in ('stash', 'refs', 'context', 'comments'):
            result.has_stash = True
            result.active_filters.append({
                "type": "field",
                "label": "has:stash",
                "value": "stash"
            })

        elif key in ('chars', 'length', 'len'):
            # Handle chars>N, chars<N, chars:N
            if value.startswith('>'):
                try:
                    result.min_length = int(value[1:])
                    result.active_filters.append({
                        "type": "length",
                        "label": f"chars>{value[1:]}",
                        "value": result.min_length
                    })
                except ValueError:
                    pass
            elif value.startswith('<'):
                try:
                    result.max_length = int(value[1:])
                    result.active_filters.append({
                        "type": "length",
                        "label": f"chars<{value[1:]}",
                        "value": result.max_length
                    })
                except ValueError:
                    pass

    def _handle_special_keywords(self, query: str, result: ParsedQuery) -> str:
        """Handle special keywords like long:, short:"""
        from datetime import timezone
        now = datetime.now(timezone.utc).replace(tzinfo=None)  # Naive UTC

        # long: → chars > 500
        if 'long:' in query.lower():
            result.min_length = 500
            result.active_filters.append({
                "type": "length",
                "label": "long (>500 chars)",
                "value": 500
            })
            query = re.sub(r'\blong:\s*', '', query, flags=re.IGNORECASE)

        # short: → chars < 100
        if 'short:' in query.lower():
            result.max_length = 100
            result.active_filters.append({
                "type": "length",
                "label": "short (<100 chars)",
                "value": 100
            })
            query = re.sub(r'\bshort:\s*', '', query, flags=re.IGNORECASE)

        # today: → after today
        if 'today:' in query.lower():
            result.after_date = now.replace(hour=0, minute=0, second=0, microsecond=0)
            result.active_filters.append({
                "type": "date",
                "label": "today",
                "value": "today"
            })
            query = re.sub(r'\btoday:\s*', '', query, flags=re.IGNORECASE)

        # yesterday: → specific day
        if 'yesterday:' in query.lower():
            yesterday = now - timedelta(days=1)
            result.after_date = yesterday.replace(hour=0, minute=0, second=0, microsecond=0)
            result.before_date = now.replace(hour=0, minute=0, second=0, microsecond=0)
            result.active_filters.append({
                "type": "date",
                "label": "yesterday",
                "value": "yesterday"
            })
            query = re.sub(r'\byesterday:\s*', '', query, flags=re.IGNORECASE)

        # week: → last 7 days
        if 'week:' in query.lower():
            result.after_date = now - timedelta(days=7)
            result.active_filters.append({
                "type": "date",
                "label": "this week",
                "value": "week"
            })
            query = re.sub(r'\bweek:\s*', '', query, flags=re.IGNORECASE)

        # fav: or starred: or favorites: → favorites only
        fav_patterns = [r'\bfav:\s*', r'\bstarred:\s*', r'\bfavorites:\s*', r'\bfavourites:\s*']
        for pattern in fav_patterns:
            if re.search(pattern, query, re.IGNORECASE):
                result.favorites_only = True
                result.active_filters.append({
                    "type": "favorites",
                    "label": "favorites",
                    "value": True
                })
                query = re.sub(pattern, '', query, flags=re.IGNORECASE)
                break  # Only add filter once

        return query

    def _parse_date_value(self, value: str) -> Optional[datetime]:
        """Parse date value from filter - returns naive UTC datetime"""
        from datetime import timezone
        now = datetime.now(timezone.utc).replace(tzinfo=None)  # Naive UTC

        # Handle relative dates
        if value.lower() == 'today':
            return now.replace(hour=0, minute=0, second=0, microsecond=0)
        elif value.lower() == 'yesterday':
            return (now - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        elif value.lower() == 'week':
            return now - timedelta(days=7)
        elif value.lower() == 'month':
            return now - timedelta(days=30)

        # Handle YYYY-MM-DD (treat as UTC start of day)
        try:
            return datetime.strptime(value, "%Y-%m-%d")
        except ValueError:
            pass

        # Handle days ago: 3d, 7d
        match = re.match(r'^(\d+)d$', value)
        if match:
            days = int(match.group(1))
            return now - timedelta(days=days)

        return None


# Singleton query parser
_query_parser = QueryParser()


@dataclass
class Prompt:
    """A user prompt with metadata"""
    id: str                    # Unique ID: {session_id}:{line_number}
    content: str               # Prompt text
    timestamp: str             # ISO timestamp
    session_id: str            # Session ID
    session_name: str          # Session name/description
    project_path: str          # Project CWD
    project_hash: str          # Project hash
    response_preview: str      # First ~150 chars of Claude's response
    word_count: int            # Word count
    char_count: int            # Character count
    has_images: bool           # Whether prompt included images
    line_number: int           # Line number in messages.jsonl
    is_favorite: bool = False  # Whether prompt is favorited
    stash_refs: Optional[list] = None  # Stash items attached to this prompt

    def to_dict(self):
        d = asdict(self)
        # Only include stash_refs when present to keep responses lean
        if not d.get('stash_refs'):
            d.pop('stash_refs', None)
        return d


class PromptExtractor:
    """
    Extracts and indexes user prompts from session logs.

    Reads messages.jsonl files directly for efficiency.
    """

    def __init__(self):
        self._cache = {}  # session_id -> list of prompts
        self._cache_timestamps = {}  # session_id -> last_activity

    def get_all_prompts(
        self,
        project_hash: str = None,
        since: str = None,
        until: str = None,
        search_query: str = None,
        limit: int = 100,
        offset: int = 0,
    ) -> Tuple[List[Prompt], int, Optional[ParsedQuery]]:
        """
        Get all prompts with filtering and pagination.

        Args:
            project_hash: Filter by project
            since: Start date (ISO or YYYY-MM-DD)
            until: End date (ISO or YYYY-MM-DD)
            search_query: Full-text search with advanced syntax
            limit: Max prompts to return
            offset: Skip N prompts

        Returns:
            Tuple of (prompts, total_count, parsed_query)
        """
        # Parse the search query
        parsed_query = None
        if search_query:
            parsed_query = _query_parser.parse(search_query)

        # Merge explicit date params with query-parsed dates
        since_dt = self._parse_date(since) if since else None
        until_dt = self._parse_date(until) if until else None

        if parsed_query:
            if parsed_query.after_date and not since_dt:
                since_dt = parsed_query.after_date
            if parsed_query.before_date and not until_dt:
                until_dt = parsed_query.before_date

        # Merge project filter
        effective_project = project_hash
        if parsed_query and parsed_query.project_filter:
            effective_project = parsed_query.project_filter

        # Load favorites for marking
        favorite_ids = set(bridge_paths.get_all_prompt_favorites().keys())

        # Collect all prompts from all sessions
        all_prompts = []

        # Iterate all projects
        projects_dir = bridge_paths.BRIDGE_HOME / "projects"
        if not projects_dir.exists():
            return [], 0, parsed_query

        for project_dir in projects_dir.iterdir():
            if not project_dir.is_dir():
                continue

            hash_name = project_dir.name

            # Get project path for display
            path_file = project_dir / "path"
            project_path = path_file.read_text(encoding="utf-8").strip() if path_file.exists() else ""

            # Filter by project hash OR project path (partial match)
            if effective_project:
                hash_match = hash_name == effective_project or hash_name.startswith(effective_project)
                path_match = effective_project.lower() in project_path.lower()
                if not (hash_match or path_match):
                    continue

            sessions_dir = project_dir / "sessions"
            if not sessions_dir.exists():
                continue

            for session_dir in sessions_dir.iterdir():
                if not session_dir.is_dir():
                    continue

                session_id = session_dir.name

                # Filter by session if specified
                if parsed_query and parsed_query.session_filter:
                    if not session_id.startswith(parsed_query.session_filter):
                        continue

                # Load session meta
                meta_file = session_dir / "meta.json"
                if not meta_file.exists():
                    continue

                try:
                    meta = json.loads(meta_file.read_text(encoding="utf-8"))
                except (ValueError, OSError) as exc:
                    logger.debug("prompt search: skipping %s with unreadable meta: %s", session_id, exc)
                    continue

                session_name = meta.get("name") or meta.get("description") or ""

                # Extract prompts from this session
                prompts = self._extract_prompts_from_session(
                    session_dir=session_dir,
                    session_id=session_id,
                    session_name=session_name,
                    project_path=project_path,
                    project_hash=hash_name,
                    since_dt=since_dt,
                    until_dt=until_dt,
                    parsed_query=parsed_query,
                    favorite_ids=favorite_ids,
                )

                all_prompts.extend(prompts)

        # Filter by favorites if requested
        if parsed_query and parsed_query.favorites_only:
            all_prompts = [p for p in all_prompts if p.is_favorite]

        # Sort by timestamp (newest first)
        all_prompts.sort(key=lambda p: p.timestamp, reverse=True)

        total = len(all_prompts)

        # Apply pagination
        paginated = all_prompts[offset:offset + limit]

        return paginated, total, parsed_query

    def get_recent_prompts(
        self,
        limit: int = 20,
        project_hash: str = None,
        session_id: str = None,
    ) -> List[Prompt]:
        """
        Get most recent prompts (optimized for Ctrl+R quick access).

        Args:
            limit: Max prompts
            project_hash: Filter by project
            session_id: Filter by specific session

        Returns:
            List of recent prompts
        """
        prompts, _, _ = self.get_all_prompts(
            project_hash=project_hash,
            limit=limit,
            offset=0,
        )

        # Filter by session if specified
        if session_id:
            prompts = [p for p in prompts if p.session_id == session_id]

        return prompts[:limit]

    def get_frequent_prompts(
        self,
        limit: int = 10,
        min_similarity: float = 0.8,
    ) -> List[Dict]:
        """
        Get frequently used prompts (similar prompts grouped).

        Returns prompts that appear multiple times with slight variations.
        Uses simple word-based similarity.
        """
        prompts, _, _ = self.get_all_prompts(limit=500)  # Analyze recent prompts

        # Group similar prompts
        groups = []
        used = set()

        for i, prompt in enumerate(prompts):
            if i in used:
                continue

            similar = [prompt]
            words1 = set(prompt.content.lower().split())

            for j, other in enumerate(prompts[i+1:], i+1):
                if j in used:
                    continue

                words2 = set(other.content.lower().split())

                # Jaccard similarity
                if words1 and words2:
                    intersection = len(words1 & words2)
                    union = len(words1 | words2)
                    similarity = intersection / union if union > 0 else 0

                    if similarity >= min_similarity:
                        similar.append(other)
                        used.add(j)

            if len(similar) >= 2:
                # Return the shortest (most canonical) version
                canonical = min(similar, key=lambda p: len(p.content))
                groups.append({
                    "prompt": canonical.to_dict(),
                    "count": len(similar),
                    "variations": [p.to_dict() for p in similar[:5]]  # Limit variations
                })

        # Sort by count
        groups.sort(key=lambda g: g["count"], reverse=True)
        return groups[:limit]

    def get_prompt_stats(self, project_hash: str = None) -> Dict:
        """
        Get statistics about prompts.

        Returns:
            Dict with counts, averages, time distribution, etc.
        """
        prompts, total, _ = self.get_all_prompts(
            project_hash=project_hash,
            limit=10000,  # Get all for stats
        )

        if not prompts:
            return {
                "total_prompts": 0,
                "avg_word_count": 0,
                "avg_char_count": 0,
                "prompts_with_images": 0,
                "unique_sessions": 0,
                "unique_projects": 0,
                "by_day": {},
                "by_hour": {},
            }

        # Calculate stats
        total_words = sum(p.word_count for p in prompts)
        total_chars = sum(p.char_count for p in prompts)
        with_images = sum(1 for p in prompts if p.has_images)
        with_stash = sum(1 for p in prompts if p.stash_refs)
        unique_sessions = len(set(p.session_id for p in prompts))
        unique_projects = len(set(p.project_hash for p in prompts))

        # Distribution by day of week
        by_day = {}
        by_hour = {}
        for p in prompts:
            try:
                dt = datetime.fromisoformat(p.timestamp.replace("Z", "+00:00"))
                day_name = dt.strftime("%A")
                hour = dt.hour

                by_day[day_name] = by_day.get(day_name, 0) + 1
                by_hour[hour] = by_hour.get(hour, 0) + 1
            except (ValueError, AttributeError) as exc:
                logger.debug("prompt stats: skipping malformed timestamp %r: %s", p.timestamp, exc)

        return {
            "total_prompts": total,
            "avg_word_count": round(total_words / len(prompts), 1) if prompts else 0,
            "avg_char_count": round(total_chars / len(prompts), 1) if prompts else 0,
            "prompts_with_images": with_images,
            "prompts_with_stash": with_stash,
            "unique_sessions": unique_sessions,
            "unique_projects": unique_projects,
            "by_day": by_day,
            "by_hour": by_hour,
        }

    def search_prompts(
        self,
        query: str,
        project_hash: str = None,
        limit: int = 50,
    ) -> Tuple[List[Prompt], Optional[ParsedQuery]]:
        """
        Search prompts by content with advanced query syntax.

        Args:
            query: Search string with advanced syntax
            project_hash: Filter by project
            limit: Max results

        Returns:
            Tuple of (matching prompts, parsed query)
        """
        prompts, _, parsed = self.get_all_prompts(
            project_hash=project_hash,
            search_query=query,
            limit=limit,
        )
        return prompts, parsed

    def get_full_response(self, prompt_id: str) -> Optional[str]:
        """Get the full Claude response for a given prompt_id.

        prompt_id format: '{session_id}:{line_number}'

        Returns concatenated text of all string-content assistant messages
        between this user message and the next user message in messages.jsonl.
        Returns None if the session/prompt cannot be found.
        """
        try:
            session_id, line_str = prompt_id.rsplit(":", 1)
            line_number = int(line_str)
        except (ValueError, AttributeError):
            return None

        projects_dir = bridge_paths.BRIDGE_HOME / "projects"
        if not projects_dir.exists():
            return None

        messages_file = None
        for project_dir in projects_dir.iterdir():
            if not project_dir.is_dir():
                continue
            candidate = project_dir / "sessions" / session_id / "messages.jsonl"
            if candidate.exists():
                messages_file = candidate
                break

        if not messages_file:
            return None

        parts: List[str] = []
        try:
            with open(messages_file, "r", encoding="utf-8") as f:
                for ln, line in enumerate(f, 1):
                    if ln <= line_number:
                        continue
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        msg = json.loads(line)
                    except ValueError:
                        continue
                    role = msg.get("role")
                    if role == "user":
                        break
                    if role == "assistant":
                        content = msg.get("content", "")
                        if isinstance(content, str) and content:
                            parts.append(content)
        except OSError as exc:
            logger.debug("get_full_response: %s unreadable: %s", messages_file, exc)
            return None

        return "\n\n".join(parts) if parts else None

    def _extract_prompts_from_session(
        self,
        session_dir: Path,
        session_id: str,
        session_name: str,
        project_path: str,
        project_hash: str,
        since_dt: datetime = None,
        until_dt: datetime = None,
        parsed_query: ParsedQuery = None,
        favorite_ids: Set[str] = None,
    ) -> List[Prompt]:
        """Extract user prompts from a session's messages.jsonl"""

        messages_file = session_dir / "messages.jsonl"
        if not messages_file.exists():
            return []

        prompts = []

        try:
            with open(messages_file, 'r', encoding="utf-8") as f:
                lines = f.readlines()

            # First pass: collect user messages
            user_messages = []
            for line_num, line in enumerate(lines, 1):
                line = line.strip()
                if not line:
                    continue

                try:
                    msg = json.loads(line)
                except ValueError:
                    continue

                role = msg.get("role")
                if role == "user":
                    user_messages.append((line_num, msg))
                elif role == "assistant" and user_messages:
                    # Attach response preview to last user message
                    last_line, last_msg = user_messages[-1]
                    content = msg.get("content", "")
                    if isinstance(content, str) and content:
                        last_msg["_response_preview"] = content[:150] + ("..." if len(content) > 150 else "")

            # Second pass: convert to Prompt objects
            for line_num, msg in user_messages:
                content = msg.get("content", "")
                if not isinstance(content, str):
                    continue

                timestamp = msg.get("timestamp", "")
                response_preview = msg.get("_response_preview", "")
                has_images = msg.get("has_images", False) or msg.get("image_count", 0) > 0
                stash_refs = msg.get("stashRefs") or None
                char_count = len(content)

                # Apply date filters
                if since_dt or until_dt:
                    try:
                        # Parse timestamp and convert to naive UTC for comparison
                        msg_dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                        msg_dt_naive = msg_dt.replace(tzinfo=None)  # Strip timezone
                        if since_dt and msg_dt_naive < since_dt:
                            continue
                        if until_dt and msg_dt_naive > until_dt:
                            continue
                    except (ValueError, AttributeError):
                        pass

                # Apply parsed query filters
                if parsed_query and not self._matches_query(
                    content, response_preview, char_count, has_images, bool(stash_refs), parsed_query
                ):
                    continue

                # Create Prompt object
                prompt_id = f"{session_id}:{line_num}"
                prompt = Prompt(
                    id=prompt_id,
                    content=content,
                    timestamp=timestamp,
                    session_id=session_id,
                    session_name=session_name,
                    project_path=project_path,
                    project_hash=project_hash,
                    response_preview=response_preview,
                    word_count=len(content.split()),
                    char_count=char_count,
                    has_images=has_images,
                    line_number=line_num,
                    is_favorite=prompt_id in (favorite_ids or set()),
                    stash_refs=stash_refs,
                )
                prompts.append(prompt)

        except Exception as e:
            logger.error(f"Error extracting prompts from {session_id}: {e}")

        return prompts

    def _matches_query(
        self,
        content: str,
        response: str,
        char_count: int,
        has_images: bool,
        has_stash: bool,
        query: ParsedQuery,
    ) -> bool:
        """Check if content matches the parsed query"""

        if query.is_empty():
            return True

        content_lower = content.lower()
        response_lower = response.lower() if response else ""

        # Combine search targets based on in:response flag
        search_text = content_lower
        if query.search_response:
            search_text = content_lower + " " + response_lower

        # Check required terms (AND)
        for term in query.required_terms:
            if term not in search_text:
                return False

        # Check excluded terms (NOT)
        for term in query.excluded_terms:
            if term in search_text:
                return False

        # Check OR groups (at least one must match)
        for or_group in query.or_groups:
            if not any(term in search_text for term in or_group):
                return False

        # Check exact phrases
        for phrase in query.exact_phrases:
            if phrase.lower() not in search_text:
                return False

        # Check length filters
        if query.min_length is not None and char_count < query.min_length:
            return False
        if query.max_length is not None and char_count > query.max_length:
            return False

        # Check has_image filter
        if query.has_image is not None:
            if query.has_image and not has_images:
                return False

        # Check has_stash filter
        if query.has_stash is not None:
            if query.has_stash and not has_stash:
                return False

        return True

    def _parse_date(self, date_str: str) -> Optional[datetime]:
        """Parse date string (ISO or YYYY-MM-DD)"""
        if not date_str:
            return None
        try:
            # Try ISO format first
            if "T" in date_str:
                return datetime.fromisoformat(date_str.replace("Z", "+00:00"))
            # Try YYYY-MM-DD
            return datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=None)
        except ValueError:
            return None


# Singleton instance
_extractor = None


def get_prompt_extractor() -> PromptExtractor:
    """Get or create the singleton prompt extractor"""
    global _extractor
    if _extractor is None:
        _extractor = PromptExtractor()
    return _extractor
