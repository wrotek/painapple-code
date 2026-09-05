"""
Turn Tracker - Tracks tool usage and file modifications during a Claude turn.

Each turn (user message → Claude response → result) is tracked for:
- Files modified — from Edit/Write/NotebookEdit tools, from Bash commands
  classified by utils/bash_file_ops (`sed -i`, heredoc redirects, `tee`,
  `mv`, `rm`, …) and confirmed against the filesystem, and from the shadow
  repo's own staged diff at commit time (anything else that touched the
  tree: scripts, generators, `npm install` side effects). `file_kinds`
  carries how each path was seen (created/modified/deleted/detected).
- Files read — Read tool + Bash reads (`cat`, `head`, `grep … file`, …),
  persisted as `change_type='read'` rows so the quick switcher can rank
  recently-read files below recently-edited ones.
- All tools used with input/output summaries

Used by Shadow Git to generate comprehensive commit messages.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

# Kept in sync with the frontend's image-extension checks
# (image-preview-widget.js IMAGE_EXT_RE, app.js previewFile routing).
IMAGE_EXTENSIONS = ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico')


@dataclass
class ToolUsage:
    """Record of a single tool invocation."""
    name: str           # Tool name: "Bash", "Read", "Edit", etc.
    input_summary: str  # Truncated input (command, file path, pattern)
    output_summary: str # Truncated output (exit code, line count, etc.)
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def __repr__(self) -> str:
        return f"ToolUsage({self.name}: {self.input_summary} → {self.output_summary})"


@dataclass
class TurnTracker:
    """
    Tracks all activity during a single turn.

    A turn is: user message → Claude thinking + tool calls → result message

    Usage:
        tracker = TurnTracker()
        tracker.add_tool_usage("Bash", "npm test", "exit 0, 15 tests passed")
        tracker.add_modified_file("src/auth.js")
        # ... on result message ...
        shadow_git.commit_turn(session_id, turn_num, tracker, ...)
        tracker.reset()
    """
    modified_files: set = field(default_factory=set)
    # path -> "created" | "modified" | "deleted" | "detected". `detected` =
    # found in the shadow repo's staged diff at commit time but not
    # attributed to any tool call this turn (provenance is git, not a tool).
    file_kinds: dict = field(default_factory=dict)
    # Files read this turn (Read tool + Bash reads). Never overlaps
    # modified_files — a read-then-edited file is a modification.
    read_files: set = field(default_factory=set)
    # path -> {"adds", "dels", "created", "deleted"} from `git diff --cached
    # --numstat/--name-status` at commit time. Fills line stats for files
    # written outside Edit/Write (a `sed -i` has no old/new strings to diff).
    detected_stats: dict = field(default_factory=dict)
    tools_used: list = field(default_factory=list)
    turn_start: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    user_prompt: Optional[str] = None
    db_turn_id: Optional[str] = None  # Shadow DB turn ID (set on prompt send)
    # Model behind the MAIN chat thread this turn (assistant frames with
    # parent_tool_use_id None). Recorded live because the result frame's
    # modelUsage aggregates Task-tool subagents too and cannot distinguish
    # them. Last main-thread frame wins, so a mid-turn refusal fallback
    # (e.g. fable-5 -> opus-4-8) is reflected. See agent_session.
    main_thread_model: Optional[str] = None

    def add_tool_usage(self, name: str, input_summary: str, output_summary: str):
        """Record a tool invocation."""
        self.tools_used.append(ToolUsage(
            name=name,
            input_summary=input_summary[:200],  # Truncate
            output_summary=output_summary[:200]
        ))

    def add_modified_file(self, path: str, kind: str = "modified"):
        """Record a file modification.

        `kind` describes the file's state at the END of the turn, so later
        events override earlier ones where they contradict: "deleted"
        replaces anything; a write after a delete (`rm f; touch f`, or a
        Write recreating what Bash removed) is "modified" — the file
        existed before the turn and exists after it; a tool-attributed kind
        replaces "detected"; otherwise the first kind sticks (a
        Write-created file that's later Edited stays "created").
        """
        self.modified_files.add(path)
        self.read_files.discard(path)
        prev = self.file_kinds.get(path)
        if kind == "deleted" or prev is None or prev == "detected":
            self.file_kinds[path] = kind
        elif prev == "deleted":
            self.file_kinds[path] = "modified"

    def add_read_file(self, path: str):
        """Record a file read (Read tool or a Bash read). No-op for files
        already modified this turn."""
        if path and path not in self.modified_files:
            self.read_files.add(path)

    def add_detected_file(self, path: str, status: str, adds: int = 0, dels: int = 0):
        """Record a file the shadow repo's staged diff shows changed this
        turn (`status` is git's A/M/D). Attributed files keep their tool
        kind and only gain line stats; unattributed ones are added as
        "detected" (or "deleted" for D — a vanished file is a hard fact).

        Git is the arbiter of EXISTENCE: an attributed "deleted" that git
        still sees (A/M — something recreated it after the rm) becomes
        "modified"; an attributed write that git reports D is "deleted".
        """
        self.detected_stats[path] = {
            "adds": adds, "dels": dels,
            "created": status == "A", "deleted": status == "D",
        }
        if path in self.modified_files:
            prev = self.file_kinds.get(path)
            if status == "D" and prev != "deleted":
                self.file_kinds[path] = "deleted"
            elif status in ("A", "M") and prev == "deleted":
                self.file_kinds[path] = "created" if status == "A" else "modified"
            return
        self.add_modified_file(path, "deleted" if status == "D" else "detected")

    def get_read_files(self) -> list:
        """Files read but not modified this turn, sorted."""
        return sorted(p for p in self.read_files if p not in self.modified_files)

    def set_prompt(self, prompt: str):
        """Set the user's prompt for this turn."""
        self.user_prompt = prompt[:500] if prompt else None

    def reset(self):
        """Clear for next turn."""
        self.modified_files = set()
        self.file_kinds = {}
        self.read_files = set()
        self.detected_stats = {}
        self.tools_used = []
        self.turn_start = datetime.now(timezone.utc).isoformat()
        self.user_prompt = None
        self.db_turn_id = None
        self.main_thread_model = None

    @property
    def has_activity(self) -> bool:
        """Check if any activity was tracked this turn."""
        return bool(self.tools_used)

    @property
    def has_file_changes(self) -> bool:
        """Check if any files were modified this turn."""
        return bool(self.modified_files)

    def get_tools_summary(self) -> dict:
        """Get counts of each tool type used."""
        counts = {}
        for tool in self.tools_used:
            counts[tool.name] = counts.get(tool.name, 0) + 1
        return counts

    def get_file_actions(self) -> dict:
        """
        Get per-file action breakdown with line change stats.

        Returns dict of file paths to their stats:
        {
            "src/app.js": {"edits": 3, "adds": 25, "dels": 10},
            "src/utils.js": {"edits": 1, "adds": 5, "dels": 0, "created": True},
            "src/gone.js": {"edits": 0, "adds": 0, "dels": 12, "deleted": True},
            "dist/x.js":   {"edits": 0, "adds": 40, "dels": 0, "detected": True}
        }

        Edit/Write stats come from the tool inputs; every other modified
        file (Bash writes, git-detected) gets its line counts from
        `detected_stats` when the shadow commit has supplied them.
        """
        file_actions = {}
        for tool in self.tools_used:
            # File-modifying tools (Edit, Write) have file path as input_summary
            if tool.name in ('Edit', 'Write', 'NotebookEdit'):
                path = tool.input_summary
                if path not in file_actions:
                    file_actions[path] = {"edits": 0, "adds": 0, "dels": 0}

                file_actions[path]["edits"] += 1

                # Parse line changes from output_summary
                # Edit: "+5 -3" (added lines, removed lines)
                # Write: "created, 15 lines", "overwritten, 15 lines"
                out = tool.output_summary
                if out:
                    if out.startswith("+") and " -" in out:
                        # "+5 -3" -> add 5, del 3
                        try:
                            parts = out.split()
                            file_actions[path]["adds"] += int(parts[0][1:])
                            file_actions[path]["dels"] += int(parts[1][1:])
                        except (ValueError, IndexError):
                            pass
                    elif "created" in out:
                        # "created, 15 lines"
                        file_actions[path]["created"] = True
                        try:
                            lines = int(out.split(",")[1].strip().split()[0])
                            file_actions[path]["adds"] += lines
                        except (ValueError, IndexError):
                            pass
                    elif "overwritten" in out:
                        # "overwritten, 15 lines" - treat as full replacement
                        try:
                            lines = int(out.split(",")[1].strip().split()[0])
                            file_actions[path]["adds"] += lines
                        except (ValueError, IndexError):
                            pass

        # Files modified outside Edit/Write: Bash-classified writes/deletes and
        # git-detected changes. Line stats only exist once the shadow commit
        # has run numstat; before that the pill shows the name (and kind).
        for path in self.modified_files:
            kind = self.file_kinds.get(path, "modified")
            entry = file_actions.setdefault(path, {"edits": 0, "adds": 0, "dels": 0})
            stats = self.detected_stats.get(path)
            if stats and entry["adds"] == 0 and entry["dels"] == 0:
                entry["adds"] = stats["adds"]
                entry["dels"] = stats["dels"]
            if kind == "created" or (stats and stats.get("created")):
                entry["created"] = True
            if kind == "deleted" or (stats and stats.get("deleted")):
                entry["deleted"] = True
            if kind == "detected":
                entry["detected"] = True
        return file_actions

    def get_read_images(self) -> list:
        """
        Get image files opened via Read this turn (screenshots, test results),
        excluding ones that were modified.

        Returns paths deduplicated, in first-read order.
        """
        images = []
        for tool in self.tools_used:
            if tool.name == 'Read':
                path = tool.input_summary
                if (path and path.lower().endswith(IMAGE_EXTENSIONS)
                        and path not in self.modified_files and path not in images):
                    images.append(path)
        return images

    def format_basic_title(self) -> str:
        """
        Format a basic commit title from tool usage.

        Examples:
        - "src/auth.js, src/api.js (+120 -45)"  # with file changes
        - "Research (Read ×3, Bash ×2)"          # tool-only
        """
        if self.modified_files:
            files = sorted(self.modified_files)
            if len(files) <= 2:
                return ", ".join(files)
            else:
                return f"{files[0]}, {files[1]}, +{len(files) - 2} more"
        else:
            counts = self.get_tools_summary()
            parts = [f"{name} ×{count}" for name, count in sorted(counts.items())]
            if parts:
                return f"Research ({', '.join(parts)})"
            return "No activity"

    def format_for_prompt(self) -> str:
        """Format tool usage for rich commit prompt."""
        lines = []
        for tool in self.tools_used[:15]:  # Limit to avoid huge prompts
            lines.append(f"- {tool.name}: {tool.input_summary} → {tool.output_summary}")
        if len(self.tools_used) > 15:
            lines.append(f"... and {len(self.tools_used) - 15} more tools")
        return "\n".join(lines)


# ═══════════════════════════════════════════════════════════════════════════
# Tool output summarizers - extract key info from tool results
# ═══════════════════════════════════════════════════════════════════════════

def summarize_edit_output(file_path: str, old_str: str, new_str: str) -> tuple[str, str]:
    """Summarize Edit tool input/output."""
    input_summary = file_path
    old_lines = old_str.count("\n") + 1 if old_str else 0
    new_lines = new_str.count("\n") + 1 if new_str else 0
    output_summary = f"+{new_lines} -{old_lines}"
    return input_summary, output_summary


def summarize_write_output(file_path: str, content: str, existed: bool) -> tuple[str, str]:
    """Summarize Write tool input/output."""
    input_summary = file_path
    lines = content.count("\n") + 1 if content else 0
    if existed:
        output_summary = f"overwritten, {lines} lines"
    else:
        output_summary = f"created, {lines} lines"
    return input_summary, output_summary


def summarize_bash_file_ops(created: set, modified: set, deleted: set, reads: set) -> str:
    """Output summary for a Bash tool call that touched files, e.g.
    "wrote src/a.py, src/b.py; deleted old.py" — replaces the bare
    "running..." status so the rich-commit prompt sees what the command did."""
    parts = []
    written = sorted(created | modified)
    if written:
        parts.append("wrote " + ", ".join(written[:5]) + (f" +{len(written) - 5}" if len(written) > 5 else ""))
    if deleted:
        d = sorted(deleted)
        parts.append("deleted " + ", ".join(d[:5]) + (f" +{len(d) - 5}" if len(d) > 5 else ""))
    if reads and not written and not deleted:
        r = sorted(reads)
        parts.append("read " + ", ".join(r[:5]) + (f" +{len(r) - 5}" if len(r) > 5 else ""))
    return "; ".join(parts) if parts else "ok"


