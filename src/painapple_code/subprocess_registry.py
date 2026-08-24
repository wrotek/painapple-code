"""
Global registry for tracking agent subprocesses.

Tracks all agent (CLI) subprocesses spawned by the server, including:
- Summary forks for rich commit messages (shadow git)
- Any other background agent processes

This provides visibility into all running agent subprocesses beyond just
the main sessions.

History is preserved for completed processes to enable:
- Timeline view of all subprocess activity
- Success/failure rate tracking
- Cost and duration analytics
- Debugging stuck or slow processes
"""

import os
import time
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional
from enum import Enum
from collections import deque

from painapple_code.utils.proc import pid_alive

logger = logging.getLogger("painapple-code.subprocess-registry")

# Maximum history entries to keep (rolling buffer)
MAX_HISTORY_SIZE = 500


class SubprocessType(Enum):
    """Type of agent subprocess."""
    SUMMARY_FORK = "summary_fork"        # Rich commit message generation
    COMPACTION = "compaction"        # Context compaction
    TASK_AGENT = "task_agent"        # Task tool sub-agent
    OTHER = "other"


class SubprocessStatus(Enum):
    """Outcome status of a completed subprocess."""
    SUCCESS = "success"
    TIMEOUT = "timeout"
    ERROR = "error"
    KILLED = "killed"


@dataclass
class AgentSubprocess:
    """A tracked agent subprocess (currently running)."""
    pid: int
    subprocess_type: SubprocessType
    parent_session_id: Optional[str]  # Session that spawned this
    model: str = "unknown"
    purpose: str = ""  # Human-readable description
    started_at: float = field(default_factory=time.time)
    cwd: Optional[str] = None

    def to_dict(self) -> dict:
        """Convert to API-friendly dict."""
        return {
            "pid": self.pid,
            "type": self.subprocess_type.value,
            "parent_session_id": self.parent_session_id,
            "model": self.model,
            "purpose": self.purpose,
            "started_at": self.started_at,
            "running_seconds": int(time.time() - self.started_at),
            "cwd": self.cwd,
        }


@dataclass
class CompletedSubprocess:
    """A completed agent subprocess (for history)."""
    pid: int
    subprocess_type: SubprocessType
    parent_session_id: Optional[str]
    model: str
    purpose: str
    started_at: float
    completed_at: float
    duration: float
    status: SubprocessStatus
    cwd: Optional[str] = None
    result_preview: Optional[str] = None  # First ~100 chars of result
    cost: Optional[float] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    error_message: Optional[str] = None

    def to_dict(self) -> dict:
        """Convert to API-friendly dict."""
        return {
            "pid": self.pid,
            "type": self.subprocess_type.value,
            "parent_session_id": self.parent_session_id,
            "model": self.model,
            "purpose": self.purpose,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "duration": round(self.duration, 2),
            "status": self.status.value,
            "cwd": self.cwd,
            "result_preview": self.result_preview,
            "cost": self.cost,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "error_message": self.error_message,
        }


