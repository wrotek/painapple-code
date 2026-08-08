"""
Shadow Git - File recovery & session history using a separate git repository.

Tracks all file changes and tool usage during Claude sessions with turn-by-turn
recovery. Each turn creates a commit on a shadow branch that mirrors the project's
current git branch (e.g., project's `main` -> shadow's `shadow/main`).

Storage: ~/.painapple-code/projects/{hash}/shadow-git/
Branches: shadow/main, shadow/feature-x, etc. (mirrors project branches)

Key features:
- Per-turn commits with tool tracking
- Co-modification tracking (multiple sessions editing same files)
- Rich commit messages via summary fork (optional)
- Session archiving via annotated tags
- Undo/redo support

This file holds the public `ShadowGit` class plus the singleton accessor and
`get_commit_sections_for_api`. The big subsystems live in sibling modules:
- `shadow_git_sections` — `BUILTIN_SECTIONS`, schema/prompt/markdown helpers
- `shadow_git_frontmatter` — `CostInfo`/`SummaryCost`, YAML parser/formatter, extractors
- `shadow_git_summary` — `_SummaryMixin` with the rich-commit fork machinery
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from painapple_code.bridge_paths import (
    get_shadow_git_dir,
    get_project_dir,
    get_sessions_dir,
    ensure_project_dir,
    load_project_config,
    get_summary_model,
)
from painapple_code.turn_tracker import TurnTracker
from painapple_code.utils.file_lock import FileLock

# Public re-exports — kept under shadow_git.* so downstream importers
# (services/, routes/, shadow_parser.py, welcome_search.py) don't change.
from painapple_code.shadow_git_frontmatter import (
    CostInfo,
    SummaryCost,
    YAML_FRONTMATTER_PATTERN,
    extract_session_title,
    extract_summary_line,
    format_yaml_frontmatter,
    parse_yaml_frontmatter,
)
from painapple_code.shadow_git_sections import (
    BUILTIN_SECTIONS,
    COMMIT_PROMPT_COMPACTION,
    get_sections_config,
)
from painapple_code.shadow_git_summary import _SummaryMixin

__all__ = [
    "ShadowGit",
    "get_shadow_git",
    "get_commit_sections_for_api",
    "BUILTIN_SECTIONS",
    "CostInfo",
    "SummaryCost",
    "parse_yaml_frontmatter",
    "YAML_FRONTMATTER_PATTERN",
]

logger = logging.getLogger("painapple-code.shadow-git")


# ═══════════════════════════════════════════════════════════════════════════
# Default exclude patterns
# ═══════════════════════════════════════════════════════════════════════════

DEFAULT_EXCLUDES = """
# Dependencies
node_modules/
.venv/
venv/
__pycache__/
.npm/
.cache/

# Build outputs
dist/
build/
out/
*.egg-info/

# Environment
.env
.env.*
*.local

# Logs
*.log
logs/

# IDE
.idea/
.vscode/
*.swp
*.swo

# Git
.git/

# OS
.DS_Store
Thumbs.db

