"""
Cost Analytics API Routes - Cost tracking and analysis across sessions

These endpoints provide comprehensive cost tracking including summaries,
session rankings, tool attribution, trends, and efficiency metrics.
"""

import logging

from fastapi import APIRouter

from painapple_code.cost_analytics import CostAnalyzer

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/costs", tags=["costs"])


# ═══════════════════════════════════════════════════════════════════════
# Cost Analyzer Singleton
# ═══════════════════════════════════════════════════════════════════════

_cost_analyzer = None


def get_cost_analyzer() -> CostAnalyzer:
    """Get or create the cost analyzer singleton."""
    global _cost_analyzer
    if _cost_analyzer is None:
        _cost_analyzer = CostAnalyzer()
    return _cost_analyzer


# ═══════════════════════════════════════════════════════════════════════
# Cost Endpoints
# ═══════════════════════════════════════════════════════════════════════

@router.get("")
async def get_costs_summary(
    project: str = None,
    session: str = None,
    since: str = None,
    until: str = None,
):
    """
    Get comprehensive cost summary.

    Query params:
    - project: Filter by project hash
    - session: Filter by session ID
    - since: Start date (ISO format, e.g., 2025-12-01)
    - until: End date (ISO format, e.g., 2025-12-31)
    """
    analyzer = get_cost_analyzer()
    return analyzer.get_summary(
        project_hash=project,
        session_id=session,
        since=since,
        until=until,
    )


@router.get("/sessions")
async def get_costs_sessions(
    limit: int = 20,
    project: str = None,
):
    """
    Get sessions ranked by cost.

    Query params:
    - limit: Max sessions to return (default 20)
    - project: Filter by project hash
    """
    analyzer = get_cost_analyzer()
    return {"sessions": analyzer.get_sessions_ranked(limit=limit, project_hash=project)}


@router.get("/tools")
async def get_costs_tools(
    project: str = None,
    session: str = None,
):
    """
    Get tool cost attribution (estimated).

    Attributes turn cost proportionally to tools used in that turn.

    Query params:
    - project: Filter by project hash
    - session: Filter by session ID
    """
    analyzer = get_cost_analyzer()
    return analyzer.get_tool_attribution(project_hash=project, session_id=session)


@router.get("/trends")
async def get_costs_trends(
    period: str = "daily",
    project: str = None,
    days: int = 30,
):
    """
    Get cost trends over time.

    Query params:
    - period: Aggregation period (daily, weekly, monthly)
    - project: Filter by project hash
    - days: Number of periods to return (default 30)
    """
    analyzer = get_cost_analyzer()
    return analyzer.get_trends(period=period, project_hash=project, days=days)


@router.get("/efficiency")
async def get_costs_efficiency(
    project: str = None,
):
    """
    Get efficiency metrics.

    Returns cost per turn, tokens per dollar, cache efficiency, etc.

    Query params:
    - project: Filter by project hash
    """
    analyzer = get_cost_analyzer()
    return analyzer.get_efficiency_metrics(project_hash=project)
