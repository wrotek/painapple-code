"""
Shadow Git Commit Parser - Extracts structured data from shadow git commits.

Parses:
- YAML frontmatter (session, turn, tags, files, tools, cost, journey)
- Markdown sections (Summary, Decisions, Problems, Learnings, etc.)

Used by History Explorer to display rich commit data.
"""

import re
from dataclasses import dataclass, field
from datetime import datetime

# Import YAML parser from shadow_git
from painapple_code.shadow_git import parse_yaml_frontmatter, YAML_FRONTMATTER_PATTERN


# Section headers we extract from commit bodies
SECTION_HEADERS = [
    'Summary',
    'Tags',
    'Work Done',
    'Decisions',
    'Problems Solved',
    'Files',
    'Tools Used',
    'Context for Resume',
    'Learnings',
    'Session Title',
    # Tool-only commits
    'Investigation',
    'Findings',
]


@dataclass
class ParsedCommit:
    """
    Fully parsed shadow git commit.
    """
    # Git metadata
    hash: str
    hash_short: str
    timestamp: datetime

    # From YAML frontmatter
    session_id: str = ""
    turn: int = 0
    tags: list = field(default_factory=list)
    files: list = field(default_factory=list)
    tools: list = field(default_factory=list)
    cost: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0
    project_ref: str = ""  # Link to project's actual git
    journey: list = field(default_factory=list)  # Previous turns' summaries
    summary: str = ""  # One-liner for this turn

    # Extracted sections
    sections: dict = field(default_factory=dict)

    # Raw data
    subject: str = ""  # First line
    body: str = ""     # Rest of commit message

    def to_dict(self) -> dict:
        """Convert to JSON-serializable dict."""
        return {
            'hash': self.hash,
            'hashShort': self.hash_short,
            'timestamp': self.timestamp.isoformat() if self.timestamp else None,
            'sessionId': self.session_id,
            'turn': self.turn,
            'tags': self.tags,
            'files': self.files,
            'tools': self.tools,
            'cost': self.cost,
            'tokensIn': self.tokens_in,
            'tokensOut': self.tokens_out,
            'projectRef': self.project_ref,
            'journey': self.journey,
            'summary': self.summary,
            'sections': self.sections,
            'subject': self.subject,
            'body': self.body,
        }


def extract_sections(text: str) -> dict:
    """
    Extract markdown sections from commit body.

    Args:
        text: Commit message body (after YAML frontmatter)

    Returns:
        Dict mapping section name to content
    """
    sections = {}

    # Split into lines for processing
    lines = text.split('\n')
    current_section = None
    current_content = []

    for line in lines:
        # Check if this is a section header
        header_match = re.match(r'^##\s+(.+?)\s*$', line)

        if header_match:
            # Save previous section
            if current_section:
                sections[current_section] = '\n'.join(current_content).strip()

            # Start new section
            current_section = header_match.group(1)
            current_content = []
        elif current_section:
            current_content.append(line)

    # Save last section
    if current_section:
        sections[current_section] = '\n'.join(current_content).strip()

    return sections


def parse_subject_line(subject: str) -> tuple[str, int, str]:
    """
    Parse the commit subject line to extract session ID and turn number.

    Format: "[session_id] Turn N: description"

    Returns:
        (session_id, turn_number, description)
    """
    session_id = ""
    turn_num = 0
    description = subject

    # Extract session ID from [brackets]
    session_match = re.match(r'^\[([^\]]+)\]', subject)
    if session_match:
        session_id = session_match.group(1)
        description = subject[session_match.end():].strip()

    # Extract turn number
    turn_match = re.match(r'^Turn\s+(\d+):\s*(.*)$', description)
    if turn_match:
        turn_num = int(turn_match.group(1))
        description = turn_match.group(2)

    return session_id, turn_num, description


