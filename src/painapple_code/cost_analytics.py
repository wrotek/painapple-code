"""
Cost Analytics Module for Claude iPad Bridge.

Aggregates cost data across projects, sessions, models, and tools.
Provides multi-dimensional breakdowns for cost analysis.
"""

import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional
from collections import defaultdict

from painapple_code.paths import (
    ensure_data_home,
    get_project_path_from_hash,
    get_summary_model,
)


@dataclass
class ModelCost:
    """Cost breakdown for a specific model."""
    model: str
    cost: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    calls: int = 0

    def add(self, cost: float, input_t: int = 0, output_t: int = 0,
            cache_read: int = 0, cache_write: int = 0):
        self.cost += cost
        self.input_tokens += input_t
        self.output_tokens += output_t
        self.cache_read_tokens += cache_read
        self.cache_write_tokens += cache_write
        self.calls += 1


@dataclass
class ToolCost:
    """Cost attribution for a tool."""
    tool: str
    invocations: int = 0
    attributed_cost: float = 0.0
    turns_with_tool: int = 0


@dataclass
class SessionCost:
    """Cost data for a single session."""
    session_id: str
    project_hash: str
    project_path: str
    name: str
    total_cost: float = 0.0
    turn_count: int = 0
    message_count: int = 0
    model: Optional[str] = None
    created_at: Optional[str] = None
    last_activity: Optional[str] = None
    # Shadow git
    shadow_cost: float = 0.0  # Main model cost tracked by shadow
    summary_cost: float = 0.0   # Summary-fork cost for rich commits
    summary_calls: int = 0
    commit_count: int = 0
    # Model breakdown (when available)
    model_costs: dict = field(default_factory=dict)


@dataclass
class ProjectCost:
    """Cost data for a project."""
    project_hash: str
    project_path: str
    total_cost: float = 0.0
    session_count: int = 0
    turn_count: int = 0
    summary_overhead: float = 0.0
    sessions: list = field(default_factory=list)


@dataclass
class CostSummary:
    """Overall cost summary."""
    total_cost: float = 0.0
    total_sessions: int = 0
    total_turns: int = 0
    total_messages: int = 0
    # By model
    by_model: dict = field(default_factory=dict)  # model -> ModelCost
    # By project
    by_project: dict = field(default_factory=dict)  # hash -> ProjectCost
    # By tool
    by_tool: dict = field(default_factory=dict)  # tool -> ToolCost
    # By thread (main session vs Task subagents). Heuristic: any
    # model_usage entry whose model_id != the session's primary model
    # is attributed to subagents (Task tool fans out under different models).
    main_thread_cost: float = 0.0
    subagent_cost: float = 0.0
    subagent_calls: int = 0
    # Overhead
    shadow_summary_cost: float = 0.0
    shadow_summary_calls: int = 0
    # Cache stats
    total_cache_read: int = 0
    total_cache_write: int = 0
    # Time range
    earliest_session: Optional[str] = None
    latest_activity: Optional[str] = None