# VM / disk images and other huge binary artifacts
*.img
*.qcow2
*.vmdk
*.vdi
*.vhd
*.vhdx
*.iso
*.fd
*.dmg
"""

# Files larger than this are never committed to shadow git. Oversized files
# are unstaged after `git add -A` and appended to info/exclude (quarantined).
# Override per project via config: shadow_git.max_file_size_mb (0 disables).
DEFAULT_MAX_FILE_SIZE_MB = 50


def _escape_exclude_pattern(path: str) -> str:
    """Escape glob metacharacters so a literal path is safe as a gitignore pattern."""
    return "".join("\\" + ch if ch in "\\*?[]!#" else ch for ch in path)


class ShadowGit(_SummaryMixin):
    """
    Manages shadow git repository for a project.

    Usage:
        shadow = ShadowGit("/path/to/project")
        await shadow.init_repo()
        await shadow.commit_turn(session_id, turn_num, tracker, cost_info)
    """

    def __init__(self, project_path: str):
        """
        Initialize ShadowGit for a project.

        Args:
            project_path: Path to the project directory (the working tree)
        """
        self.project_path = Path(project_path).resolve()
        self.project_dir = get_project_dir(str(self.project_path))
        self.git_dir = get_shadow_git_dir(str(self.project_path))
        self.tracking_file = self.project_dir / "active-modifications.json"
        self.config = load_project_config(str(self.project_path))

    def reload_config(self):
        """
        Reload configuration from disk.

        Call this before operations to pick up config changes made via UI.
        """
        self.config = load_project_config(str(self.project_path))

    @property
    def is_enabled(self) -> bool:
        """
        Check if shadow git is enabled for this project.

        Returns:
            True if enabled (default), False if explicitly disabled
        """
        return self.config.get("shadow_git", {}).get("enabled", True)

    @property
    def is_rich_commits_enabled(self) -> bool:
        """
        Check if rich commits (summary fork) are enabled for this project.

        Returns:
            True if rich commits enabled, False otherwise
        """
        return self.config.get("shadow_git", {}).get("rich_commits", False)

    @property
    def max_file_size_mb(self) -> float:
        """
        Size cap for files committed to shadow git, in MB.

        Files larger than this are quarantined (unstaged + excluded).
        0 or negative disables the cap.
        """
        return self.config.get("shadow_git", {}).get(
            "max_file_size_mb", DEFAULT_MAX_FILE_SIZE_MB
        )

    def _ensure_excludes(self):
        """
        Sync info/exclude with the current DEFAULT_EXCLUDES.

        The exclude file is otherwise only written at init time, so shipped
        updates to DEFAULT_EXCLUDES would never reach existing repos. Rewrite
        the default block while preserving extra lines (manual additions and
        size-cap quarantine entries).
        """
        try:
            exclude_file = self.git_dir / "info" / "exclude"
            exclude_file.parent.mkdir(parents=True, exist_ok=True)
            existing = exclude_file.read_text() if exclude_file.exists() else ""
            default_lines = set(DEFAULT_EXCLUDES.splitlines())
            extras = [
                line for line in existing.splitlines()
                if line.strip()
                and not line.lstrip().startswith("#")
                and line not in default_lines
            ]
            content = DEFAULT_EXCLUDES
            if extras:
                content += "\n# Auto-excluded / project-specific\n" + "\n".join(extras) + "\n"
            if content != existing:
                exclude_file.write_text(content)
        except OSError as e:
            logger.warning(f"Failed to sync shadow git excludes: {e}")

    def _add_excludes(self, paths: list[str], reason: str = ""):
        """Append literal path excludes to info/exclude (skips already-present)."""
        try:
            exclude_file = self.git_dir / "info" / "exclude"
            exclude_file.parent.mkdir(parents=True, exist_ok=True)
            existing = exclude_file.read_text() if exclude_file.exists() else ""
            existing_lines = set(existing.splitlines())
            new_lines = [
                pattern for pattern in
                ("/" + _escape_exclude_pattern(p) for p in paths)
                if pattern not in existing_lines
            ]
            if not new_lines:
                return
            block = "" if (not existing or existing.endswith("\n")) else "\n"
            if reason:
                block += f"# Auto-excluded ({reason})\n"
            block += "\n".join(new_lines) + "\n"
            exclude_file.write_text(existing + block)
        except OSError as e:
            logger.warning(f"Failed to update shadow git excludes: {e}")

    async def _quarantine_oversized(self) -> list[str]:
        """
        Unstage and permanently exclude staged files over the size cap.

        Runs right after `git add -A`. Oversized files are removed from the
        index (`git rm --cached`, working tree untouched) and appended to
        info/exclude so they are never staged again — this also untracks
        previously-committed huge files so they stop churning new blobs.

        Returns:
            List of quarantined relative paths.
        """
        max_mb = self.max_file_size_mb
        if not max_mb or max_mb <= 0:
            return []
        max_bytes = int(max_mb * 1024 * 1024)

        # On an unborn branch (initial snapshot) HEAD doesn't exist yet —
        # everything staged is new, so sweep the whole index instead.
        _, _, head_rc = await self._run(
            ["rev-parse", "--verify", "--quiet", "HEAD"], check=False
        )
        if head_rc == 0:
            stdout, _, rc = await self._run(
                ["diff", "--cached", "--name-only", "--diff-filter=AM", "-z"],
                check=False,
            )
        else:
            stdout, _, rc = await self._run(["ls-files", "--cached", "-z"], check=False)
        if rc != 0 or not stdout:
            return []

        oversized: list[str] = []
        for rel_path in stdout.split("\0"):
            if not rel_path:
                continue
            try:
                st = (self.project_path / rel_path).lstat()
            except OSError:
                continue
            if st.st_size > max_bytes:
                oversized.append(rel_path)

        if not oversized:
            return []

        # Unstage in batches to stay clear of argv limits
        for i in range(0, len(oversized), 50):
            batch = oversized[i:i + 50]
            await self._run(
                ["rm", "--cached", "--quiet", "--force", "--", *batch], check=False
            )

        self._add_excludes(oversized, reason=f"over {max_mb}MB size cap")
        for p in oversized:
            logger.warning(
                f"Shadow git: skipped oversized file '{p}' (> {max_mb}MB cap), "
                f"added to info/exclude"
            )
        return oversized

    async def _run(self, args: list[str], check: bool = True) -> tuple[str, str, int]:
        """
        Run a git command with our shadow git directory.

        Args:
            args: Git command arguments (without 'git')
            check: Raise exception on non-zero exit

        Returns:
            (stdout, stderr, exit_code)
        """
        cmd = [
            "git",
            f"--git-dir={self.git_dir}",
            f"--work-tree={self.project_path}",
            *args
        ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(self.project_path)
        )

        stdout, stderr = await proc.communicate()
        stdout_str = stdout.decode().strip()
        stderr_str = stderr.decode().strip()

        if check and proc.returncode != 0:
            logger.error(f"Git command failed: {' '.join(args)}")
            logger.error(f"stderr: {stderr_str}")
            raise RuntimeError(f"Git command failed: {stderr_str}")

        return stdout_str, stderr_str, proc.returncode

    async def init_repo(self) -> bool:
        """
        Initialize shadow git repository if it doesn't exist.

        Returns:
            True if initialized (or already exists), False on error
        """
        try:
            # Ensure project directory exists
            ensure_project_dir(str(self.project_path))

            if self.git_dir.exists():
                logger.debug(f"Shadow git already exists: {self.git_dir}")
                return True

            # Initialize as a bare repo first (completely separate from project's .git)
            # This ensures we don't inherit any history from the project
            self.git_dir.mkdir(parents=True, exist_ok=True)

            proc = await asyncio.create_subprocess_exec(
                "git", "init", "--bare", str(self.git_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await proc.communicate()

            # Write exclude patterns
            exclude_file = self.git_dir / "info" / "exclude"
            exclude_file.parent.mkdir(parents=True, exist_ok=True)
            exclude_file.write_text(DEFAULT_EXCLUDES)

            # Configure git
            await self._run(["config", "user.email", "shadow-git@painapple-code"])
            await self._run(["config", "user.name", "Shadow Git"])

            # Add all existing files and create baseline snapshot
            # This ensures shadow git tracks the full project state, not just Claude's changes
            await self._run(["add", "-A"])
            await self._quarantine_oversized()
            await self._run(["commit", "-m", "Initial project snapshot"])

            logger.info(f"Initialized shadow git: {self.git_dir}")
            return True

        except Exception as e:
            logger.exception(f"Failed to initialize shadow git: {e}")
            return False

    # ═══════════════════════════════════════════════════════════════════════
    # Modification Tracking
    # ═══════════════════════════════════════════════════════════════════════

    def _load_tracking(self) -> dict:
        """Load active-modifications.json."""
        if self.tracking_file.exists():
            try:
                return json.loads(self.tracking_file.read_text())
            except Exception as e:
                logger.warning(f"Failed to load tracking file: {e}")
        return {}

    def _save_tracking(self, data: dict):
        """Save active-modifications.json atomically."""
        temp = self.tracking_file.with_suffix(".tmp")
        temp.write_text(json.dumps(data, indent=2))
        temp.rename(self.tracking_file)

    def track_modification(self, file_path: str, session_id: str):
        """
        Record that a session modified a file.

        Called on Edit/Write tool results to track which sessions
        have pending modifications to each file.

        Args:
            file_path: Relative path to the modified file
            session_id: Session that made the modification
        """
        # Reload config and check if enabled
        self.reload_config()
        if not self.is_enabled:
            return

        # Use file locking for concurrent access
        self.project_dir.mkdir(parents=True, exist_ok=True)

        lock_file = self.tracking_file.with_suffix(".lock")
        with FileLock(lock_file):
            data = self._load_tracking()

            if file_path not in data:
                data[file_path] = []
            if session_id not in data[file_path]:
                data[file_path].append(session_id)

            self._save_tracking(data)
            logger.debug(f"Tracked modification: {file_path} by {session_id[:8]}")

    def _cleanup_tracking(self, data: dict, files: list[str], sessions: set[str]):
        """Remove sessions from tracking for committed files."""
        for f in files:
            if f in data:
                data[f] = [s for s in data[f] if s not in sessions]
                if not data[f]:
                    del data[f]

        if data:
            self._save_tracking(data)
        elif self.tracking_file.exists():
            self.tracking_file.unlink()

    # ═══════════════════════════════════════════════════════════════════════
    # Committing
    # ═══════════════════════════════════════════════════════════════════════

    async def _get_staged_diff_stats(self) -> str:
        """Get diff stats for staged changes like '+120 -45'."""
        stdout, _, _ = await self._run(["diff", "--cached", "--shortstat"], check=False)
        if not stdout:
            return ""
        # Parse: " 3 files changed, 120 insertions(+), 45 deletions(-)"
        parts = stdout.split(",")
        insertions = deletions = 0
        for part in parts:
            if "insertion" in part:
                insertions = int(part.split()[0])
            elif "deletion" in part:
                deletions = int(part.split()[0])
        return f"+{insertions} -{deletions}"

    async def _get_head_hash(self) -> str:
        """Get current HEAD commit hash."""
        stdout, _, _ = await self._run(["rev-parse", "HEAD"])
        return stdout[:8]

    async def _get_project_git_hash(self) -> Optional[str]:
        """
        Get the project's actual git HEAD hash (not shadow git).

        Returns:
            Short hash (8 chars) if project has git, None otherwise
        """
        project_git_dir = self.project_path / ".git"
        if not project_git_dir.exists():
            return None

        try:
            proc = await asyncio.create_subprocess_exec(
                "git", "rev-parse", "HEAD",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(self.project_path)
            )
            stdout, _ = await proc.communicate()
            if proc.returncode == 0:
                return stdout.decode().strip()[:8]
        except Exception as e:
            logger.debug(f"Failed to get project git hash: {e}")

        return None

    async def _get_project_branch(self) -> Optional[str]:
        """
        Get the project's current git branch name.

        Returns:
            Branch name if on a branch, "HEAD-{hash}" if detached, None if not a git repo
        """
        project_git_dir = self.project_path / ".git"
        if not project_git_dir.exists():
            return None

        try:
            # First try to get branch name
            proc = await asyncio.create_subprocess_exec(
                "git", "branch", "--show-current",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(self.project_path)
            )
            stdout, _ = await proc.communicate()
            branch = stdout.decode().strip()

            if branch:
                return branch

            # Empty output means detached HEAD - use short hash
            proc = await asyncio.create_subprocess_exec(
                "git", "rev-parse", "--short", "HEAD",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(self.project_path)
            )
            stdout, _ = await proc.communicate()
            short_hash = stdout.decode().strip()
            return f"HEAD-{short_hash}"

        except Exception as e:
            logger.debug(f"Failed to get project branch: {e}")
            return None

    async def _ensure_shadow_branch(self, project_branch: Optional[str]) -> str:
        """
        Ensure the shadow branch for a project branch exists and switch to it.

        Creates shadow branches that mirror project branches:
        - main -> shadow/main
        - feature-x -> shadow/feature-x
        - HEAD-abc123 (detached) -> shadow/HEAD-abc123

        Non-git projects or None branch continue using 'master'.

        Args:
            project_branch: Project's current branch name (or None for non-git)

        Returns:
            Shadow branch name that we're now on
        """
        if not project_branch:
            return "master"  # Non-git projects use master

        shadow_branch = f"shadow/{project_branch}"

        # Check if branch exists
        _, _, exit_code = await self._run(
            ["rev-parse", "--verify", f"refs/heads/{shadow_branch}"],
            check=False
        )

        if exit_code != 0:
            # Branch doesn't exist - create it from current HEAD
            # This ensures the new branch has the project's current file state
            try:
                current_head, _, _ = await self._run(["rev-parse", "HEAD"])
                await self._run(["branch", shadow_branch, current_head.strip()])
                logger.info(f"Created shadow branch: {shadow_branch}")
            except RuntimeError as e:
                logger.warning(f"Failed to create shadow branch {shadow_branch}: {e}")
                return "master"  # Fallback to master

        # Switch HEAD to point to shadow branch
        # In a bare repo with work-tree, we update symbolic-ref
        try:
            await self._run(["symbolic-ref", "HEAD", f"refs/heads/{shadow_branch}"])
        except RuntimeError as e:
            logger.warning(f"Failed to switch to shadow branch {shadow_branch}: {e}")
            return "master"

        return shadow_branch

    async def _get_current_shadow_branch(self) -> str:
        """Get current shadow branch name."""
        try:
            stdout, _, _ = await self._run(["symbolic-ref", "--short", "HEAD"])
            return stdout.strip()
        except RuntimeError:
            return "master"

    async def list_shadow_branches(self) -> list[dict]:
        """
        List all shadow branches with commit counts.

        Returns:
            List of dicts with name, project_branch, and commit_count
        """
        try:
            stdout, _, _ = await self._run(
                ["for-each-ref", "--format=%(refname:short)", "refs/heads/shadow/"],
                check=False
            )

            branches = []
            for line in stdout.strip().split("\n"):
                branch = line.strip()
                if not branch:
                    continue

                # Get commit count for this branch
                try:
                    count_out, _, _ = await self._run(
                        ["rev-list", "--count", branch],
                        check=False
                    )
                    count = int(count_out.strip()) if count_out.strip() else 0
                except Exception:
                    count = 0

                branches.append({
                    "name": branch,
                    "project_branch": branch.replace("shadow/", "", 1),
                    "commit_count": count
                })

            return branches

        except Exception as e:
            logger.debug(f"Failed to list shadow branches: {e}")
            return []

    async def commit_turn(
        self,
        session_id: str,
        turn_num: int,
        tracker: TurnTracker,
        cost_info: CostInfo,
        provider_session_id: Optional[str] = None,
        result_msg: Optional[dict] = None,
        token_profile: Optional[str] = None,
        session_model: Optional[str] = None,
        provider=None,
    ) -> tuple[Optional[str], Optional[str]]:
        """
        Commit changes from a turn.

        Handles both file changes and tool-only turns. Tool-only turns
        use --allow-empty commits to preserve the investigation record.

        Args:
            session_id: Our bridge session ID
            turn_num: Turn number (1-indexed)
            tracker: TurnTracker with modified_files and tools_used
            cost_info: Token and cost information
            provider_session_id: Provider session/thread id for the rich-commit fork
            result_msg: Full Claude result message (for Shadow DB)
            token_profile: OAuth token profile for the rich-commit fork (Claude)
            session_model: Parent session's model ID (to inherit context tier)
            provider: The session's Provider (supplies the fork mechanism);
                defaults to the Claude provider when omitted.

        Returns:
            Tuple of (commit_hash, session_title):
            - commit_hash: Short hash if successful, None otherwise
            - session_title: New session title from the summary fork if generated, None otherwise
        """
        # Reload config to pick up any UI changes
        self.reload_config()

        # Check if shadow git is enabled
        if not self.is_enabled:
            logger.debug(f"Shadow git disabled for {self.project_path}")
            return None, None

        if not tracker.has_activity:
            return None, None  # Nothing happened this turn

        # Ensure repo exists
        if not self.git_dir.exists():
            await self.init_repo()

        # Sync exclude patterns so shipped DEFAULT_EXCLUDES updates reach
        # repos initialized before those patterns existed
        self._ensure_excludes()

        has_file_changes = tracker.has_file_changes
        modified_files = list(tracker.modified_files)

        # Handle co-modification tracking for file changes
        contributing_sessions = {session_id}
        tracking_data = {}

        if has_file_changes:
            tracking_data = self._load_tracking()
            for f in modified_files:
                if f in tracking_data:
                    contributing_sessions.update(tracking_data[f])

        # Get project's actual git hash and branch early (needed for branch switching and journey)
        project_git_hash = await self._get_project_git_hash()
        project_branch = await self._get_project_branch()

        # Switch to the appropriate shadow branch BEFORE staging
        # This ensures changes are committed to the correct branch
        shadow_branch = await self._ensure_shadow_branch(project_branch)
        logger.debug(f"Using shadow branch: {shadow_branch}")

        # Stage ALL changes (not just tracked files)
        # This captures: Edit/Write tools, Bash modifications, automation, etc.
        await self._run(["add", "-A"])

        # Quarantine anything over the size cap (VM images, media dumps, …)
        # so huge binaries never bloat the shadow object store
        await self._quarantine_oversized()

        # Build session prefix
        sessions_str = "+".join(sorted(s[:8] for s in contributing_sessions))

        # Build journey context from previous commits (filtered by branch)
        journey = []
        if self.is_rich_commits_enabled:
            journey = await self._build_journey_context(session_id, project_branch)

        # Generate message (rich or basic)
        message_body = None
        summary_cost = None
        structured_data = None
        summary_line = ""
        session_title = ""

        if self.is_rich_commits_enabled and provider_session_id:
            # Default to the Claude provider for callers that predate the seam.
            if provider is None:
                from painapple_code.providers import get_provider
                provider = get_provider("claude")
            message_body, summary_cost, structured_data = await self._generate_rich_commit_message(
                provider,
                provider_session_id,
                tracker.user_prompt or "",
                tracker,
                journey,
                bridge_session_id=session_id,  # For subprocess tracking
                token_profile=token_profile,
                session_model=session_model,
            )
            if message_body:
                # Extract summary line and session title
                # Prefer structured data if available, fallback to regex extraction
                if structured_data:
                    summary_line = structured_data.get("summary", "")
                    session_title = structured_data.get("session_title", "")

                    # Persist raw summary-fork output to disk before DuckDB write
                    # so structured_data is recoverable if acomplete_turn() fails
                    try:
                        summary_file = get_sessions_dir(str(self.project_path)) / session_id / "summary.jsonl"
                        summary_record = {
                            "turn_number": turn_num,
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                            "db_turn_id": tracker.db_turn_id,
                            "summary_cost": {
                                "cost": summary_cost.cost,
                                "input_tokens": summary_cost.input_tokens,
                                "output_tokens": summary_cost.output_tokens,
                                "duration": summary_cost.duration,
                            } if summary_cost else None,
                            "structured_data": structured_data,
                        }
                        with open(summary_file, "a") as f:
                            f.write(json.dumps(summary_record) + "\n")
                    except Exception as e:
                        logger.warning(f"Failed to save summary.jsonl: {e}")
                else:
                    summary_line = extract_summary_line(message_body)
                    session_title = extract_session_title(message_body)

        # Resolve primary model for this turn — pick the model with highest
        # cost share from result_msg.modelUsage (matches shadow_db.py logic),
        # fall back to session_model when modelUsage is absent.
        turn_model: Optional[str] = None
        if result_msg:
            model_usage_data = result_msg.get("modelUsage") or {}
            if model_usage_data:
                turn_model = max(
                    model_usage_data.keys(),
                    key=lambda m: model_usage_data[m].get("costUSD", 0),
                )
        if not turn_model:
            turn_model = session_model

        # Build commit message with YAML frontmatter (rich mode) or basic format
        if message_body:
            # Rich mode - include YAML frontmatter with journey
            yaml_header = format_yaml_frontmatter(
                session_id=session_id,
                turn_num=turn_num,
                files=modified_files,
                tools=[t.name for t in tracker.tools_used],
                cost=cost_info.cost,
                input_tokens=cost_info.input_tokens,
                output_tokens=cost_info.output_tokens,
                journey=journey,
                summary=summary_line or self._extract_title(message_body),
                project_git_hash=project_git_hash,
                project_branch=project_branch,
                model=turn_model,
            )

            title = self._extract_title(message_body)
            message = yaml_header
            message += f"[{sessions_str}] Turn {turn_num}: {title}\n\n"
            if tracker.user_prompt:
                message += f"> {tracker.user_prompt[:200]}\n\n"
            message += message_body
        elif has_file_changes:
            # Basic mode with files (no YAML)
            stats = await self._get_staged_diff_stats()
            title = tracker.format_basic_title()
            message = f"[{sessions_str}] Turn {turn_num}: {title} ({stats})\n\n"
            if tracker.user_prompt:
                message += f"> {tracker.user_prompt[:200]}\n\n"
        else:
            # Basic mode tool-only (no YAML)
            title = tracker.format_basic_title()
            message = f"[{sessions_str}] Turn {turn_num}: {title}\n\n"
            if tracker.user_prompt:
                message += f"> {tracker.user_prompt[:200]}\n\n"
            message += "## Tools Used\n"
            for tool in tracker.tools_used[:20]:
                message += f"- {tool.name}: {tool.input_summary} → {tool.output_summary}\n"

        # Add cost footer
        message += f"\n---\n⏱ {cost_info.duration:.1f}s | 💰 ${cost_info.cost:.4f}"
        message += f" | ↓{cost_info.input_tokens/1000:.1f}k ↑{cost_info.output_tokens/1000:.1f}k"
        if summary_cost:
            # Provider-neutral label: the summarizer fork is Haiku for Claude
            # sessions but Codex for Codex sessions.
            message += f"\n🤖 Summary: ${summary_cost.cost:.4f} ({summary_cost.duration:.1f}s)"

        # Commit (always --allow-empty to ensure journey tracking even when
        # files were already committed by another session or no changes)
        try:
            await self._run(["commit", "--allow-empty", "-m", message])

            commit_hash = await self._get_head_hash()
            logger.info(f"Committed turn {turn_num}: {commit_hash}")

            # Cleanup tracking
            if has_file_changes:
                self._cleanup_tracking(tracking_data, modified_files, contributing_sessions)

            # Update session metadata (including title from the summary fork if available)
            await self._update_session_meta(
                session_id, commit_hash, tracker, cost_info, summary_cost, session_title
            )

            # Shadow DB: complete turn with all data
            if tracker.db_turn_id:
                try:
                    from painapple_code.shadow_db import get_shadow_db
                    db = get_shadow_db()
                    await db.acomplete_turn(
                        tracker.db_turn_id,
                        result_msg=result_msg,
                        git_hash=commit_hash,
                        git_branch=project_branch,
                        shadow_branch=shadow_branch,
                        structured_data=structured_data,
                        summary_cost=summary_cost.cost if summary_cost else 0.0,
                        modified_files=modified_files,
                        tools_summary=tracker.get_tools_summary(),
                        main_thread_model=tracker.main_thread_model,
                    )
                except Exception as e:
                    logger.warning(f"Shadow DB complete_turn failed: {e}")

            return commit_hash, session_title if session_title else None

        except RuntimeError as e:
            logger.error(f"Failed to commit turn {turn_num}: {e}")
            # Mark DB turn as failed
            if tracker.db_turn_id:
                try:
                    from painapple_code.shadow_db import get_shadow_db
                    db = get_shadow_db()
                    await db.afail_turn(tracker.db_turn_id, str(e))
                except Exception:
                    pass
            return None, None

    # ═══════════════════════════════════════════════════════════════════════
    # Archiving
    # ═══════════════════════════════════════════════════════════════════════

    async def archive_session(self, session_id: str) -> bool:
        """
        Archive a session by creating an annotated tag at its last commit.

        Args:
            session_id: Session to archive

        Returns:
            True if archived successfully
        """
        sessions_dir = get_sessions_dir(str(self.project_path))
        meta_file = sessions_dir / session_id / "meta.json"

        if not meta_file.exists():
            logger.warning(f"Session not found: {session_id}")
            return False

        try:
            meta = json.loads(meta_file.read_text())
            shadow = meta.get("shadow", {})

            if not shadow or shadow.get("archived"):
                return True  # Nothing to archive or already archived

            last_commit = shadow.get("last_commit")
            if not last_commit:
                logger.warning(f"No commits for session: {session_id}")
                return False

            # Generate tag message
            tag_message = f"""Session {session_id[:8]}: {len(shadow.get('files_touched', []))} files changed