def parse_commit_message(
    full_message: str,
    hash_full: str = "",
    hash_short: str = "",
    timestamp: int = 0
) -> ParsedCommit:
    """
    Parse a full commit message into structured data.

    Args:
        full_message: Complete commit message (subject + body)
        hash_full: Full commit hash
        hash_short: Short commit hash (7-8 chars)
        timestamp: Unix timestamp

    Returns:
        ParsedCommit with all extracted data
    """
    # Split into subject and body
    lines = full_message.split('\n')

    # Subject might be after YAML frontmatter
    subject = ""
    body_start = 0

    # Check for YAML frontmatter
    yaml_match = YAML_FRONTMATTER_PATTERN.match(full_message)
    if yaml_match:
        # Skip frontmatter to find subject
        after_yaml = full_message[yaml_match.end():]
        after_lines = after_yaml.split('\n')
        for i, line in enumerate(after_lines):
            if line.strip():
                subject = line.strip()
                body_start = i + 1
                break
        body = '\n'.join(after_lines[body_start:])
        yaml_data = parse_yaml_frontmatter(full_message)
    else:
        # No frontmatter - first line is subject
        subject = lines[0] if lines else ""
        body = '\n'.join(lines[1:]) if len(lines) > 1 else ""
        yaml_data = {}

    # Parse subject line
    session_from_subject, turn_from_subject, description = parse_subject_line(subject)

    # Parse timestamp
    ts = datetime.fromtimestamp(timestamp) if timestamp else datetime.now()

    # Extract sections from body
    sections = extract_sections(body)

    # Build parsed commit
    commit = ParsedCommit(
        hash=hash_full,
        hash_short=hash_short or (hash_full[:8] if hash_full else ""),
        timestamp=ts,
        session_id=yaml_data.get('session', session_from_subject),
        turn=yaml_data.get('turn', turn_from_subject),
        tags=yaml_data.get('tags', []),
        files=yaml_data.get('files', []),
        tools=yaml_data.get('tools', []),
        cost=yaml_data.get('cost', 0.0),
        tokens_in=yaml_data.get('tokens_in', 0),
        tokens_out=yaml_data.get('tokens_out', 0),
        project_ref=yaml_data.get('project_ref', ''),
        journey=yaml_data.get('journey', []),
        summary=yaml_data.get('summary', sections.get('Summary', description)),
        sections=sections,
        subject=subject,
        body=body,
    )

    # If tags weren't in YAML, try to extract from Tags section
    if not commit.tags and 'Tags' in sections:
        tag_matches = re.findall(r'#\w+', sections['Tags'])
        commit.tags = tag_matches

    return commit


def parse_diff_output(diff_text: str) -> dict:
    """
    Parse git diff output into structured format.

    Args:
        diff_text: Raw output from git show/diff

    Returns:
        Structured diff with files, hunks, lines
    """
    result = {
        'files': [],
        'stats': {
            'total_additions': 0,
            'total_deletions': 0,
            'files_changed': 0,
        }
    }

    if not diff_text:
        return result

    current_file = None
    current_hunk = None

    lines = diff_text.split('\n')
    i = 0

    while i < len(lines):
        line = lines[i]

        # New file
        if line.startswith('diff --git'):
            # Save previous file
            if current_file:
                if current_hunk:
                    current_file['hunks'].append(current_hunk)
                result['files'].append(current_file)

            # Parse file path
            parts = line.split(' b/')
            file_path = parts[-1] if len(parts) > 1 else ''

            current_file = {
                'path': file_path,
                'status': 'modified',
                'additions': 0,
                'deletions': 0,
                'hunks': [],
            }
            current_hunk = None

        # File status
        elif line.startswith('new file'):
            if current_file:
                current_file['status'] = 'added'
        elif line.startswith('deleted file'):
            if current_file:
                current_file['status'] = 'deleted'
        elif line.startswith('rename from'):
            if current_file:
                current_file['status'] = 'renamed'
                current_file['oldPath'] = line[12:]

        # Hunk header
        elif line.startswith('@@'):
            # Save previous hunk
            if current_hunk and current_file:
                current_file['hunks'].append(current_hunk)

            current_hunk = {
                'header': line,
                'lines': [],
            }

        # Diff line
        elif current_hunk is not None:
            if line.startswith('+') and not line.startswith('+++'):
                current_hunk['lines'].append({'type': 'add', 'content': line[1:]})
                if current_file:
                    current_file['additions'] += 1
                    result['stats']['total_additions'] += 1
            elif line.startswith('-') and not line.startswith('---'):
                current_hunk['lines'].append({'type': 'del', 'content': line[1:]})
                if current_file:
                    current_file['deletions'] += 1
                    result['stats']['total_deletions'] += 1
            elif line.startswith(' ') or line == '':
                current_hunk['lines'].append({'type': 'context', 'content': line[1:] if line else ''})

        i += 1

    # Save last file/hunk
    if current_file:
        if current_hunk:
            current_file['hunks'].append(current_hunk)
        result['files'].append(current_file)

    result['stats']['files_changed'] = len(result['files'])

    return result


def search_commits(
    commits: list[dict],
    query: str = "",
    tags: list[str] = None,
    files: list[str] = None,
    session_id: str = None,
) -> list[dict]:
    """
    Filter and search parsed commits.

    Args:
        commits: List of parsed commit dicts
        query: Text search in summary, subject, sections
        tags: Filter by tags (any match)
        files: Filter by files (any match)
        session_id: Filter by session

    Returns:
        Filtered list of commits
    """
    results = []

    query_lower = query.lower() if query else ""
    tags_set = set(t.lower().lstrip('#') for t in (tags or []))
    files_set = set(files or [])

    for commit in commits:
        # Session filter
        if session_id and commit.get('sessionId', '')[:8] != session_id[:8]:
            continue

        # Tag filter
        if tags_set:
            commit_tags = set(t.lower().lstrip('#') for t in commit.get('tags', []))
            if not tags_set & commit_tags:
                continue

        # File filter
        if files_set:
            commit_files = set(commit.get('files', []))
            if not any(any(f in cf for cf in commit_files) for f in files_set):
                continue

        # Text search
        if query_lower:
            searchable = ' '.join([
                commit.get('summary', ''),
                commit.get('subject', ''),
                commit.get('body', ''),
                ' '.join(commit.get('tags', [])),
            ]).lower()

            if query_lower not in searchable:
                continue

        results.append(commit)

    return results