class SubprocessRegistry:
    """
    Global registry for agent subprocesses.

    Tracks both running processes and completed history.
    Thread-safe for use with asyncio (single-threaded event loop).
    """

    def __init__(self, max_history: int = MAX_HISTORY_SIZE):
        self._processes: dict[int, AgentSubprocess] = {}
        self._history: deque[CompletedSubprocess] = deque(maxlen=max_history)
        self._stats_cache: Optional[dict] = None
        self._stats_cache_time: float = 0

    def register(
        self,
        pid: int,
        subprocess_type: SubprocessType,
        parent_session_id: Optional[str] = None,
        model: str = "unknown",
        purpose: str = "",
        cwd: Optional[str] = None,
    ) -> AgentSubprocess:
        """
        Register a new agent subprocess.

        Args:
            pid: Process ID
            subprocess_type: Type of subprocess
            parent_session_id: Session ID that spawned this
            model: Claude model being used
            purpose: Human-readable description
            cwd: Working directory

        Returns:
            The registered AgentSubprocess
        """
        proc = AgentSubprocess(
            pid=pid,
            subprocess_type=subprocess_type,
            parent_session_id=parent_session_id,
            model=model,
            purpose=purpose,
            cwd=cwd,
        )
        self._processes[pid] = proc
        self._invalidate_stats_cache()
        logger.debug(f"Registered subprocess: pid={pid} type={subprocess_type.value} purpose={purpose}")
        return proc

    def unregister(
        self,
        pid: int,
        status: SubprocessStatus = SubprocessStatus.SUCCESS,
        result_preview: Optional[str] = None,
        cost: Optional[float] = None,
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        error_message: Optional[str] = None,
    ) -> Optional[AgentSubprocess]:
        """
        Unregister a subprocess and move it to history.

        Args:
            pid: Process ID to unregister
            status: Outcome status (success, timeout, error, killed)
            result_preview: First ~100 chars of result (if any)
            cost: Cost incurred (if known)
            input_tokens: Input tokens used
            output_tokens: Output tokens generated
            error_message: Error message if failed

        Returns:
            The unregistered subprocess, or None if not found
        """
        proc = self._processes.pop(pid, None)
        if proc:
            completed_at = time.time()
            duration = completed_at - proc.started_at

            # Create history entry
            completed = CompletedSubprocess(
                pid=proc.pid,
                subprocess_type=proc.subprocess_type,
                parent_session_id=proc.parent_session_id,
                model=proc.model,
                purpose=proc.purpose,
                started_at=proc.started_at,
                completed_at=completed_at,
                duration=duration,
                status=status,
                cwd=proc.cwd,
                result_preview=result_preview[:150] if result_preview else None,
                cost=cost,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                error_message=error_message[:200] if error_message else None,
            )
            self._history.appendleft(completed)
            self._invalidate_stats_cache()

            status_emoji = {"success": "✓", "timeout": "⏱", "error": "✗", "killed": "☠"}
            logger.info(
                f"Subprocess completed: {status_emoji.get(status.value, '?')} "
                f"pid={pid} type={proc.subprocess_type.value} "
                f"duration={duration:.1f}s cost=${cost or 0:.4f}"
            )

        return proc

    def prune_dead_processes(self) -> int:
        """
        Remove entries for PIDs that no longer exist.

        This handles cases where processes exited unexpectedly without
        proper unregistration (crash, kill -9, etc.).

        Returns:
            Number of stale entries removed
        """
        dead_pids = []

        for pid in self._processes:
            # psutil-backed: os.kill(pid, 0) is not a probe on Windows
            # (sig 0 == CTRL_C_EVENT, succeeds for dead pids).
            if not pid_alive(pid):
                dead_pids.append(pid)

        # Unregister dead processes with KILLED status
        for pid in dead_pids:
            self.unregister(
                pid,
                status=SubprocessStatus.KILLED,
                error_message="Process not found (stale registry entry)"
            )
            logger.warning(f"Pruned stale subprocess entry: pid={pid}")

        return len(dead_pids)

    def get(self, pid: int) -> Optional[AgentSubprocess]:
        """Get a running subprocess by PID."""
        return self._processes.get(pid)

    def list_all(self) -> list[AgentSubprocess]:
        """List all running subprocesses."""
        return list(self._processes.values())

    def list_by_type(self, subprocess_type: SubprocessType) -> list[AgentSubprocess]:
        """List running subprocesses of a specific type."""
        return [p for p in self._processes.values() if p.subprocess_type == subprocess_type]

    def list_by_session(self, session_id: str) -> list[AgentSubprocess]:
        """List running subprocesses spawned by a specific session."""
        return [p for p in self._processes.values() if p.parent_session_id == session_id]

    def count(self) -> int:
        """Total count of running subprocesses."""
        return len(self._processes)

    def count_by_type(self) -> dict[str, int]:
        """Count running subprocesses by type."""
        counts = {}
        for proc in self._processes.values():
            key = proc.subprocess_type.value
            counts[key] = counts.get(key, 0) + 1
        return counts

    # ═══════════════════════════════════════════════════════════════════════════
    # History Methods
    # ═══════════════════════════════════════════════════════════════════════════

    def get_history(
        self,
        limit: int = 100,
        offset: int = 0,
        session_id: Optional[str] = None,
        subprocess_type: Optional[SubprocessType] = None,
        status: Optional[SubprocessStatus] = None,
        since: Optional[float] = None,
    ) -> list[CompletedSubprocess]:
        """
        Get completed subprocess history with optional filters.

        Args:
            limit: Max entries to return
            offset: Skip first N entries
            session_id: Filter by parent session
            subprocess_type: Filter by type
            status: Filter by outcome status
            since: Only entries after this timestamp

        Returns:
            List of CompletedSubprocess (newest first)
        """
        results = []
        for entry in self._history:
            # Apply filters
            if session_id and entry.parent_session_id != session_id:
                continue
            if subprocess_type and entry.subprocess_type != subprocess_type:
                continue
            if status and entry.status != status:
                continue
            if since and entry.completed_at < since:
                continue
            results.append(entry)

        # Apply pagination
        return results[offset:offset + limit]

    def get_history_grouped(self) -> dict:
        """
        Get history grouped by time period for timeline display.

        Returns dict with:
            - today: list of entries from today
            - yesterday: list from yesterday
            - this_week: list from this week (excluding today/yesterday)
            - older: list of older entries
        """
        now = datetime.now()
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        yesterday_start = today_start - timedelta(days=1)
        week_start = today_start - timedelta(days=7)

        groups = {
            "today": [],
            "yesterday": [],
            "this_week": [],
            "older": [],
        }

        for entry in self._history:
            entry_dt = datetime.fromtimestamp(entry.completed_at)
            entry_dict = entry.to_dict()

            if entry_dt >= today_start:
                groups["today"].append(entry_dict)
            elif entry_dt >= yesterday_start:
                groups["yesterday"].append(entry_dict)
            elif entry_dt >= week_start:
                groups["this_week"].append(entry_dict)
            else:
                groups["older"].append(entry_dict)

        return groups

    def history_count(self) -> int:
        """Total count of history entries."""
        return len(self._history)

    def clear_history(self):
        """Clear all history entries."""
        self._history.clear()
        self._invalidate_stats_cache()

    # ═══════════════════════════════════════════════════════════════════════════
    # Statistics Methods
    # ═══════════════════════════════════════════════════════════════════════════

    def _invalidate_stats_cache(self):
        """Invalidate stats cache when data changes."""
        self._stats_cache = None

    def get_stats(self, since: Optional[float] = None) -> dict:
        """
        Get aggregated statistics.

        Args:
            since: Only include entries after this timestamp.
                   If None, uses last 24 hours.

        Returns dict with:
            - total_count: Total completed processes
            - success_count, timeout_count, error_count, killed_count
            - success_rate: Percentage of successful completions
            - avg_duration: Average duration in seconds
            - total_cost: Total cost incurred
            - total_input_tokens, total_output_tokens
            - by_type: Breakdown by subprocess type
            - by_status: Breakdown by status
            - by_hour: Activity by hour (for charts)
        """
        if since is None:
            since = time.time() - 86400  # Last 24 hours

        # Use cache if fresh (5 second TTL)
        cache_key = f"{since:.0f}"
        if (self._stats_cache and
            self._stats_cache.get("_key") == cache_key and
            time.time() - self._stats_cache_time < 5):
            return self._stats_cache

        # Calculate stats
        entries = [e for e in self._history if e.completed_at >= since]

        if not entries:
            return {
                "total_count": 0,
                "success_count": 0,
                "timeout_count": 0,
                "error_count": 0,
                "killed_count": 0,
                "success_rate": 0,
                "avg_duration": 0,
                "total_cost": 0,
                "total_input_tokens": 0,
                "total_output_tokens": 0,
                "by_type": {},
                "by_status": {},
                "by_hour": {},
                "period_start": since,
                "period_end": time.time(),
            }

        # Count by status
        status_counts = {s.value: 0 for s in SubprocessStatus}
        for e in entries:
            status_counts[e.status.value] += 1

        # Count by type
        type_counts = {}
        for e in entries:
            key = e.subprocess_type.value
            if key not in type_counts:
                type_counts[key] = {"count": 0, "cost": 0, "duration": 0}
            type_counts[key]["count"] += 1
            type_counts[key]["cost"] += e.cost or 0
            type_counts[key]["duration"] += e.duration

        # Calculate averages per type
        for key in type_counts:
            count = type_counts[key]["count"]
            type_counts[key]["avg_duration"] = round(type_counts[key]["duration"] / count, 2)
            type_counts[key]["avg_cost"] = round(type_counts[key]["cost"] / count, 4)

        # Activity by hour (last 24 hours)
        by_hour = {}
        for e in entries:
            hour = datetime.fromtimestamp(e.completed_at).strftime("%H:00")
            if hour not in by_hour:
                by_hour[hour] = {"count": 0, "success": 0, "failed": 0}
            by_hour[hour]["count"] += 1
            if e.status == SubprocessStatus.SUCCESS:
                by_hour[hour]["success"] += 1
            else:
                by_hour[hour]["failed"] += 1

        # Aggregate stats
        total_count = len(entries)
        total_cost = sum(e.cost or 0 for e in entries)
        total_duration = sum(e.duration for e in entries)
        total_input = sum(e.input_tokens or 0 for e in entries)
        total_output = sum(e.output_tokens or 0 for e in entries)

        stats = {
            "total_count": total_count,
            "success_count": status_counts["success"],
            "timeout_count": status_counts["timeout"],
            "error_count": status_counts["error"],
            "killed_count": status_counts["killed"],
            "success_rate": round(status_counts["success"] / total_count * 100, 1) if total_count else 0,
            "avg_duration": round(total_duration / total_count, 2) if total_count else 0,
            "total_cost": round(total_cost, 4),
            "total_input_tokens": total_input,
            "total_output_tokens": total_output,
            "by_type": type_counts,
            "by_status": status_counts,
            "by_hour": by_hour,
            "period_start": since,
            "period_end": time.time(),
        }

        self._stats_cache = stats
        self._stats_cache_time = time.time()
        return stats

    # ═══════════════════════════════════════════════════════════════════════════
    # API Response Formatters
    # ═══════════════════════════════════════════════════════════════════════════

    def to_api_response(self) -> dict:
        """
        Format running instances for API response.

        Returns dict with:
            - instances: list of running subprocess dicts
            - count: total running count
            - by_type: counts by type
        """
        instances = [p.to_dict() for p in self._processes.values()]
        # Sort by started_at descending (newest first)
        instances.sort(key=lambda x: -x["started_at"])

        return {
            "instances": instances,
            "count": len(instances),
            "by_type": self.count_by_type(),
        }

    def to_full_api_response(self, history_limit: int = 50) -> dict:
        """
        Format complete data for API response (running + history + stats).

        Returns dict with:
            - active: running instances
            - history: grouped completed instances
            - stats: aggregated statistics (last 24h)
            - history_total: total history count
        """
        return {
            "active": self.to_api_response(),
            "history": self.get_history_grouped(),
            "stats": self.get_stats(),
            "history_total": self.history_count(),
        }


# Global singleton instance
agent_subprocesses = SubprocessRegistry()