Turns: {shadow.get('turn_count', 0)}
File commits: {shadow.get('file_commits', 0)}
Tool-only commits: {shadow.get('tool_commits', 0)}
Cost: ${shadow.get('total_cost', 0):.2f}

Files: {', '.join(shadow.get('files_touched', [])[:10])}
"""

            # Create annotated tag
            await self._run([
                "tag", "-a", f"sessions/{session_id}",
                "-m", tag_message,
                last_commit
            ])

            # Mark as archived in meta
            meta["shadow"]["archived"] = True
            meta["shadow"]["archive_tag"] = f"sessions/{session_id}"
            meta_file.write_text(json.dumps(meta, indent=2))

            logger.info(f"Archived session: {session_id}")
            return True

        except Exception as e:
            logger.exception(f"Failed to archive session: {e}")
            return False

    # ═══════════════════════════════════════════════════════════════════════
    # Querying
    # ═══════════════════════════════════════════════════════════════════════

    async def get_session_log(
        self,
        session_id: str,
        limit: int = 50,
        branch: Optional[str] = None
    ) -> list[dict]:
        """
        Get commits for a specific session.

        Args:
            session_id: Session to get commits for
            limit: Maximum commits to return
            branch: Filter by project branch (e.g., "main" -> searches shadow/main)

        Returns:
            List of commit dicts with hash, message, timestamp
        """
        try:
            cmd = ["log"]
            if branch:
                # Add branch filter (search specific shadow branch)
                cmd.append(f"shadow/{branch}")
            cmd.extend([
                f"--grep=\\[{session_id[:8]}",
                f"-n{limit}",
                "--format=%H|%s|%ai"
            ])
            stdout, _, _ = await self._run(cmd, check=False)

            commits = []
            for line in stdout.split("\n"):
                if not line:
                    continue
                parts = line.split("|", 2)
                if len(parts) >= 3:
                    commits.append({
                        "hash": parts[0][:8],
                        "message": parts[1],
                        "timestamp": parts[2]
                    })
            return commits

        except Exception as e:
            logger.exception(f"Failed to get session log: {e}")
            return []

    async def get_full_log(
        self,
        limit: int = 100,
        branch: Optional[str] = None
    ) -> list[dict]:
        """
        Get all commits on a branch.

        Args:
            limit: Maximum commits to return
            branch: Filter by project branch (e.g., "main" -> searches shadow/main)

        Returns:
            List of commit dicts
        """
        try:
            cmd = ["log"]
            if branch:
                cmd.append(f"shadow/{branch}")
            cmd.extend([
                f"-n{limit}",
                "--format=%H|%s|%ai"
            ])
            stdout, _, _ = await self._run(cmd, check=False)

            commits = []
            for line in stdout.split("\n"):
                if not line:
                    continue
                parts = line.split("|", 2)
                if len(parts) >= 3:
                    commits.append({
                        "hash": parts[0][:8],
                        "message": parts[1],
                        "timestamp": parts[2]
                    })
            return commits

        except Exception as e:
            logger.exception(f"Failed to get log: {e}")
            return []

    async def get_file_at_ref(self, ref: str, path: str) -> Optional[str]:
        """
        Get file content at a specific commit.

        Args:
            ref: Commit hash or reference
            path: File path

        Returns:
            File content or None
        """
        try:
            stdout, _, _ = await self._run(["show", f"{ref}:{path}"])
            return stdout
        except RuntimeError:
            return None

    async def list_archived_sessions(self) -> list[str]:
        """List all archived session IDs."""
        try:
            stdout, _, _ = await self._run(["tag", "-l", "sessions/*"])
            return [t.replace("sessions/", "") for t in stdout.split("\n") if t]
        except Exception:
            return []

    # ═══════════════════════════════════════════════════════════════════════
    # Undo/Redo
    # ═══════════════════════════════════════════════════════════════════════

    async def undo_turn(self, session_id: str) -> Optional[str]:
        """
        Undo the last turn for a session.

        Uses git revert to create an "undo" commit.

        Args:
            session_id: Session to undo

        Returns:
            New commit hash if successful
        """
        # Find last commit for this session
        commits = await self.get_session_log(session_id, limit=1)
        if not commits:
            logger.warning(f"No commits to undo for session: {session_id}")
            return None

        last_commit = commits[0]["hash"]

        try:
            await self._run(["revert", "--no-commit", last_commit])
            await self._run([
                "commit", "-m",
                f"[{session_id[:8]}] UNDO: Reverted {commits[0]['message']}"
            ])
            return await self._get_head_hash()
        except RuntimeError as e:
            logger.error(f"Failed to undo: {e}")
            # Abort if revert failed
            await self._run(["revert", "--abort"], check=False)
            return None

    async def restore_file(self, ref: str, path: str) -> bool:
        """
        Restore a file from a specific commit.

        Args:
            ref: Commit hash
            path: File path to restore

        Returns:
            True if restored successfully
        """
        try:
            await self._run(["checkout", ref, "--", path])
            return True
        except RuntimeError as e:
            logger.error(f"Failed to restore {path} from {ref}: {e}")
            return False

    # ═══════════════════════════════════════════════════════════════════════
    # Compaction Checkpoint
    # ═══════════════════════════════════════════════════════════════════════

    async def capture_compaction_checkpoint(
        self,
        session_id: str,
        provider_session_id: str,
        compact_metadata: dict,
        token_profile: Optional[str] = None,
    ) -> Optional[str]:
        """
        Capture a checkpoint when compaction is detected.

        Args:
            session_id: Our session ID
            provider_session_id: Claude's session ID for --resume
            compact_metadata: Compaction info with pre_tokens, post_tokens, trigger
            token_profile: OAuth token profile for the summary fork subprocess

        Returns:
            Commit hash if successful
        """
        # Reload config and check if enabled
        self.reload_config()
        if not self.is_enabled:
            return None

        pre_tokens = compact_metadata.get("pre_tokens", 0)
        post_tokens = compact_metadata.get("post_tokens", 0)
        trigger = compact_metadata.get("trigger", "unknown")

        logger.info(f"Compaction detected: {pre_tokens}→{post_tokens} ({trigger})")

        # Fork to the summary model for comprehensive summary
        summary = None
        if provider_session_id:
            try:
                from painapple_code.utils.token_profiles import build_env as build_token_env
                from painapple_code.providers import get_provider
                subprocess_env = build_token_env(token_profile)

                proc = await asyncio.create_subprocess_exec(
                    get_provider("claude").binary(),
                    "--resume", provider_session_id,
                    "--fork-session",
                    "--model", get_summary_model(),
                    "--tools", "",
                    "--no-session-persistence",
                    "-p", COMMIT_PROMPT_COMPACTION,
                    "--output-format", "text",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=str(self.project_path),
                    env=subprocess_env,
                )

                stdout, _ = await asyncio.wait_for(
                    proc.communicate(),
                    timeout=60
                )

                if proc.returncode == 0:
                    summary = stdout.decode().strip()

            except Exception as e:
                logger.warning(f"Compaction checkpoint fork failed: {e}")

        # Create checkpoint commit
        message = f"""[{session_id[:8]}] Checkpoint: Context compaction