class CostAnalyzer:
    """
    Analyzes cost data across all projects and sessions.

    Usage:
        analyzer = CostAnalyzer()
        summary = analyzer.get_summary()
        by_model = analyzer.get_by_model()
        by_project = analyzer.get_by_project()
    """

    def __init__(self):
        self.data_home = ensure_data_home()
        self.projects_dir = self.data_home / "projects"
        self._cache = {}
        self._cache_time = None

    def _get_project_path(self, project_hash: str) -> Optional[str]:
        """Read project path from the 'path' file."""
        return get_project_path_from_hash(project_hash)

    def _load_session_meta(self, meta_path: Path) -> Optional[dict]:
        """Load and parse session metadata."""
        try:
            return json.loads(meta_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, IOError):
            return None

    def _parse_raw_result(self, raw_path: Path) -> list[dict]:
        """Parse raw.jsonl for result messages with modelUsage."""
        results = []
        if not raw_path.exists():
            return results

        try:
            with open(raw_path, encoding="utf-8") as f:
                for line in f:
                    try:
                        entry = json.loads(line)
                        if entry.get("type") == "result" and entry.get("dir") == "out":
                            data = entry.get("data", "{}")
                            if isinstance(data, str):
                                data = json.loads(data)
                            if "modelUsage" in data or "total_cost_usd" in data:
                                results.append({
                                    "ts": entry.get("ts"),
                                    "cost": data.get("total_cost_usd", 0),
                                    "model_usage": data.get("modelUsage", {}),
                                    "usage": data.get("usage", {}),
                                    "duration_ms": data.get("duration_ms", 0),
                                    "num_turns": data.get("num_turns", 1),
                                })
                    except (json.JSONDecodeError, TypeError):
                        continue
        except IOError:
            pass

        return results

    def _parse_messages_for_tools(self, messages_path: Path) -> dict:
        """Parse messages.jsonl to count tool invocations per turn."""
        tool_counts = defaultdict(int)
        if not messages_path.exists():
            return dict(tool_counts)

        try:
            with open(messages_path, encoding="utf-8") as f:
                for line in f:
                    try:
                        msg = json.loads(line)
                        if msg.get("role") == "tool":
                            tool_name = msg.get("tool_name", "unknown")
                            tool_counts[tool_name] += 1
                    except json.JSONDecodeError:
                        continue
        except IOError:
            pass

        return dict(tool_counts)

    def _parse_messages_results(self, messages_path: Path) -> list[dict]:
        """Parse messages.jsonl for result messages with enriched model_usage.

        This is faster than parsing raw.jsonl since messages.jsonl is smaller
        and contains pre-parsed data.
        """
        results = []
        if not messages_path.exists():
            return results

        try:
            with open(messages_path, encoding="utf-8") as f:
                for line in f:
                    try:
                        msg = json.loads(line)
                        if msg.get("role") == "result":
                            results.append({
                                "ts": msg.get("timestamp"),
                                "cost": msg.get("cost_usd", 0),
                                "model_usage": msg.get("model_usage", {}),
                                "tokens": msg.get("tokens", {}),
                                "tools": msg.get("tools", []),
                                "duration_ms": msg.get("duration_ms", 0),
                                "num_turns": msg.get("num_turns", 1),
                            })
                    except json.JSONDecodeError:
                        continue
        except IOError:
            pass

        return results

    def _scan_sessions(self, project_hash: str) -> list[SessionCost]:
        """Scan all sessions in a project."""
        sessions = []
        project_path = self._get_project_path(project_hash)
        sessions_dir = self.projects_dir / project_hash / "sessions"

        if not sessions_dir.exists():
            return sessions

        for session_dir in sessions_dir.iterdir():
            if not session_dir.is_dir():
                continue

            meta_path = session_dir / "meta.json"
            meta = self._load_session_meta(meta_path)
            if not meta:
                continue

            session = SessionCost(
                session_id=meta.get("id", session_dir.name),
                project_hash=project_hash,
                project_path=project_path or "",
                name=meta.get("name", ""),
                total_cost=meta.get("total_cost", 0),
                message_count=meta.get("message_count", 0),
                model=meta.get("model"),
                created_at=meta.get("created_at"),
                last_activity=meta.get("last_activity"),
            )

            # Shadow git data
            shadow = meta.get("shadow", {})
            if shadow:
                session.shadow_cost = shadow.get("total_cost", 0)
                # Back-compat: the shadow.json keys were haiku_* before the rename.
                session.summary_cost = shadow.get("summary_cost", shadow.get("haiku_cost", 0))
                session.summary_calls = shadow.get("summary_calls", shadow.get("haiku_calls", 0))
                session.commit_count = shadow.get("turn_count", 0)

            # Try messages.jsonl first (faster, enriched format)
            # Fall back to raw.jsonl for older sessions without enriched data
            messages_path = session_dir / "messages.jsonl"
            results = self._parse_messages_results(messages_path)

            # Check if we got enriched model_usage data
            has_enriched = any(r.get("model_usage") for r in results)

            if not has_enriched:
                # Fall back to raw.jsonl for detailed model breakdown
                raw_path = session_dir / "raw.jsonl"
                results = self._parse_raw_result(raw_path)

            for result in results:
                session.turn_count += 1
                model_usage = result.get("model_usage") or {}

                for model_name, usage in model_usage.items():
                    if model_name not in session.model_costs:
                        session.model_costs[model_name] = {
                            "cost": 0, "input": 0, "output": 0,
                            "cache_read": 0, "cache_write": 0, "calls": 0
                        }
                    mc = session.model_costs[model_name]

                    # Handle both enriched format (compact keys) and raw format (full keys)
                    if "cost" in usage:
                        # Enriched format from messages.jsonl
                        mc["cost"] += usage.get("cost", 0)
                        mc["input"] += usage.get("in", 0)
                        mc["output"] += usage.get("out", 0)
                        mc["cache_read"] += usage.get("cache_read", 0)
                        mc["cache_write"] += usage.get("cache_write", 0)
                    else:
                        # Raw format from raw.jsonl
                        mc["cost"] += usage.get("costUSD", 0)
                        mc["input"] += usage.get("inputTokens", 0)
                        mc["output"] += usage.get("outputTokens", 0)
                        mc["cache_read"] += usage.get("cacheReadInputTokens", 0)
                        mc["cache_write"] += usage.get("cacheCreationInputTokens", 0)
                    mc["calls"] += 1

            sessions.append(session)

        return sessions

    def get_summary(
        self,
        project_hash: Optional[str] = None,
        session_id: Optional[str] = None,
        since: Optional[str] = None,
        until: Optional[str] = None,
    ) -> dict:
        """
        Get comprehensive cost summary.

        Args:
            project_hash: Filter by project
            session_id: Filter by session
            since: Start date (ISO format)
            until: End date (ISO format)

        Returns:
            Dictionary with cost breakdown
        """
        summary = CostSummary()

        # Determine which projects to scan
        if project_hash:
            project_hashes = [project_hash]
        else:
            project_hashes = [
                d.name for d in self.projects_dir.iterdir()
                if d.is_dir() and (d / "sessions").exists()
            ]

        # Parse date filters (ensure timezone-aware)
        since_dt = None
        until_dt = None
        if since:
            # Handle both full ISO timestamps and date-only strings
            if "T" in since:
                since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
            else:
                # Just a date like "2025-12-30" - add time and UTC timezone
                since_dt = datetime.fromisoformat(f"{since}T00:00:00+00:00")
        if until:
            if "T" in until:
                until_dt = datetime.fromisoformat(until.replace("Z", "+00:00"))
            else:
                # Just a date - set to end of day
                until_dt = datetime.fromisoformat(f"{until}T23:59:59+00:00")

        for ph in project_hashes:
            project_path = self._get_project_path(ph)
            sessions = self._scan_sessions(ph)

            project = ProjectCost(
                project_hash=ph,
                project_path=project_path or "",
            )

            for session in sessions:
                # Filter by session_id
                if session_id and session.session_id != session_id:
                    continue

                # Filter by date
                if since_dt and session.created_at:
                    try:
                        created = datetime.fromisoformat(session.created_at.replace("Z", "+00:00"))
                        if created < since_dt:
                            continue
                    except ValueError:
                        pass

                if until_dt and session.last_activity:
                    try:
                        activity = datetime.fromisoformat(session.last_activity.replace("Z", "+00:00"))
                        if activity > until_dt:
                            continue
                    except ValueError:
                        pass

                # Aggregate
                summary.total_cost += session.total_cost
                summary.total_sessions += 1
                summary.total_turns += session.turn_count or session.message_count // 2
                summary.total_messages += session.message_count

                # Shadow/summary overhead
                summary.shadow_summary_cost += session.summary_cost
                summary.shadow_summary_calls += session.summary_calls

                # Project aggregation
                project.total_cost += session.total_cost
                project.session_count += 1
                project.turn_count += session.turn_count
                project.summary_overhead += session.summary_cost
                project.sessions.append({
                    "id": session.session_id,
                    "name": session.name,
                    "cost": session.total_cost,
                    "messages": session.message_count,
                    "created": session.created_at,
                })

                # Model aggregation + thread split (main vs Task subagent)
                primary = session.model
                for model_name, mc in session.model_costs.items():
                    if model_name not in summary.by_model:
                        summary.by_model[model_name] = ModelCost(model=model_name)
                    m = summary.by_model[model_name]
                    m.cost += mc["cost"]
                    m.input_tokens += mc["input"]
                    m.output_tokens += mc["output"]
                    m.cache_read_tokens += mc["cache_read"]
                    m.cache_write_tokens += mc["cache_write"]
                    m.calls += mc["calls"]

                    # If session has no recorded primary model, attribute to
                    # main thread rather than guessing.
                    if primary and model_name != primary:
                        summary.subagent_cost += mc["cost"]
                        summary.subagent_calls += mc["calls"]
                    else:
                        summary.main_thread_cost += mc["cost"]

                # Track time range
                if session.created_at:
                    if not summary.earliest_session or session.created_at < summary.earliest_session:
                        summary.earliest_session = session.created_at
                if session.last_activity:
                    if not summary.latest_activity or session.last_activity > summary.latest_activity:
                        summary.latest_activity = session.last_activity

            if project.session_count > 0:
                summary.by_project[ph] = project

        # Calculate cache totals
        for m in summary.by_model.values():
            summary.total_cache_read += m.cache_read_tokens
            summary.total_cache_write += m.cache_write_tokens

        return self._summary_to_dict(summary)

    def _summary_to_dict(self, summary: CostSummary) -> dict:
        """Convert summary to JSON-serializable dict."""
        # Calculate cache efficiency
        total_input = sum(m.input_tokens + m.cache_read_tokens for m in summary.by_model.values())
        cache_hit_rate = (summary.total_cache_read / total_input * 100) if total_input > 0 else 0

        # Estimate cache savings (cache reads are much cheaper than fresh input)
        # Rough estimate: cache read is ~10% cost of fresh input
        cache_savings_tokens = summary.total_cache_read * 0.9

        # TRUE total includes shadow git overhead (it's a real cost!)
        work_cost = summary.total_cost  # Cost from main Claude conversations
        overhead_cost = summary.shadow_summary_cost  # Shadow git summary-fork cost
        true_total = work_cost + overhead_cost

        # Build model breakdown, merging shadow summary cost into Haiku model
        by_model_merged = {}
        for name, m in summary.by_model.items():
            by_model_merged[name] = {
                "cost": round(m.cost, 6),
                "input_tokens": m.input_tokens,
                "output_tokens": m.output_tokens,
                "cache_read_tokens": m.cache_read_tokens,
                "cache_write_tokens": m.cache_write_tokens,
                "calls": m.calls,
                "pct": round(m.cost / true_total * 100, 1) if true_total > 0 else 0,
            }

        # Merge shadow summary cost into Haiku model entry
        haiku_key = None
        for name in by_model_merged:
            if "haiku" in name.lower():
                haiku_key = name
                break

        if overhead_cost > 0:
            if haiku_key:
                # Add shadow git cost to existing Haiku entry
                by_model_merged[haiku_key]["cost"] = round(
                    by_model_merged[haiku_key]["cost"] + overhead_cost, 6
                )
                by_model_merged[haiku_key]["calls"] += summary.shadow_summary_calls
                by_model_merged[haiku_key]["pct"] = round(
                    by_model_merged[haiku_key]["cost"] / true_total * 100, 1
                ) if true_total > 0 else 0
                # Add breakdown detail
                by_model_merged[haiku_key]["breakdown"] = {
                    "conversation": round(by_model_merged[haiku_key]["cost"] - overhead_cost, 6),
                    "shadow_git": round(overhead_cost, 6),
                }
            else:
                # Create Haiku entry for shadow git only
                by_model_merged[get_summary_model()] = {
                    "cost": round(overhead_cost, 6),
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                    "calls": summary.shadow_summary_calls,
                    "pct": round(overhead_cost / true_total * 100, 1) if true_total > 0 else 0,
                    "breakdown": {
                        "conversation": 0,
                        "shadow_git": round(overhead_cost, 6),
                    },
                }

        # Sort by cost descending
        by_model_sorted = dict(sorted(by_model_merged.items(), key=lambda x: -x[1]["cost"]))

        return {
            "total_cost": round(true_total, 6),  # TRUE total including overhead
            "work_cost": round(work_cost, 6),    # Main conversation cost
            "total_sessions": summary.total_sessions,
            "total_turns": summary.total_turns,
            "total_messages": summary.total_messages,

            "by_model": by_model_sorted,

            "by_project": {
                ph: {
                    "path": p.project_path,
                    "name": Path(p.project_path).name if p.project_path else ph,
                    "cost": round(p.total_cost + p.summary_overhead, 6),  # Include overhead
                    "work_cost": round(p.total_cost, 6),
                    "sessions": p.session_count,
                    "turns": p.turn_count,
                    "summary_overhead": round(p.summary_overhead, 6),
                    "top_sessions": sorted(p.sessions, key=lambda x: -x["cost"])[:5],
                }
                for ph, p in sorted(summary.by_project.items(), key=lambda x: -(x[1].total_cost + x[1].summary_overhead))
            },

            "overhead": {
                "summary_cost": round(overhead_cost, 6),
                "summary_calls": summary.shadow_summary_calls,
                "summary_pct": round(overhead_cost / true_total * 100, 2) if true_total > 0 else 0,
            },

            "by_thread": {
                "main_thread": {
                    "cost": round(summary.main_thread_cost, 6),
                    "pct": round(summary.main_thread_cost / true_total * 100, 1) if true_total > 0 else 0,
                },
                "subagents": {
                    "cost": round(summary.subagent_cost, 6),
                    "calls": summary.subagent_calls,
                    "pct": round(summary.subagent_cost / true_total * 100, 1) if true_total > 0 else 0,
                },
                "shadow_git": {
                    "cost": round(overhead_cost, 6),
                    "calls": summary.shadow_summary_calls,
                    "pct": round(overhead_cost / true_total * 100, 1) if true_total > 0 else 0,
                },
            },

            "cache": {
                "read_tokens": summary.total_cache_read,
                "write_tokens": summary.total_cache_write,
                "hit_rate_pct": round(cache_hit_rate, 1),
                "estimated_savings_tokens": int(cache_savings_tokens),
            },

            "time_range": {
                "earliest": summary.earliest_session,
                "latest": summary.latest_activity,
            },
        }

    def get_sessions_ranked(
        self,
        limit: int = 20,
        project_hash: Optional[str] = None,
    ) -> list[dict]:
        """Get sessions ranked by cost."""
        all_sessions = []

        if project_hash:
            project_hashes = [project_hash]
        else:
            project_hashes = [
                d.name for d in self.projects_dir.iterdir()
                if d.is_dir() and (d / "sessions").exists()
            ]

        for ph in project_hashes:
            sessions = self._scan_sessions(ph)
            all_sessions.extend(sessions)

        # Sort by TRUE cost (including shadow git overhead) descending
        all_sessions.sort(key=lambda s: -(s.total_cost + s.summary_cost))

        result = []
        for s in all_sessions[:limit]:
            # TRUE cost includes shadow git summary overhead
            true_cost = s.total_cost + s.summary_cost

            # Build model breakdown, merging shadow summary cost if present
            model_breakdown = None
            if s.model_costs:
                model_breakdown = {}
                for name, mc in s.model_costs.items():
                    model_breakdown[name] = {"cost": round(mc["cost"], 6), "calls": mc["calls"]}

                # Merge shadow summary cost into Haiku entry
                if s.summary_cost > 0:
                    haiku_key = None
                    for name in model_breakdown:
                        if "haiku" in name.lower():
                            haiku_key = name
                            break

                    if haiku_key:
                        conv_cost = model_breakdown[haiku_key]["cost"]
                        model_breakdown[haiku_key]["cost"] = round(conv_cost + s.summary_cost, 6)
                        model_breakdown[haiku_key]["calls"] += s.summary_calls
                        model_breakdown[haiku_key]["breakdown"] = {
                            "conversation": conv_cost,
                            "shadow_git": round(s.summary_cost, 6),
                        }
                    else:
                        # Create Haiku entry for shadow git only
                        model_breakdown[get_summary_model()] = {
                            "cost": round(s.summary_cost, 6),
                            "calls": s.summary_calls,
                            "breakdown": {
                                "conversation": 0,
                                "shadow_git": round(s.summary_cost, 6),
                            },
                        }

            result.append({
                "id": s.session_id,
                "project": Path(s.project_path).name if s.project_path else s.project_hash,
                "project_hash": s.project_hash,
                "name": s.name,
                "cost": round(true_cost, 6),  # TRUE cost including overhead
                "work_cost": round(s.total_cost, 6),  # Main conversation cost
                "messages": s.message_count,
                "turns": s.turn_count,
                "model": s.model,
                "summary_overhead": round(s.summary_cost, 6),
                "created": s.created_at,
                "last_activity": s.last_activity,
                "model_breakdown": model_breakdown,
            })

        return result

    def get_tool_attribution(
        self,
        project_hash: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> dict:
        """
        Get tool cost attribution.

        This is an estimate - we attribute turn cost proportionally
        to tools used in that turn.
        """
        tool_stats = defaultdict(lambda: {"invocations": 0, "turns": 0, "attributed_cost": 0.0})

        if project_hash:
            project_hashes = [project_hash]
        else:
            project_hashes = [
                d.name for d in self.projects_dir.iterdir()
                if d.is_dir() and (d / "sessions").exists()
            ]

        for ph in project_hashes:
            sessions_dir = self.projects_dir / ph / "sessions"
            if not sessions_dir.exists():
                continue

            for session_dir in sessions_dir.iterdir():
                if not session_dir.is_dir():
                    continue

                if session_id and session_dir.name != session_id:
                    continue

                messages_path = session_dir / "messages.jsonl"
                raw_path = session_dir / "raw.jsonl"

                # Get per-turn costs
                turn_costs = {}
                for result in self._parse_raw_result(raw_path):
                    ts = result.get("ts", "")
                    turn_costs[ts] = result.get("cost", 0)

                # Get tool invocations grouped by approximate turn
                if not messages_path.exists():
                    continue

                current_turn_tools = []
                current_turn_ts = None

                try:
                    with open(messages_path, encoding="utf-8") as f:
                        for line in f:
                            msg = json.loads(line)
                            ts = msg.get("timestamp", "")

                            if msg.get("role") == "tool":
                                tool_name = msg.get("tool_name", "unknown")
                                tool_stats[tool_name]["invocations"] += 1
                                if tool_name not in current_turn_tools:
                                    current_turn_tools.append(tool_name)
                                current_turn_ts = ts

                            elif msg.get("role") == "result":
                                # End of turn - attribute cost
                                cost = msg.get("cost_usd", 0)
                                if current_turn_tools and cost > 0:
                                    per_tool = cost / len(current_turn_tools)
                                    for tool in current_turn_tools:
                                        tool_stats[tool]["attributed_cost"] += per_tool
                                        tool_stats[tool]["turns"] += 1
                                current_turn_tools = []

                except (json.JSONDecodeError, IOError):
                    continue

        # Sort by attributed cost
        sorted_tools = sorted(
            tool_stats.items(),
            key=lambda x: -x[1]["attributed_cost"]
        )

        total_cost = sum(t[1]["attributed_cost"] for t in sorted_tools)

        return {
            "tools": {
                name: {
                    "invocations": stats["invocations"],
                    "turns_with_tool": stats["turns"],
                    "attributed_cost": round(stats["attributed_cost"], 6),
                    "avg_per_invocation": round(stats["attributed_cost"] / stats["invocations"], 6) if stats["invocations"] > 0 else 0,
                    "pct": round(stats["attributed_cost"] / total_cost * 100, 1) if total_cost > 0 else 0,
                }
                for name, stats in sorted_tools
            },
            "total_attributed": round(total_cost, 6),
        }

    def get_trends(
        self,
        period: str = "daily",  # daily, weekly, monthly
        project_hash: Optional[str] = None,
        days: int = 30,
    ) -> dict:
        """Get cost trends over time."""
        from datetime import timedelta

        # Aggregate by date
        by_date = defaultdict(lambda: {"cost": 0, "sessions": 0, "turns": 0})

        if project_hash:
            project_hashes = [project_hash]
        else:
            project_hashes = [
                d.name for d in self.projects_dir.iterdir()
                if d.is_dir() and (d / "sessions").exists()
            ]

        for ph in project_hashes:
            sessions = self._scan_sessions(ph)

            for session in sessions:
                if not session.created_at:
                    continue

                try:
                    dt = datetime.fromisoformat(session.created_at.replace("Z", "+00:00"))

                    if period == "daily":
                        key = dt.strftime("%Y-%m-%d")
                    elif period == "weekly":
                        # Week start (Monday)
                        week_start = dt - timedelta(days=dt.weekday())
                        key = week_start.strftime("%Y-%m-%d")
                    else:  # monthly
                        key = dt.strftime("%Y-%m")

                    by_date[key]["cost"] += session.total_cost
                    by_date[key]["sessions"] += 1
                    by_date[key]["turns"] += session.turn_count

                except ValueError:
                    continue

        # Sort by date
        sorted_dates = sorted(by_date.items())

        return {
            "period": period,
            "data": [
                {
                    "date": date,
                    "cost": round(stats["cost"], 6),
                    "sessions": stats["sessions"],
                    "turns": stats["turns"],
                }
                for date, stats in sorted_dates[-days:]
            ],
            "totals": {
                "cost": round(sum(s["cost"] for _, s in sorted_dates), 6),
                "sessions": sum(s["sessions"] for _, s in sorted_dates),
                "turns": sum(s["turns"] for _, s in sorted_dates),
            },
        }

    def get_efficiency_metrics(
        self,
        project_hash: Optional[str] = None,
    ) -> dict:
        """Calculate efficiency metrics."""
        summary = self.get_summary(project_hash=project_hash)

        total_cost = summary["total_cost"]
        total_turns = summary["total_turns"] or 1
        total_messages = summary["total_messages"] or 1

        # Calculate totals from model breakdown
        total_input = sum(m["input_tokens"] for m in summary["by_model"].values())
        total_output = sum(m["output_tokens"] for m in summary["by_model"].values())
        cache_read = summary["cache"]["read_tokens"]
        cache_write = summary["cache"]["write_tokens"]

        # Estimate what cost would be without cache
        # Cache reads cost ~10% of fresh input (rough estimate for Claude)
        # So savings = cache_read * 0.9 * input_price_per_token
        # For Opus: ~$15/M input, so ~$0.000015 per token
        # Savings per cached token: ~$0.0000135
        estimated_no_cache_cost = total_cost + (cache_read * 0.0000135)

        return {
            "cost_per_turn": round(total_cost / total_turns, 4) if total_turns else 0,
            "cost_per_message": round(total_cost / total_messages, 4) if total_messages else 0,
            "tokens_per_dollar": {
                "input": int(total_input / total_cost) if total_cost > 0 else 0,
                "output": int(total_output / total_cost) if total_cost > 0 else 0,
            },
            "cache_efficiency": {
                "hit_rate_pct": summary["cache"]["hit_rate_pct"],
                "estimated_savings": round(estimated_no_cache_cost - total_cost, 4),
                "savings_pct": round((1 - total_cost / estimated_no_cache_cost) * 100, 1) if estimated_no_cache_cost > 0 else 0,
            },
            "overhead": {
                "summary_pct": summary["overhead"]["summary_pct"],
                "summary_cost": summary["overhead"]["summary_cost"],
                "work_efficiency_pct": round(100 - summary["overhead"]["summary_pct"], 2),
            },
            "model_efficiency": {
                name: {
                    "cost_per_1k_input": round(m["cost"] / (m["input_tokens"] / 1000), 4) if m["input_tokens"] > 0 else 0,
                    "cost_per_1k_output": round(m["cost"] / (m["output_tokens"] / 1000), 4) if m["output_tokens"] > 0 else 0,
                }
                for name, m in summary["by_model"].items()
            },
        }


# Convenience function for quick summary
def get_cost_summary(**kwargs) -> dict:
    """Quick access to cost summary."""
    return CostAnalyzer().get_summary(**kwargs)