def extract_decisions(commits: list[dict]) -> list[dict]:
    """
    Extract all Decisions sections from commits.

    Returns:
        List of {commit_hash, turn, session, date, content, tags}
    """
    decisions = []

    for commit in commits:
        sections = commit.get('sections', {})
        content = sections.get('Decisions', '')

        if content:
            decisions.append({
                'commitHash': commit.get('hashShort', ''),
                'turn': commit.get('turn', 0),
                'sessionId': commit.get('sessionId', ''),
                'date': commit.get('timestamp', ''),
                'content': content,
                'tags': commit.get('tags', []),
                'summary': commit.get('summary', ''),
            })

    return decisions


def extract_problems(commits: list[dict]) -> list[dict]:
    """
    Extract all Problems Solved sections from commits.
    """
    problems = []

    for commit in commits:
        sections = commit.get('sections', {})
        content = sections.get('Problems Solved', '')

        if content:
            problems.append({
                'commitHash': commit.get('hashShort', ''),
                'turn': commit.get('turn', 0),
                'sessionId': commit.get('sessionId', ''),
                'date': commit.get('timestamp', ''),
                'content': content,
                'tags': commit.get('tags', []),
                'files': commit.get('files', []),
                'summary': commit.get('summary', ''),
            })

    return problems


def extract_learnings(commits: list[dict]) -> list[dict]:
    """
    Extract all Learnings sections from commits.
    """
    learnings = []

    for commit in commits:
        sections = commit.get('sections', {})
        content = sections.get('Learnings', '')

        if content:
            learnings.append({
                'commitHash': commit.get('hashShort', ''),
                'turn': commit.get('turn', 0),
                'sessionId': commit.get('sessionId', ''),
                'date': commit.get('timestamp', ''),
                'content': content,
                'tags': commit.get('tags', []),
                'summary': commit.get('summary', ''),
            })

    return learnings


def group_by_session(commits: list[dict]) -> list[dict]:
    """
    Group commits by session for Timeline view.

    Handles backwards compatibility: old commits have 8-char truncated IDs
    in subject line, new commits have full 11-char IDs in YAML. These are
    merged into a single session using the longer (canonical) ID.

    Returns:
        List of session groups with commits
    """
    sessions = {}

    def find_matching_session(session_id: str) -> str | None:
        """Find existing session that matches by prefix (handles old 8-char vs new 11-char IDs)."""
        for existing_id in sessions:
            # Check if one is prefix of the other (same logical session)
            if existing_id.startswith(session_id) or session_id.startswith(existing_id):
                return existing_id
        return None

    for commit in commits:
        session_id = commit.get('sessionId', 'unknown')

        # Check if this session matches an existing one (prefix matching for backwards compat)
        existing_id = find_matching_session(session_id)

        if existing_id:
            # Use the longer ID as canonical (upgrade 8-char to 11-char)
            canonical_id = session_id if len(session_id) > len(existing_id) else existing_id

            if canonical_id != existing_id:
                # Upgrade: rename session to longer ID
                sessions[canonical_id] = sessions.pop(existing_id)
                sessions[canonical_id]['sessionId'] = canonical_id

            session_id = canonical_id
        elif session_id not in sessions:
            sessions[session_id] = {
                'sessionId': session_id,
                'title': '',  # Will be set from Session Title section
                'commits': [],
                'turnCount': 0,
                'totalCost': 0.0,
                'files': set(),
                'tags': set(),
                'firstTimestamp': None,
                'lastTimestamp': None,
            }

        group = sessions[session_id]
        group['commits'].append(commit)
        group['turnCount'] += 1
        group['totalCost'] += commit.get('cost', 0)
        group['files'].update(commit.get('files', []))
        group['tags'].update(commit.get('tags', []))

        # Track timestamps
        ts = commit.get('timestamp')
        if ts:
            if not group['firstTimestamp'] or ts < group['firstTimestamp']:
                group['firstTimestamp'] = ts
            if not group['lastTimestamp'] or ts > group['lastTimestamp']:
                group['lastTimestamp'] = ts

        # Get session title from latest commit
        sections = commit.get('sections', {})
        if 'Session Title' in sections:
            group['title'] = sections['Session Title']

    # Convert sets to lists and sort
    result = []
    for group in sessions.values():
        group['files'] = sorted(group['files'])
        group['tags'] = sorted(group['tags'])
        # Sort commits by turn number
        group['commits'].sort(key=lambda c: c.get('turn', 0), reverse=True)
        result.append(group)

    # Sort sessions by last timestamp (most recent first)
    result.sort(key=lambda g: g.get('lastTimestamp', ''), reverse=True)

    return result