Compacted from {pre_tokens:,} to {post_tokens:,} tokens.
Trigger: {trigger}

"""
        if summary:
            message += summary
        else:
            message += "(Summary generation failed - context already truncated)"

        message += "\n\n---\n🔄 Auto-generated checkpoint after context compaction"

        try:
            await self._run(["commit", "--allow-empty", "-m", message])
            commit_hash = await self._get_head_hash()
            logger.info(f"Created compaction checkpoint: {commit_hash}")
            return commit_hash
        except RuntimeError as e:
            logger.error(f"Failed to create compaction checkpoint: {e}")
            return None


# ═══════════════════════════════════════════════════════════════════════════
# Convenience function
# ═══════════════════════════════════════════════════════════════════════════

_shadow_git_instances: dict[str, ShadowGit] = {}


def get_shadow_git(project_path: str) -> ShadowGit:
    """
    Get or create ShadowGit instance for a project.

    Caches instances to avoid recreating them.
    """
    path_str = str(Path(project_path).resolve())
    if path_str not in _shadow_git_instances:
        _shadow_git_instances[path_str] = ShadowGit(project_path)
    return _shadow_git_instances[path_str]


def get_commit_sections_for_api(project_config: dict) -> dict:
    """
    Get sections config formatted for API/UI consumption.

    Returns:
        {
            "sections": [
                {
                    "id": "summary",
                    "title": "Summary",
                    "prompt": "...",
                    "required": true,
                    "enabled": true,
                    "order": 10,
                    "builtin": true,
                    "applies_to": ["file_changes", "tool_only"]
                },
                ...
            ],
            "builtin_ids": ["summary", "work_done", ...]
        }
    """
    sections = get_sections_config(project_config)

    # Convert to sorted list
    sections_list = sorted(sections.values(), key=lambda s: s.get("order", 50))

    return {
        "sections": sections_list,
        "builtin_ids": list(BUILTIN_SECTIONS.keys()),
    }
