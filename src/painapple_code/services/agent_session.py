"""
Agent Session Management

Core classes for managing AI-agent (provider) subprocess sessions:
- TaskInfo: Tracks active Task sub-agents for tool grouping
- AgentSession: Manages a single provider subprocess session
- AgentBridge: Bridge between WebSocket clients and provider (CLI agent) processes
"""

import asyncio
import copy
import itertools
import json
import logging
import os
import re
import signal
import time
import traceback
from datetime import datetime, timezone
from typing import Optional, Dict, List, Any
from dataclasses import dataclass, field

from fastapi import WebSocket
from starlette.websockets import WebSocketState

from painapple_code.session_store import SessionStore
from painapple_code.shadow_git import ShadowGit, CostInfo, get_shadow_git
from painapple_code.turn_tracker import (
    TurnTracker, summarize_edit_output, summarize_write_output,
)
from painapple_code.utils.agent_cli import read_line_unlimited
from painapple_code.utils.file_paths import (
    extract_file_links, add_verified_files_to_message, parse_edit_line_number,
)
from painapple_code.utils.token_profiles import build_env as build_token_env, resolve_profile
from painapple_code.providers import (
    Provider, CostState, LaunchOptions, StderrClass, get_provider,
)

logger = logging.getLogger("painapple-code.session")

# Regex to strip ANSI escape sequences and dangerous control characters from log output.
# Without this, raw escape sequences from Claude CLI stderr (bracketed paste mode,
# cursor hide, alternate screen, etc.) leak to the terminal and freeze it.
_ANSI_ESCAPE_RE = re.compile(
    r'\x1b'          # ESC character
    r'(?:'
    r'\[[0-9;]*[a-zA-Z]'   # CSI sequences: ESC [ ... letter (colors, modes, cursor)
    r'|\[\?[0-9;]*[hlm]'   # Private mode set/reset: ESC [ ? ... h/l/m
    r'|\][^\x07\x1b]*(?:\x07|\x1b\\)'  # OSC sequences: ESC ] ... BEL/ST
    r'|\([A-Z]'             # Character set: ESC ( A-Z
    r'|[=>]'                # Keypad mode: ESC = / ESC >
    r')'
)

# Retryable/non-retryable API-error classification now lives on the provider
# (`provider.is_retryable_api_error`) since the patterns are CLI-specific.


def _sanitize_for_log(text: str) -> str:
    """Strip ANSI escape sequences and dangerous control chars for safe terminal logging."""
    text = _ANSI_ESCAPE_RE.sub('', text)
    # Strip control chars (keep \t, \n, \r) — especially \x13 (XOFF) which freezes terminals
    return ''.join(c for c in text if c >= ' ' or c in '\t\n\r')


# Dispatch table for tool usage tracking in shadow git.
# Maps tool_name -> (summary_func, status_label).
# summary_func takes tool_input and returns a short description string.
_TOOL_SUMMARY_DISPATCH = {
    "Bash":     (lambda i: i.get("command", "")[:100], "running..."),
    "Read":     (lambda i: i.get("file_path", ""), "reading..."),
    "Glob":     (lambda i: i.get("pattern", ""), "searching..."),
    "Grep":     (lambda i: f"'{i.get('pattern', '')}' in {i.get('path', '.')}"[:100], "searching..."),
    "LSP":      (lambda i: f"{i.get('operation', '')} at {i.get('filePath', '')}:{i.get('line', 0)}"[:100], "analyzing..."),
    "WebFetch": (lambda i: i.get("url", "")[:100], "fetching..."),
    "Task":     (lambda i: i.get("description", "")[:100], "running..."),
}


def _track_tool_usage(tracker: "TurnTracker", tool_name: str, tool_input: dict):
    """Track tool usage via dispatch table, with generic fallback."""
    entry = _TOOL_SUMMARY_DISPATCH.get(tool_name)
    if entry:
        summary_fn, status = entry
        tracker.add_tool_usage(tool_name, summary_fn(tool_input), status)
    else:
        input_str = str(tool_input)[:100] if tool_input else ""
        tracker.add_tool_usage(tool_name, input_str, "...")


@dataclass
class TaskInfo:
    """Tracks an active Task sub-agent for tool grouping."""
    task_id: str
    start_order: int  # For deterministic ordering of parallel tasks
    child_tool_ids: List[str] = field(default_factory=list)
    is_background: bool = False  # From tool input run_in_background


@dataclass
class AgentSession:
    """Manages a provider (CLI agent) subprocess session.

    Sessions are keyed by store_id and persist beyond WebSocket connections.
    The WebSocket can attach/detach while the agent continues running.
    """
    store_id: str  # Required - server-side session ID (for persistence)
    cwd: str = "."
    process: Optional[asyncio.subprocess.Process] = None
    # ALL attached clients — frames broadcast to every one of them. The old
    # single-slot model (one `websocket`, overwritten on attach) silently
    # starved every viewer but the latest: whichever tab/device/token wasn't
    # holding the slot when the turn's result frame fired stayed stuck on
    # "working" forever. Multi-client is a first-class reality (iPad + desktop
    # + second auth token on the same session), so delivery must be too.
    websockets: List[WebSocket] = field(default_factory=list)
    session_id: Optional[str] = None  # Claude Code's internal session ID (for --resume)
    is_running: bool = False  # True when the agent process is active
    is_idle: bool = True      # True when waiting for input (not actively processing)
    _read_task: Optional[asyncio.Task] = None
    _stderr_task: Optional[asyncio.Task] = None
    # Thinking mode tracking
    in_thinking_mode: bool = False
    current_thinking_msg_index: Optional[int] = None  # Index of thinking message in store
    thinking_tool_ids: set = None  # Tool IDs that belong to current thinking block
    # Task sub-agent tracking (for live tool nesting)
    active_tasks: Dict[str, TaskInfo] = None  # task_id -> TaskInfo
    tool_to_task_map: Dict[str, str] = None   # tool_id -> parent task_id
    # Edit tool tracking (for server-side line number parsing)
    edit_tool_inputs: Dict[str, dict] = None  # tool_id -> {old_string, new_string}
    task_order_counter: int = 0               # Incrementing counter for ordering
    # Lifecycle tracking
    last_activity: float = None  # timestamp of last activity
    created_at: float = None
    # Fork tracking
    fork_from_session_id: Optional[str] = None  # Claude session ID to fork from (uses --fork-session)
    # Compacting state (for UI feedback on reconnect)
    is_compacting: bool = False
    compaction_failed: bool = False  # Set when a /compact settles with compact_result=failed
    _turn_heartbeat_task: Optional[asyncio.Task] = None  # Periodic pings while a turn is active
    # Lazy persistence - don't store empty sessions
    _store_meta: dict = None  # Pending store metadata (not yet persisted)
    # Stale session tracking - skip generic "exited unexpectedly" when specific error sent
    _stale_session_error_sent: bool = False
    # Why the last start_agent attempt failed (user-facing, e.g. binary not
    # found). Cleared on every attempt; WS handlers prefer it over the generic
    # "Failed to start ..." message.
    start_error: Optional[str] = None
    # Guard flag: set by interrupt_agent to prevent _cleanup_process race
    _interrupting: bool = False
    # Auto-stop: tool requiring user input detected (AskUserQuestion, ExitPlanMode)
    _pending_input_tool: Optional[str] = None
    # Plan-approval gate armed: set when /plan command runs or Claude calls EnterPlanMode.
    # Only when armed does ExitPlanMode trigger a SIGINT. Disarmed one-shot after firing,
    # so the resumed turn's acknowledgment-ExitPlanMode doesn't kill Claude mid-implementation.
    _plan_sigint_armed: bool = False
    # Suppress AskUserQuestion retries: track tool_use_id of first Ask in this turn.
    # Subsequent AskUserQuestion calls (auto-deny retries) are not forwarded to client.
    _ask_tool_id: Optional[str] = None
    # tool_use_ids of suppressed AskUserQuestion retries — their auto-deny tool_results
    # are matched against this set, so unrelated tool_results aren't dropped.
    _suppressed_ask_ids: set = None
    # Comment thread flag - skip shadow git for discussion threads
    is_comment_thread: bool = False
    store_persisted: bool = False  # True once persisted to disk
    # Permission mode for Claude CLI (None = inherit global default → dontAsk fallback)
    permission_mode: Optional[str] = None  # None falls through to global config or dontAsk
    # The permission_mode the live process was launched with. Lets _handle_user_message
    # detect a later change and respawn the idle process (universal lazy mode-apply).
    _launched_permission_mode: Optional[str] = None
    # The *resolved* mode the process launched with (the snapshot above is the
    # desired value and may be None = inherit default). Immutable for the
    # process lifetime — set only by start_agent. Consulted by the
    # live-controls bypass guard: a bypassPermissions launch attaches no
    # can_use_tool gate (claude_sdk/driver.py), so switching out of bypass
    # must respawn, never live-apply. Gate attachment is a spawn-time
    # property, which is why live mode switches don't update this.
    _launched_resolved_mode: Optional[str] = None
    # OAuth token profile (file name from ~/.config/painapple-code/tokens/)
    token_profile: Optional[str] = None  # None = inherit parent env auth
    # Preferred model (e.g. claude-sonnet-4-7, claude-opus-4-7)
    preferred_model: Optional[str] = None  # None = use CLI/account default
    # Effort level (low, medium, high, xhigh, max) — controls token spend / thoroughness
    effort_level: Optional[str] = None  # None = CLI default (high)
    # One-shot effort revert: when a turn is sent with msg.effort_level, we
    # stash the prior persistent value here. _finalize_turn restores it and
    # kills the idle process so the next turn respawns with the original.
    # Sentinel "_UNSET" distinguishes "not armed" from "armed with None".
    _oneshot_revert_effort: Any = "_UNSET"
    # Rate limit detection (set per-turn, reset after finalize)
    is_rate_limited: bool = False
    # API error auto-retry state
    _api_retry_count: int = 0       # Retries attempted this turn
    _api_retry_max: int = 3         # Max retries (loaded from config on start_agent)
    _api_retry_pending: bool = False  # True while waiting for retry delay
    _api_error_detected: bool = False  # Suppresses stderr/result forwarding during retry
    _last_agent_msg: Optional[dict] = None  # Last message sent to Claude (for resend)
    # Auth-failure state. The CLI retries a 401 up to ~10x (~60s) via
    # system/api_retry events before surfacing the result, so we detect the
    # auth failure on those retry events and abort early instead of making the
    # user wait out the doomed loop.
    _auth_retry_count: int = 0          # Consecutive 401 api_retry events this turn
    _auth_error_signaled: bool = False  # True once the re-login affordance was sent
    # Shadow Git - file recovery & session history
    turn_tracker: TurnTracker = None  # Tracks tool usage and file mods per turn
    turn_number: int = 0  # Current turn number (incremented on each result)
    # The CLI agent backing this session. Owns command construction, output
    # parsing, cost normalization, and error classification. Defaults to Claude.
    provider: Optional[Provider] = None
    # Per-subprocess cost tracker (used by providers whose CLI reports cumulative
    # totals, e.g. Claude). Reset to a fresh state on every process_start.
    _cost_state: Optional[CostState] = None
    # --- Ephemeral (non-persistent) provider state, e.g. Codex --------------
    # Ephemeral providers spawn one subprocess per turn with the prompt in argv.
    # These hold the turn's pending prompt/images until start_agent embeds them,
    # the per-subprocess event-translation scratch space, and a flag tracking
    # whether the turn produced a result (so a clean exit isn't mis-finalized).
    _pending_prompt: Optional[str] = None
    _pending_images: Optional[list] = None
    _xlate_state: dict = None
    _ephemeral_saw_result: bool = False
    # --- JSON-RPC transport state (e.g. Codex app-server) -------------------
    # Providers with capabilities.transport == "jsonrpc" supply a transport
    # driver (provider.make_transport) that owns the bidirectional JSON-RPC
    # conversation. Set on each (re)start; the send/intake/interrupt paths
    # delegate to it. None for line-protocol providers (Claude, Codex exec).
    _transport: Optional[object] = None
    # --- Interactive permissions (capabilities.interactive_permissions) -----
    # request_id → the provider's permission_request event, kept while the
    # process awaits the user's decision. Re-sent to the client on reconnect;
    # cleared on every process (re)start — a pending ask dies with its process.
    _pending_permission_requests: dict = None
    # --- Live controls (capabilities.live_controls) --------------------------
    # control_id → Future resolved by the driver's control_done ack (True on
    # ok, False on nack). Cleared on every process (re)start — an in-flight
    # control belongs to the stdin that received it.
    _pending_control: dict = None
    # Watchdog armed after a graceful (control-plane) interrupt of an active
    # turn: if the aborted turn's result frame never arrives, the process is
    # killed after a grace window — escalation back to SIGINT semantics.
    _interrupt_watchdog: Optional[asyncio.Task] = None

    def __post_init__(self):
        self.thinking_tool_ids = set()
        self._suppressed_ask_ids = set()
        self._pending_permission_requests = {}
        self._pending_control = {}
        if self._xlate_state is None:
            self._xlate_state = {}
        self.active_tasks = {}
        self.tool_to_task_map = {}
        self.edit_tool_inputs = {}
        now = time.time()
        if self.last_activity is None:
            self.last_activity = now
        if self.created_at is None:
            self.created_at = now
        # Initialize turn tracker for shadow git
        if self.turn_tracker is None:
            self.turn_tracker = TurnTracker()
        # Resolve provider (default Claude) and seed its per-process cost tracker.
        if self.provider is None:
            self.provider = get_provider()
        if self._cost_state is None:
            self._cost_state = self.provider.new_cost_state()

    def ensure_persisted(self):
        """Persist session to disk if not already done. Call before logging."""
        if not self.store_persisted and self._store_meta:
            self._store_meta = SessionStore.persist(self._store_meta)
            self.store_persisted = True
            logger.info(f"Session {self.store_id} persisted to disk")

    @property
    def ws_connected(self) -> bool:
        """Check if at least one WebSocket client is attached."""
        return bool(self.websockets)

    def touch(self):
        """Update last activity timestamp."""
        self.last_activity = time.time()

    def assign_tool_to_task(self, tool_id: str) -> Optional[str]:
        """
        Assign a tool to an active Task for sub-agent grouping.

        Strategy:
        - If 1 active Task: Assign to it (100% accurate)
        - If multiple active Tasks: Assign to most recent (by start_order)
        - If 0 active Tasks: Return None
        """
        if not self.active_tasks:
            return None

        if len(self.active_tasks) == 1:
            task = next(iter(self.active_tasks.values()))
        else:
            # Multiple active Tasks - use most recent (highest start_order)
            task = max(self.active_tasks.values(), key=lambda t: t.start_order)

        task.child_tool_ids.append(tool_id)
        return task.task_id

    def clear_task_tracking(self):
        """Clear all task tracking state (called on result/end of turn)."""
        self.active_tasks = {}
        self.tool_to_task_map = {}
        self.task_order_counter = 0

    async def safe_send(self, data: dict) -> bool:
        """Broadcast to every attached WebSocket, pruning dead ones.

        Returns True if at least one client received the frame. No clients is
        fine — output is always saved to the store and reconciled on sync.
        """
        if not self.websockets:
            return False
        delivered = False
        for ws in list(self.websockets):
            try:
                await ws.send_json(data)
                delivered = True
            except Exception as e:
                logger.debug(f"Failed to send to WebSocket: {e}")
                # Prune the dead socket; its handler's finally-detach is a no-op
                try:
                    self.websockets.remove(ws)
                except ValueError:
                    pass
        return delivered

    def attach_websocket(self, ws: WebSocket):
        """Attach a WebSocket client (additive — broadcast fan-out, no takeover).

        Prunes sockets whose connection is already gone so silent client drops
        (iPad PWA suspends) can't accumulate ghost entries.
        """
        self.websockets = [
            w for w in self.websockets
            if w.client_state == WebSocketState.CONNECTED
        ]
        if ws not in self.websockets:
            self.websockets.append(ws)
        self.touch()
        logger.info(f"WebSocket attached to session {self.store_id} "
                    f"({len(self.websockets)} client(s))")

    def detach_websocket(self, ws: "WebSocket | None" = None):
        """Detach a WebSocket client (agent keeps running).

        Each connection handler detaches only its own socket, so one tab
        closing never severs another tab's stream. ws=None clears all
        (shutdown/cleanup callers).
        """
        if ws is None:
            self.websockets = []
            logger.info(f"WebSocket detached from session {self.store_id} (all)")
            return
        if ws in self.websockets:
            self.websockets.remove(ws)
            logger.info(f"WebSocket detached from session {self.store_id} "
                        f"({len(self.websockets)} client(s) left)")
        else:
            logger.debug(f"Skipping detach for session {self.store_id} — websocket not attached")

    async def handle_stale_session(self):
        """Handle stale session detection (session ID no longer valid in Claude CLI).

        Called when either stdout or stderr reports "No conversation found with session ID".
        Clears the session ID so the next message starts fresh.
        """
        self.session_id = None
        self._stale_session_error_sent = True
        if self.store_id:
            SessionStore.update_metadata(self.store_id, provider_session_id=None)
        await self.safe_send({
            "type": "error",
            "message": "Previous session expired. Send your message again to start fresh.",
            "recoverable": True,
        })


async def _complete_db_turn_no_activity(db_turn_id: str, result_msg: dict, turn_number: int,
                                        main_thread_model: Optional[str] = None):
    """Complete a DB turn that had no tool activity (no shadow git commit)."""
    try:
        from painapple_code.shadow_db import get_shadow_db
        db = get_shadow_db()
        await db.acomplete_turn(
            db_turn_id,
            result_msg=result_msg,
            status="completed",
            main_thread_model=main_thread_model,
        )
    except Exception as e:
        logger.warning(f"Shadow DB complete (no-activity) failed: {e}")


async def _background_shadow_commit(
    session: AgentSession,
    shadow: "ShadowGit",
    cost_info: CostInfo,
    tracker_snapshot: TurnTracker,
    turn_number: int,
    provider_session_id: Optional[str],
    result_msg: Optional[dict] = None,
    session_model: Optional[str] = None,
):
    """
    Run shadow git commit in background without blocking user prompts.

    This allows the user to send their next message immediately while
    The summary fork generates rich commit messages (can take up to 90 seconds).

    Cancelled automatically when user sends a new prompt.
    """
    try:
        commit_hash, session_title = await shadow.commit_turn(
            session_id=session.store_id,
            turn_num=turn_number,
            tracker=tracker_snapshot,
            cost_info=cost_info,
            provider_session_id=provider_session_id,
            result_msg=result_msg,
            token_profile=resolve_profile(session.token_profile, session.provider),
            session_model=session_model,
            provider=session.provider,
        )
        if commit_hash:
            logger.info(f"Shadow Git commit: {commit_hash} for turn {turn_number}")
        # Notify client of session name update from the summary fork
        if session_title:
            logger.info(f"Session title updated: {session_title}")
            await session.safe_send({
                "type": "session_meta_update",
                "name": session_title
            })
    except asyncio.CancelledError:
        logger.debug(f"Shadow Git commit cancelled for turn {turn_number} (user sent new prompt)")
        raise  # Re-raise to properly mark task as cancelled
    except Exception as e:
        logger.exception(f"Shadow Git commit failed: {e}")


class AgentBridge:
    """Bridge between WebSocket clients and provider (CLI agent) processes.

    Sessions are keyed by store_id and persist beyond WebSocket connections.
    This allows clients to reconnect to running agent processes.
    """

    # Default timeouts (can be overridden via ~/.painapple-code/config.json)
    # Keys: "session_idle_timeout_minutes" and "orphan_process_timeout_minutes"
    DEFAULT_SESSION_IDLE_TIMEOUT = 30 * 60  # 30 minutes
    DEFAULT_ORPHAN_PROCESS_TIMEOUT = 30 * 60  # 30 minutes

    @property
    def SESSION_IDLE_TIMEOUT(self):
        """Idle session cleanup timeout, configurable via bridge config."""
        from painapple_code import bridge_paths
        config = bridge_paths.load_global_config()
        minutes = config.get("session_idle_timeout_minutes")
        if minutes is not None:
            return int(minutes) * 60
        return self.DEFAULT_SESSION_IDLE_TIMEOUT

    @property
    def ORPHAN_PROCESS_TIMEOUT(self):
        """Orphan process kill timeout, configurable via bridge config."""
        from painapple_code import bridge_paths
        config = bridge_paths.load_global_config()
        minutes = config.get("orphan_process_timeout_minutes")
        if minutes is not None:
            return int(minutes) * 60
        return self.DEFAULT_ORPHAN_PROCESS_TIMEOUT

    def __init__(self, default_cwd: str = ".", default_provider: Optional[str] = None):
        self.sessions: dict[str, AgentSession] = {}  # store_id -> AgentSession
        self.default_cwd = default_cwd
        # Server-arg override for the provider NEW sessions adopt; wins over
        # the `default_provider` global-config key (ws_chat resolution).
        self.default_provider = default_provider
        self._cleanup_task: Optional[asyncio.Task] = None
        # When True (default), SIGINT Claude on AskUserQuestion so the turn
        # stops on the question instead of the CLI auto-denying and Claude
        # answering itself. Set False to keep the in-process answer-form path.
        # Loaded from the global bridge config so the System-tab toggle persists
        # across restarts; the PUT endpoint also updates this live instance.
        from painapple_code import bridge_paths
        self.sigint_on_ask: bool = bool(
            bridge_paths.load_global_config().get("sigint_on_ask", True)
        )

    def get_session(self, store_id: str) -> Optional[AgentSession]:
        """Get an existing session by store_id."""
        return self.sessions.get(store_id)

    def get_or_create_session(
        self,
        store_id: str,
        cwd: str,
        session_id: str = None,
        store_meta: dict = None,
        already_persisted: bool = False,
        fork_from_session_id: str = None,
        is_comment_thread: bool = False,
        token_profile: str = None,
        provider_name: str = None,
    ) -> AgentSession:
        """Get existing session or create a new one.

        Args:
            store_id: Server-side session ID
            cwd: Working directory
            session_id: Claude Code's internal session ID (for --resume)
            store_meta: Pending store metadata (if not yet persisted)
            already_persisted: True if session was loaded from disk
            fork_from_session_id: Claude session ID to fork from (uses --fork-session)
            is_comment_thread: True if this is a comment thread (skip shadow git)
            token_profile: OAuth token profile name (file from ~/.config/painapple-code/tokens/)
            provider_name: CLI provider backing this session (defaults to Claude)
        """
        if store_id in self.sessions:
            session = self.sessions[store_id]
            session.touch()
            return session

        # Create new session
        session = AgentSession(
            store_id=store_id,
            cwd=cwd,
            session_id=session_id,
            _store_meta=store_meta,
            store_persisted=already_persisted,
            fork_from_session_id=fork_from_session_id,
            is_comment_thread=is_comment_thread,
            token_profile=token_profile,
            provider=get_provider(provider_name),
        )
        self.sessions[store_id] = session
        logger.info(f"Created new session: {store_id} (persisted={already_persisted}, fork={fork_from_session_id is not None})")
        return session

    def remove_session(self, store_id: str):
        """Remove a session from the registry."""
        if store_id in self.sessions:
            del self.sessions[store_id]
            logger.info(f"Removed session from registry: {store_id}")

    async def cleanup_idle_sessions(self):
        """Background task to cleanup idle sessions."""
        while True:
            await asyncio.sleep(60)  # Check every minute
            now = time.time()
            to_remove = []
            to_kill = []  # Orphaned running sessions to terminate

            for store_id, session in self.sessions.items():
                idle_time = now - session.last_activity

                # Validate process state - fix stale is_running if process died
                if session.is_running:
                    process_alive = False
                    if session.process:
                        try:
                            os.kill(session.process.pid, 0)
                            process_alive = True
                        except (OSError, ProcessLookupError):
                            pass

                    if not process_alive:
                        logger.warning(
                            f"Session {store_id} has stale is_running=True but process is dead, fixing"
                        )
                        session.is_running = False
                        session.process = None

                # Check for orphaned running sessions (no WebSocket but Claude still running)
                if session.is_running and not session.ws_connected:
                    if idle_time > self.ORPHAN_PROCESS_TIMEOUT:
                        to_kill.append((store_id, session, idle_time))
                    continue

                # Don't cleanup if WebSocket is attached
                if session.ws_connected:
                    continue

                # Session is not running and no WebSocket - check idle timeout
                if idle_time > self.SESSION_IDLE_TIMEOUT:
                    to_remove.append(store_id)
                    logger.info(f"Session {store_id} idle for {idle_time:.0f}s, marking for cleanup")

            # Kill orphaned running processes
            for store_id, session, idle_time in to_kill:
                logger.info(f"Killing orphaned session {store_id} (no WebSocket for {idle_time:.0f}s)")
                await self.stop_session(session)

            for store_id in to_remove:
                self.remove_session(store_id)

    def start_cleanup_task(self):
        """Start the background cleanup task."""
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self.cleanup_idle_sessions())
            logger.info("Started session cleanup background task")

    async def start_agent(self, session: AgentSession) -> bool:
        """Start a Claude Code subprocess with streaming JSON."""
        session.start_error = None
        try:
            # Ensure session is persisted before we start logging
            session.ensure_persisted()

            # Reset error tracking flags for new process
            session._stale_session_error_sent = False
            session._api_retry_pending = False
            session._api_error_detected = False
            session._auth_retry_count = 0
            session._auth_error_signaled = False
            # Pending permission asks die with their process — a response can
            # only be delivered to the stdin that asked.
            session._pending_permission_requests = {}
            # Same for in-flight control requests: fail their awaiters now so
            # a send_control caller racing a restart falls back immediately
            # instead of riding out its timeout.
            for fut in session._pending_control.values():
                if not fut.done():
                    fut.set_result(False)
            session._pending_control = {}
            # Reset per-process cost tracking — providers whose CLI reports
            # cumulative totals (Claude) restart from zero on every new process.
            session._cost_state = session.provider.new_cost_state()
            # Load retry max from global config (0 = disabled)
            from painapple_code import bridge_paths
            session._api_retry_max = bridge_paths.load_global_config().get("api_retry_max", 3)

            # Resolve model: in-memory override → session meta → global config.
            model_choice = session.preferred_model
            if not model_choice and session.store_id:
                meta = SessionStore.load_meta(session.store_id)
                if meta and meta.get("preferred_model"):
                    model_choice = meta["preferred_model"]
            if not model_choice:
                from painapple_code.routes.dependencies import preferred_model_survives
                # Per-engine default (models_key-scoped map, legacy flat key
                # as fallback) — still catalog-gated: honor it only when this
                # engine actually offers it (empty catalog = engine decides),
                # so a stale/hidden/foreign id never steers a launch.
                model_choice = bridge_paths.engine_default_model(session.provider)
                if not preferred_model_survives(model_choice, session.provider):
                    model_choice = None

            # Resolve effort level (low/medium/high/xhigh/max).
            effort = session.effort_level
            if not effort and session.store_id:
                meta = SessionStore.load_meta(session.store_id)
                if meta and meta.get("effort_level"):
                    effort = meta["effort_level"]
            if not effort:
                # Per-engine default effort, gated to the engine's own
                # vocabulary (a legacy `max` must not leak into Codex).
                effort = bridge_paths.engine_default_effort(session.provider)

            # Permission mode resolution: in-memory override → session meta →
            # user's configured global default → provider's native default. The
            # user's explicit global default (e.g. YOLO) must win over the
            # provider's hardcoded default, otherwise Claude's 'dontAsk' would
            # always short-circuit it. Only when no global default is configured
            # do we fall back to the provider's native default (e.g. Codex →
            # workspace-write). This matches the precedence used by the
            # GET /api/sessions default-permission endpoint. A stored value
            # (native or legacy canonical) is left untouched — the provider
            # maps it at launch.
            permission_mode = session.permission_mode
            if not permission_mode and session.store_id:
                meta = SessionStore.load_meta(session.store_id)
                if meta:
                    permission_mode = meta.get("permission_level")
            if not permission_mode:
                from painapple_code.bridge_paths import load_global_config
                permission_mode = (
                    load_global_config().get("default_permission_level")
                    or session.provider.default_permission_mode()
                )

            # Record the desired mode we launched with, so a later change is
            # detected on the next message (universal lazy mode-apply) — and
            # the resolved mode the process really runs with, for the
            # live-controls bypass guard.
            session._launched_permission_mode = session.permission_mode
            session._launched_resolved_mode = permission_mode

            # Arm the plan-approval SIGINT gate when starting in plan mode
            # (covers persisted-meta and global-default paths; the WS handler
            # arms it directly for the /plan command).
            if permission_mode == "plan":
                session._plan_sigint_armed = True

            # Capture (and consume) the fork source — subsequent restarts use
            # normal resume, so clear it after this launch.
            fork_from = session.fork_from_session_id
            if fork_from:
                logger.info(f"Forking from session: {fork_from}")
                session.fork_from_session_id = None
            elif session.session_id:
                logger.info(f"Resuming session: {session.session_id}")

            # Persistent providers (Claude) stream successive turns over stdin;
            # ephemeral ones (Codex) spawn one process per turn with the prompt
            # in argv and exit when the turn ends.
            ephemeral = not session.provider.capabilities.persistent_process
            jsonrpc = session.provider.capabilities.transport == "jsonrpc"

            # Provider builds the full argv from the resolved values. Kept in a
            # var so the JSON-RPC transport (which sends model/effort/sandbox over
            # the wire rather than in argv) can reuse the same resolved values.
            # Optional automatic fallback when the primary model is
            # overloaded/unavailable — config-file only (`fallback_model` key
            # in ~/.painapple-code/config.json), no per-session UI. Unset
            # keeps the CLI's no-fallback default byte-for-byte.
            fallback_model = bridge_paths.load_global_config().get("fallback_model")

            launch_opts = LaunchOptions(
                model=model_choice,
                fallback_model=fallback_model,
                effort=effort,
                permission_mode=permission_mode,
                session_id=session.session_id,
                fork_from_session_id=fork_from,
                prompt=session._pending_prompt if ephemeral else None,
                images=session._pending_images if ephemeral else None,
            )
            cmd = session.provider.build_command(launch_opts)

            # Seed per-subprocess event-translation scratch (the model name lets
            # the synthesized result carry a modelUsage breakdown) and reset the
            # per-turn "saw a result" flag used by the ephemeral cleanup path.
            session._xlate_state = {"model": model_choice}
            session._ephemeral_saw_result = False
            session._transport = None   # fresh per (re)start; built below for jsonrpc
            if ephemeral:
                session._pending_prompt = None
                session._pending_images = None

            # Build subprocess environment with token profile if configured
            subprocess_env = build_token_env(resolve_profile(session.token_profile, session.provider))

            logger.info(f"Starting {session.provider.display_name} in {session.cwd}" +
                        (f" (token: {session.token_profile})" if session.token_profile else ""))
            logger.info(f"Command: {' '.join(cmd)}")

            try:
                session.process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdin=asyncio.subprocess.DEVNULL if ephemeral else asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=session.cwd,
                    env=subprocess_env,
                    start_new_session=True,  # isolate from server's process group
                )
            except FileNotFoundError:
                # Raised both for a missing executable and a missing cwd.
                if not os.path.isdir(session.cwd):
                    session.start_error = (
                        f"Working directory does not exist: {session.cwd}"
                    )
                else:
                    session.start_error = (
                        f"{session.provider.display_name} executable not found "
                        f"('{cmd[0]}'). {session.provider.binary_not_found_hint()}"
                    )
                logger.error(session.start_error)
                return False
            except PermissionError:
                session.start_error = (
                    f"{session.provider.display_name} executable is not runnable "
                    f"('{cmd[0]}'). Check the file's permissions and path. "
                    f"{session.provider.binary_not_found_hint()}"
                )
                logger.error(session.start_error)
                return False
            session.is_running = True
            # An ephemeral turn is active the instant we spawn — there is no
            # follow-up stdin send to flip is_idle off.
            if ephemeral:
                session.is_idle = False

            # Log process start to raw.jsonl
            if session.store_id:
                resume_info = f", resume={session.session_id}" if session.session_id else ""
                SessionStore.log_raw(
                    session.store_id, "event",
                    f"process_start (pid={session.process.pid}, cwd={session.cwd}{resume_info})"
                )

            # Start reading stdout in background. Ephemeral providers use a
            # dedicated reader that translates native events and treats process
            # exit as normal turn completion (not "session ended"). JSON-RPC
            # providers use a persistent-lifecycle reader that *also* translates
            # (notifications → canonical events).
            if ephemeral:
                reader = self._read_ephemeral_output
            elif jsonrpc:
                reader = self._read_jsonrpc_output
            else:
                reader = self._read_agent_output
            session._read_task = asyncio.create_task(reader(session))

            # Also monitor stderr
            session._stderr_task = asyncio.create_task(
                self._read_agent_stderr(session)
            )

            # JSON-RPC providers (Codex app-server): the reader is now live to
            # resolve responses, so build the transport and run its handshake
            # (initialize → initialized) before the first turn is sent.
            if jsonrpc:
                session._transport = session.provider.make_transport(
                    session.process, launch_opts, session
                )
                if session._transport is not None:
                    await session._transport.initialize()

            return True

        except Exception as e:
            logger.error(f"Failed to start agent: {e}")
            return False

    async def _read_agent_output(self, session: AgentSession):
        """Read and forward Claude's stdout to WebSocket.

        Orchestrates message processing by dispatching to type-specific handlers:
        - _handle_system_msg: system init, compaction detection
        - _handle_assistant_msg: thinking, text, tool_use (including shadow git tracking)
        - _handle_tool_results: tool result processing, startLine injection, task tracking
        - _handle_result_msg: turn completion, cost storage, shadow git commit
        """
        try:
            while session.process and session.is_running:
                line = await read_line_unlimited(session.process.stdout)
                if not line:
                    break

                line_str = line.decode('utf-8').strip()
                if not line_str:
                    continue

                session.touch()
                logger.info(f"{session.provider.name} output: {_sanitize_for_log(line_str[:200])}...")

                try:
                    msg = session.provider.parse_line(line_str)

                    # Log raw output
                    if session.store_id:
                        SessionStore.log_raw(session.store_id, "out", line_str, msg)

                    # Interactive permission ask (capabilities.interactive_permissions):
                    # the process is blocked awaiting a permission_response on its
                    # stdin — round-trip to the client, don't dispatch as a turn event.
                    if msg.get("type") == "permission_request":
                        await self._handle_permission_request(session, msg)
                        continue

                    # Control ack (capabilities.live_controls): resolve the
                    # future a send_control caller is awaiting.
                    if msg.get("type") == "control_done":
                        fut = session._pending_control.get(msg.get("control_id"))
                        if fut and not fut.done():
                            if not msg.get("ok"):
                                logger.warning(
                                    f"control {msg.get('action')} nacked for "
                                    f"{session.store_id}: {msg.get('error')}")
                            fut.set_result(bool(msg.get("ok")))
                        else:
                            logger.warning(
                                f"control_done for unknown id {msg.get('control_id')!r}")
                        continue

                    # Detect stale session error from stdout
                    if (msg.get("type") == "result" and
                        msg.get("subtype") == "error_during_execution" and
                        msg.get("errors")):
                        for err in msg.get("errors", []):
                            if "No conversation found with session ID" in err:
                                logger.info(f"Stale session detected from stdout: {err}")
                                await session.handle_stale_session()
                                break

                    # Capture session_id (skip if stale error was detected)
                    if "session_id" in msg and not session.session_id and not session._stale_session_error_sent:
                        session.session_id = msg["session_id"]
                        if session.store_id:
                            SessionStore.update_metadata(
                                session.store_id, provider_session_id=msg["session_id"]
                            )

                    # Generate timestamp once for consistency
                    server_timestamp = datetime.now(timezone.utc).isoformat()

                    # Dispatch to type-specific handlers
                    msg_type = msg.get("type")
                    if msg_type == "system":
                        await self._handle_system_msg(session, msg)
                    if msg_type == "assistant" and session.store_id:
                        self._handle_assistant_msg(session, msg, server_timestamp)
                    if msg_type == "user" and session.store_id:
                        self._handle_tool_results(session, msg, server_timestamp)
                    if msg_type == "result":
                        await self._handle_result_msg(session, msg, server_timestamp)

                    # Add verified file paths for assistant messages
                    if session.cwd:
                        msg = add_verified_files_to_message(msg, session.cwd)

                    # Add parent_task_id for sub-agent tool grouping
                    # Prefer Claude CLI's native parent_tool_use_id (accurate for
                    # parallel Tasks), fall back to heuristic for older CLI versions
                    if msg_type == "assistant":
                        content = msg.get("message", {}).get("content", [])
                        if isinstance(content, list):
                            for block in content:
                                if block.get("type") == "tool_use":
                                    tool_id = block.get("id")
                                    if block.get("name") != "Task":
                                        parent = msg.get("parent_tool_use_id") or session.tool_to_task_map.get(tool_id)
                                        if parent:
                                            msg["parent_task_id"] = parent

                    # Suppress AskUserQuestion retries: don't forward retry tool_use
                    # or their auto-deny tool_results to the client.
                    suppress = False
                    if session._ask_tool_id:
                        if msg_type == "assistant":
                            content = msg.get("message", {}).get("content", [])
                            if isinstance(content, list):
                                ask_blocks = [b for b in content if b.get("type") == "tool_use" and b.get("name") == "AskUserQuestion"]
                                if ask_blocks and all(b.get("id") != session._ask_tool_id for b in ask_blocks):
                                    # All AskUserQuestion blocks are retries — suppress entire message
                                    suppress = True
                        elif msg_type == "user":
                            content = msg.get("message", {}).get("content", [])
                            if isinstance(content, list):
                                results = [b for b in content if b.get("type") == "tool_result"]
                                if results and all(b.get("tool_use_id") in session._suppressed_ask_ids for b in results):
                                    # Auto-deny for a suppressed retry — suppress
                                    suppress = True

                    # Suppress error result message when API retry is about to fire
                    suppress_for_retry = (
                        msg_type == "result"
                        and msg.get("is_error")
                        and session._api_error_detected
                        and session._api_retry_count < session._api_retry_max
                    )

                    # Forward to WebSocket
                    if not suppress and not suppress_for_retry:
                        await session.safe_send({
                            "type": "agent_message",
                            "data": msg,
                            "timestamp": server_timestamp
                        })

                    # Auto-stop: if a tool needing user input was detected,
                    # SIGINT Claude to prevent wasteful retry loops in -p mode
                    if session._pending_input_tool:
                        tool = session._pending_input_tool
                        session._pending_input_tool = None
                        logger.info(f"Auto-stopping agent for {tool} user input")
                        session._interrupting = True
                        try:
                            session.process.send_signal(signal.SIGINT)
                        except (ProcessLookupError, OSError):
                            pass

                        # Try to drain result message (has cost/token data) with timeout
                        result_msg = None
                        try:
                            drain_deadline = asyncio.get_event_loop().time() + 2.0
                            while asyncio.get_event_loop().time() < drain_deadline:
                                remaining = drain_deadline - asyncio.get_event_loop().time()
                                drain_line = await asyncio.wait_for(
                                    read_line_unlimited(session.process.stdout),
                                    timeout=max(0.1, remaining)
                                )
                                if not drain_line:
                                    break
                                drain_str = drain_line.decode('utf-8').strip()
                                if not drain_str:
                                    continue
                                try:
                                    drain_msg = json.loads(drain_str)
                                    if drain_msg.get("type") == "result":
                                        result_msg = drain_msg
                                        logger.info(f"Captured result msg after SIGINT: cost=${drain_msg.get('total_cost_usd', 0)}")
                                        break
                                except json.JSONDecodeError:
                                    pass
                        except (asyncio.TimeoutError, Exception) as e:
                            logger.debug(f"Drain after SIGINT ended: {e}")

                        # If we captured a result message, use full handler (stores cost + finalizes)
                        # Otherwise finalize without cost data (duration computed from turn_start)
                        if result_msg:
                            await self._handle_result_msg(session, result_msg, datetime.now(timezone.utc).isoformat())
                        else:
                            await self._finalize_turn(session, reason=f"auto-stop:{tool}")
                        await session.safe_send({
                            "type": "waiting_for_input",
                            "tool_name": tool,
                        })
                        break

                except json.JSONDecodeError as e:
                    if session.store_id:
                        SessionStore.log_raw_error(
                            session.store_id,
                            f"Non-JSON output (JSONDecodeError: {e})",
                            line_str
                        )
                    await session.safe_send({
                        "type": "raw_output",
                        "data": line_str
                    })

        except asyncio.CancelledError:
            logger.info("Output reader cancelled")
        except Exception as e:
            logger.error(f"Error reading agent output: {e}")
            if session.store_id:
                SessionStore.log_raw_error(
                    session.store_id,
                    f"server_error: Error reading agent output: {e}",
                    traceback.format_exc()
                )
            await session.safe_send({
                "type": "stderr",
                "data": f"Server error: {e}"
            })
        finally:
            await self._cleanup_process(session)

    async def _read_ephemeral_output(self, session: AgentSession):
        """Stdout reader for non-persistent providers (e.g. Codex).

        One subprocess == one turn. Native events are translated to canonical
        Claude-shaped messages via `provider.translate_events`, dispatched
        through the same handlers as Claude, and forwarded to the client. A
        clean process exit means the turn finished — not that the session ended.
        """
        try:
            while session.process and session.is_running:
                line = await read_line_unlimited(session.process.stdout)
                if not line:
                    break
                line_str = line.decode('utf-8').strip()
                if not line_str:
                    continue
                session.touch()
                logger.info(f"{session.provider.name} output: {_sanitize_for_log(line_str[:200])}...")

                try:
                    native = session.provider.parse_line(line_str)
                except json.JSONDecodeError:
                    # Non-event line (codex can interleave plain text) — forward raw.
                    if session.store_id:
                        SessionStore.log_raw_error(session.store_id, "Non-JSON output", line_str)
                    await session.safe_send({"type": "raw_output", "data": line_str})
                    continue

                if session.store_id:
                    SessionStore.log_raw(session.store_id, "out", line_str, native)

                # Capture the CLI's session/thread id for the next resume.
                sid = session.provider.session_id_from_event(native)
                if sid and not session.session_id:
                    session.session_id = sid
                    if session.store_id:
                        SessionStore.update_metadata(session.store_id, provider_session_id=sid)

                # One native event → 0..N canonical messages.
                for msg in session.provider.translate_events(native, session._xlate_state):
                    server_timestamp = datetime.now(timezone.utc).isoformat()
                    msg_type = msg.get("type")
                    if msg_type == "system":
                        await self._handle_system_msg(session, msg)
                    elif msg_type == "assistant" and session.store_id:
                        self._handle_assistant_msg(session, msg, server_timestamp)
                    elif msg_type == "user" and session.store_id:
                        self._handle_tool_results(session, msg, server_timestamp)
                    elif msg_type == "result":
                        session._ephemeral_saw_result = True
                        await self._handle_result_msg(session, msg, server_timestamp)

                    if session.cwd:
                        msg = add_verified_files_to_message(msg, session.cwd)

                    await session.safe_send({
                        "type": "agent_message",
                        "data": msg,
                        "timestamp": server_timestamp,
                    })
        except asyncio.CancelledError:
            logger.info("Ephemeral output reader cancelled")
        except Exception as e:
            logger.error(f"Error reading {session.provider.name} output: {e}")
            if session.store_id:
                SessionStore.log_raw_error(
                    session.store_id,
                    f"server_error: Error reading output: {e}",
                    traceback.format_exc()
                )
            await session.safe_send({"type": "stderr", "data": f"Server error: {e}"})
        finally:
            await self._cleanup_ephemeral_process(session)

    async def _read_jsonrpc_output(self, session: AgentSession):
        """Stdout reader for JSON-RPC transport providers (e.g. Codex app-server).

        One persistent process serves many turns (like Claude), but the wire is
        JSON-RPC: each stdout line is a response to one of our requests, a
        server-initiated request, or a notification. The transport's `intake`
        resolves responses and answers requests; notifications are translated to
        canonical Claude-shaped events via `translate_events` and dispatched
        through the same handlers as every other provider. Process exit means the
        session ended (not just a turn), so cleanup is the persistent path.
        """
        try:
            while session.process and session.is_running:
                line = await read_line_unlimited(session.process.stdout)
                if not line:
                    break
                line_str = line.decode('utf-8').strip()
                if not line_str:
                    continue
                session.touch()
                logger.info(f"{session.provider.name} output: {_sanitize_for_log(line_str[:200])}...")

                try:
                    native = session.provider.parse_line(line_str)
                except json.JSONDecodeError:
                    # The app-server speaks pure JSON-RPC, but be defensive.
                    if session.store_id:
                        SessionStore.log_raw_error(session.store_id, "Non-JSON output", line_str)
                    await session.safe_send({"type": "raw_output", "data": line_str})
                    continue

                if session.store_id:
                    SessionStore.log_raw(session.store_id, "out", line_str, native)

                # Let the transport resolve responses / answer server-initiated
                # requests. It returns False for protocol bookkeeping (responses,
                # approvals) that should not be translated or surfaced.
                if session._transport is not None and not session._transport.intake(native):
                    continue

                # Capture the CLI's thread id for the next resume. The transport
                # also sets it from the thread/start response; this is a backstop
                # for the thread/started notification.
                sid = session.provider.session_id_from_event(native)
                if sid and not session.session_id:
                    session.session_id = sid
                    if session.store_id:
                        SessionStore.update_metadata(session.store_id, provider_session_id=sid)

                # One native notification → 0..N canonical messages, dispatched
                # through the shared handlers (shadow git, cost, tool tracking).
                for msg in session.provider.translate_events(native, session._xlate_state):
                    server_timestamp = datetime.now(timezone.utc).isoformat()
                    msg_type = msg.get("type")
                    if msg_type == "system":
                        await self._handle_system_msg(session, msg)
                    elif msg_type == "assistant" and session.store_id:
                        self._handle_assistant_msg(session, msg, server_timestamp)
                    elif msg_type == "user" and session.store_id:
                        self._handle_tool_results(session, msg, server_timestamp)
                    elif msg_type == "result":
                        await self._handle_result_msg(session, msg, server_timestamp)

                    if session.cwd:
                        msg = add_verified_files_to_message(msg, session.cwd)

                    await session.safe_send({
                        "type": "agent_message",
                        "data": msg,
                        "timestamp": server_timestamp,
                    })
        except asyncio.CancelledError:
            logger.info("JSON-RPC output reader cancelled")
        except Exception as e:
            logger.error(f"Error reading {session.provider.name} output: {e}")
            if session.store_id:
                SessionStore.log_raw_error(
                    session.store_id,
                    f"server_error: Error reading output: {e}",
                    traceback.format_exc()
                )
            await session.safe_send({"type": "stderr", "data": f"Server error: {e}"})
        finally:
            await self._cleanup_process(session)

    async def _cleanup_ephemeral_process(self, session: AgentSession):
        """Clean up after an ephemeral (per-turn) subprocess exits.

        Unlike `_cleanup_process`, a normal exit here means the turn finished, so
        we do NOT emit `session_ended` — the session stays alive and idle, ready
        for the next prompt (resumed by thread id). A failure that produced no
        result is surfaced and the turn finalized, so the UI never hangs.
        """
        interrupted = session._interrupting
        session.is_running = False
        session.is_idle = True

        if session._stderr_task:
            session._stderr_task.cancel()
            try:
                await session._stderr_task
            except asyncio.CancelledError:
                pass

        exit_code = None
        if session.process:
            try:
                exit_code = session.process.returncode
                if exit_code is None:
                    session.process.terminate()
                    await asyncio.wait_for(session.process.wait(), timeout=5.0)
                    exit_code = session.process.returncode
            except asyncio.TimeoutError:
                session.process.kill()
                try:
                    await session.process.wait()
                    exit_code = session.process.returncode
                except Exception:
                    pass
            except ProcessLookupError:
                pass
            except Exception as e:
                logger.error(f"Error terminating {session.provider.name} process: {e}")

        if session.store_id:
            SessionStore.log_raw(session.store_id, "event", f"process_exit (exit_code={exit_code})")

        session.process = None
        session._read_task = None
        session._stderr_task = None
        session.touch()

        # A turn that produced no result (crash / non-zero exit) must still be
        # finalized so the client isn't stuck "thinking" — and the failure
        # surfaced. A result-bearing turn already finalized in _handle_result_msg.
        if not session._ephemeral_saw_result and not interrupted:
            if exit_code not in session.provider.normal_termination_codes:
                await session.safe_send({
                    "type": "stderr",
                    "data": f"{session.provider.display_name} exited without completing the turn (exit code {exit_code})",
                })
            await self._finalize_turn(session, reason=f"{session.provider.name}-exit")

        logger.info(f"{session.provider.name} turn process ended for session {session.store_id} (exit={exit_code})")
        session._interrupting = False

    async def _handle_system_msg(self, session: AgentSession, msg: dict):
        """Handle system messages: init metadata, compaction detection."""
        subtype = msg.get("subtype", "")

        if subtype == "init" and session.store_id:
            if msg.get("model"):
                SessionStore.update_metadata(session.store_id, model=msg["model"])
            if msg.get("slash_commands"):
                SessionStore.update_metadata(session.store_id, slash_commands=msg["slash_commands"])
                SessionStore.save_project_commands(session.cwd, msg["slash_commands"])
            # Override permissionMode to match server state.
            # CLI resumed sessions report stale plan mode from conversation history,
            # but the server controls whether Claude actually runs with --permission-mode plan.
            if session.permission_mode:
                msg["permissionMode"] = session.permission_mode
            elif msg.get("permissionMode") == "plan":
                msg.pop("permissionMode", None)
                logger.info(f"Stripped stale permissionMode=plan from init for session {session.store_id}")

        elif subtype == "api_retry" and msg.get("error_status") == 401:
            # The CLI retries an auth 401 up to ~10x (~60s) before giving up.
            # Detect it on the 2nd consecutive retry (a single 401 could be a
            # transient token-refresh race) and surface the re-login affordance
            # immediately, then SIGINT to abort the doomed loop.
            session._auth_retry_count += 1
            if session._auth_retry_count >= 2 and not session._auth_error_signaled:
                session._auth_error_signaled = True
                logger.info(f"Auth failure (401) during CLI retries for session "
                            f"{session.store_id} — surfacing re-login affordance, aborting retries")
                await session.safe_send(self._auth_error_frame(session, 401))
                session._interrupting = True
                try:
                    session.process.send_signal(signal.SIGINT)
                except (ProcessLookupError, OSError, AttributeError):
                    pass

        elif subtype == "model_refusal_fallback":
            # The API's safety classifier declined the request on the session's
            # pinned model and Anthropic transparently retried on a fallback
            # model. This happens server-side, below the bridge — the target is
            # chosen by refusal category and is not configurable here.
            #
            # We used to drop this frame entirely, which is how a session pinned
            # to one model silently started rendering another with no
            # explanation. The CLI hands us a complete account (original model,
            # fallback model, category, prose); store it as an info row so the
            # swap is visible, survives reload/sync, and reads as a deliberate
            # event rather than a glitch.
            original = msg.get("original_model") or "?"
            fallback = msg.get("fallback_model") or "?"
            category = msg.get("api_refusal_category")
            logger.info(
                f"Model refusal fallback for session {session.store_id}: "
                f"{original} -> {fallback} (category: {category or 'unknown'})"
            )
            if session.store_id:
                detail = (msg.get("content") or "").strip()
                if not detail:
                    reason = f" ({category})" if category else ""
                    detail = (f"{original}'s safeguards flagged this message{reason}. "
                              f"Switched to {fallback}.")
                refusal_key = (msg.get("request_id") or msg.get("uuid")
                               or f"turn{session.turn_number}")
                info_msg = {
                    # Stable id keyed on the request that was refused, so the
                    # row collapses to one copy across reconnect/sync instead of
                    # duplicating (same contract as compact_boundary above).
                    "id": f"refusal-{refusal_key}",
                    "role": "info",
                    "content": detail,
                    "source": "model_refusal_fallback",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
                line = SessionStore.add_message(session.store_id, info_msg)
                await session.safe_send({
                    "type": "message_stored",
                    "message": info_msg,
                    "line": line,
                })

        elif subtype == "status" and msg.get("status") == "compacting":
            logger.info(f"Compaction detected for session {session.store_id}")
            session.is_compacting = True
            # Heartbeat keeps the (iPad) WebSocket warm for the WHOLE turn, not just
            # the summarize phase. The risky silence is the post-boundary continuation
            # (60-90s), so the heartbeat must outlive compact_boundary and only stop at
            # _finalize_turn. See _start_turn_heartbeat for the reliability rationale.
            self._start_turn_heartbeat(session)

        elif subtype == "status" and msg.get("status") is None and "compact_result" in msg:
            # Compaction settled. On success a compact_boundary follows and does the
            # bookkeeping; on failure there is NO boundary, so this is the only place
            # to clear is_compacting and record the error. Either way the turn keeps
            # running until its result frame, so we do NOT stop the heartbeat here.
            session.is_compacting = False
            if msg.get("compact_result") == "failed":
                session.compaction_failed = True
                compact_error = msg.get("compact_error") or ""
                # A limit-killed compaction ("Error during compaction: You've hit
                # your session limit") arrives with is_error:false on the result,
                # so this settle frame is the only reliable place to catch it.
                if session.provider.is_usage_limit(compact_error):
                    session.is_rate_limited = True
                logger.warning(
                    f"Compaction failed for session {session.store_id}: "
                    f"{compact_error or 'unknown error'}"
                )

        elif subtype == "compact_boundary":
            session.is_compacting = False
            # Do NOT stop the heartbeat here: the turn continues past the boundary
            # (post-compaction inference) and that silent window is exactly what
            # strands the client on 'working'. Teardown happens in _finalize_turn.
            compact_metadata = msg.get("compact_metadata", {})
            logger.info(f"Compaction complete: {compact_metadata}")
            # Store compact info as a message for sync/reconnect reliability
            # (client-created info message is lost if WebSocket dropped during compaction)
            if session.store_id:
                pre_tokens = compact_metadata.get("pre_tokens", 0)
                trigger = compact_metadata.get("trigger", "unknown")
                tokens_k = f"{pre_tokens / 1000:.1f}"
                SessionStore.add_message(session.store_id, {
                    # Deterministic id keyed on the boundary uuid so the client-live
                    # copy (rendered from the same frame) and this stored copy collapse
                    # to one row instead of duplicating on every reconnect/sync.
                    "id": f"compact-{msg.get('uuid') or session.turn_number}",
                    "role": "info",
                    "content": f"Conversation compacted: {tokens_k}k tokens summarized ({trigger})",
                    "source": "compact_boundary",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
            if session.session_id and not session.is_comment_thread:
                shadow = get_shadow_git(session.cwd)
                try:
                    await shadow.capture_compaction_checkpoint(
                        session_id=session.store_id,
                        provider_session_id=session.session_id,
                        compact_metadata=compact_metadata,
                        token_profile=resolve_profile(session.token_profile, session.provider),
                    )
                except Exception as e:
                    logger.exception(f"Compaction checkpoint failed: {e}")

    def _start_turn_heartbeat(self, session: AgentSession):
        """Ping the client every 10s while a turn is active.

        iPadOS/WKWebView aggressively half-drops idle sockets. The dangerous windows
        are the compaction summarize phase and the post-boundary continuation — each
        up to ~60-90s of wire silence, during which the terminal `result` (the frame
        that clears 'working') can be lost with no reconnect fired. Running the
        heartbeat for the WHOLE turn (started on compaction, torn down only in
        _finalize_turn/cleanup) keeps the socket warm AND turns a gap in the pings
        into a reliable 'socket dead' signal → the client reconnects → reconciles
        from server truth. The payload carries is_compacting so the client can label
        the phase (compacting vs generic working) without a second signal.
        """
        self._stop_turn_heartbeat(session)  # Cancel any existing heartbeat

        async def _heartbeat_loop():
            try:
                elapsed = 0
                while not session.is_idle:
                    await asyncio.sleep(10)
                    elapsed += 10
                    if not session.is_idle and session.ws_connected:
                        await session.safe_send({
                            "type": "compact_progress",
                            "elapsed": elapsed,
                            "is_compacting": session.is_compacting,
                        })
            except asyncio.CancelledError:
                pass
            except Exception as e:
                logger.debug(f"Turn heartbeat error: {e}")

        session._turn_heartbeat_task = asyncio.create_task(_heartbeat_loop())

    def _stop_turn_heartbeat(self, session: AgentSession):
        """Cancel the turn heartbeat task."""
        if session._turn_heartbeat_task:
            session._turn_heartbeat_task.cancel()
            session._turn_heartbeat_task = None

    def _handle_assistant_msg(self, session: AgentSession, msg: dict, timestamp: str):
        """Handle assistant messages: thinking blocks, text, tool_use.

        Stores messages, tracks file modifications for shadow git, and manages
        task sub-agent grouping.
        """
        message = msg.get("message")

        # Record the model behind the MAIN chat thread. Task-tool subagents emit
        # assistant frames too, distinguished ONLY by parent_tool_use_id — the
        # result frame's modelUsage aggregates them with the main thread and
        # cannot be untangled after the fact. Capturing it live is exact where
        # the old max(costUSD) heuristic was a guess: a long subagent turn
        # routinely outspends the main thread 5:1 and would steal the label.
        # Last main-thread frame wins, so a mid-turn refusal fallback shows the
        # model that actually produced the answer.
        if (msg.get("parent_tool_use_id") is None
                and session.turn_tracker
                and isinstance(message, dict)):
            frame_model = message.get("model")
            if frame_model and frame_model != "<synthetic>":
                session.turn_tracker.main_thread_model = frame_model

        content = message.get("content", []) if isinstance(message, dict) else []
        if not isinstance(content, list):
            return

        for block in content:
            block_type = block.get("type")

            if block_type == "thinking":
                session.in_thinking_mode = True
                session.thinking_tool_ids = set()
                session.current_thinking_msg_index = SessionStore.add_thinking_message(
                    session.store_id, block.get("thinking", ""), timestamp
                )

            elif block_type == "text":
                text_content = block.get("text", "")
                # Skip the CLI's synthetic auth-error bubble (model "<synthetic>",
                # text "Failed to authenticate. API Error: 401…"). The result event
                # drives a proper `auth_error` re-login affordance instead; storing
                # this raw bubble would resurrect it on reload/sync.
                if (isinstance(message, dict)
                        and message.get("model") == "<synthetic>"
                        and session.provider.is_auth_error(text_content)):
                    continue
                # Synthetic limit bubble ("Error during compaction: You've hit
                # your session limit · resets 4pm"): the CLI reports it as plain
                # assistant text in a turn whose result is is_error:false, so
                # flag the turn here. The bubble is still stored — it's the
                # user-visible record — but the turn bar shows the limit and the
                # pointless /context probe (another API call against a spent
                # limit) is skipped at finalize.
                if (isinstance(message, dict)
                        and message.get("model") == "<synthetic>"
                        and session.provider.is_usage_limit(text_content)):
                    session.is_rate_limited = True
                    logger.info(f"Usage limit reported mid-turn for session "
                                f"{session.store_id}: {text_content[:120]}")
                verified_files = {}
                if session.cwd and text_content:
                    for link in extract_file_links(text_content, session.cwd):
                        verified_files[link['path']] = link['resolved']
                SessionStore.add_message(session.store_id, {
                    "role": "assistant",
                    "content": text_content,
                    "verifiedFiles": verified_files,
                    "timestamp": timestamp,
                })

            elif block_type == "tool_use":
                self._handle_tool_use(session, block, timestamp, msg.get("parent_tool_use_id"))

    def _handle_tool_use(self, session: AgentSession, block: dict, timestamp: str, parent_tool_use_id: str = None):
        """Handle a single tool_use block: track files, shadow git, task grouping, store."""
        tool_id = block.get("id")
        tool_name = block.get("name")
        tool_input = block.get("input", {})

        # Track file modifications for Edit/Write
        if tool_name in ("Edit", "Write") and tool_input.get("file_path"):
            self._track_file_modification(session, tool_id, tool_name, tool_input)
        else:
            _track_tool_usage(session.turn_tracker, tool_name, tool_input)

        # ExitPlanMode: clear server-side permission_mode so restarts use full perms.
        # Only matters for /plan command (which sets permission_mode="plan").
        # When Claude auto-enters plan mode, permission_mode is already None.
        # NOTE: Do NOT set permission_mode on EnterPlanMode — Claude auto-enters
        # plan mode while running with bypassPermissions, and setting
        # permission_mode="plan" here would cause restarts to lose full permissions.
        if tool_name == "ExitPlanMode" and session.permission_mode:
            logger.info(f"ExitPlanMode detected - cleared permission_mode for session {session.store_id}")
            session.permission_mode = None

        # AskUserQuestion retry suppression: CLI auto-denies this tool in -p mode,
        # and Claude may retry it 2-3 times per turn. Only forward the first call
        # to the client; suppress retries and their auto-deny results.
        if tool_name == "AskUserQuestion":
            if session._ask_tool_id is None:
                # First AskUserQuestion in this turn — allow it through
                session._ask_tool_id = tool_id
            else:
                # Retry — will be suppressed in _read_agent_output
                session._suppressed_ask_ids.add(tool_id)
                logger.info(f"Suppressing AskUserQuestion retry (first was {session._ask_tool_id})")

        # Arm plan-approval gate when Claude enters plan mode autonomously.
        # The /plan command arms it separately via set_permission_mode.
        if tool_name == "EnterPlanMode":
            session._plan_sigint_armed = True

        # Auto-stop: mark tools that need user input so _read_agent_output
        # can SIGINT the process after forwarding (prevents retry loops in -p mode).
        # NOTE: AskUserQuestion is excluded by default. CLI auto-denies it cleanly
        # in one round, so SIGINT is unnecessary and actually harmful —
        # it causes a restart cycle where Claude keeps re-asking different questions.
        # ExitPlanMode is gated by _plan_sigint_armed so a resumed turn's
        # acknowledgment-ExitPlanMode after approval doesn't kill Claude again.
        sigint_tools = set()
        if session._plan_sigint_armed:
            sigint_tools.add("ExitPlanMode")
        # Stop-on-questions applies to EVERY provider. The claude-sdk driver
        # denies AskUserQuestion in its can_use_tool gate with a "stop and wait"
        # steering message (_UI_FLOW_DENY), but that deny does NOT actually halt
        # the turn — Claude treats it as a tool failure and keeps going. The
        # SIGINT is what genuinely stops the turn so the user can answer through
        # the form, so it must fire here too when sigint_on_ask is on.
        if self.sigint_on_ask:
            sigint_tools.add("AskUserQuestion")
        if tool_name in sigint_tools:
            session._pending_input_tool = tool_name
            if tool_name == "ExitPlanMode":
                session._plan_sigint_armed = False

        # Task sub-agent tracking
        if tool_name == "Task":
            session.task_order_counter += 1
            session.active_tasks[tool_id] = TaskInfo(
                task_id=tool_id,
                start_order=session.task_order_counter,
                is_background=tool_input.get("run_in_background", False)
            )
        elif session.active_tasks:
            # Prefer CLI's native parent_tool_use_id (accurate for parallel Tasks),
            # fall back to heuristic for older CLI versions
            if parent_tool_use_id and parent_tool_use_id in session.active_tasks:
                session.active_tasks[parent_tool_use_id].child_tool_ids.append(tool_id)
                session.tool_to_task_map[tool_id] = parent_tool_use_id
            else:
                assigned = session.assign_tool_to_task(tool_id)
                if assigned:
                    session.tool_to_task_map[tool_id] = assigned

        # Store: either in thinking message or as separate tool message.
        # Interactive tools (AskUserQuestion, EnterPlanMode, ExitPlanMode) are always
        # stored standalone so they render properly on session restore (question forms,
        # plan approval UI). Embedding them in thinking makes them invisible on reopen.
        interactive_tools = {"AskUserQuestion", "EnterPlanMode", "ExitPlanMode"}
        if (session.in_thinking_mode and session.current_thinking_msg_index is not None
                and tool_name not in interactive_tools):
            session.thinking_tool_ids.add(tool_id)
            SessionStore.add_tool_to_thinking(
                session.store_id, session.current_thinking_msg_index, block
            )
        else:
            SessionStore.add_message(session.store_id, {
                "role": "tool",
                "tool_name": tool_name,
                "tool_id": tool_id,
                "tool_input": tool_input,
                "timestamp": timestamp,
            })

    def _track_file_modification(self, session: AgentSession, tool_id: str, tool_name: str, tool_input: dict):
        """Track Edit/Write file modifications for shadow git and turn tracker."""
        file_path = tool_input.get("file_path")
        # Make path relative to cwd (ensure directory boundary match)
        cwd_prefix = session.cwd.rstrip("/") + "/"
        if session.cwd and file_path.startswith(cwd_prefix):
            file_path = file_path[len(cwd_prefix):]
        session.turn_tracker.add_modified_file(file_path)

        # Track in shadow git (skip for comment threads)
        if not session.is_comment_thread:
            shadow = get_shadow_git(session.cwd)
            shadow.track_modification(file_path, session.store_id)

        # Track tool usage with summarized input/output
        if tool_name == "Edit":
            input_sum, output_sum = summarize_edit_output(
                file_path, tool_input.get("old_string", ""), tool_input.get("new_string", "")
            )
            session.turn_tracker.add_tool_usage("Edit", input_sum, output_sum)
            # Store Edit input for server-side line number parsing
            session.edit_tool_inputs[tool_id] = {"new_string": tool_input.get("new_string", "")}
            logger.debug(f"Stored Edit input for tool {tool_id}")
        else:  # Write
            input_sum, output_sum = summarize_write_output(
                file_path, tool_input.get("content", ""), False
            )
            session.turn_tracker.add_tool_usage("Write", input_sum, output_sum)

    def _handle_tool_results(self, session: AgentSession, msg: dict, timestamp: str):
        """Handle tool results from 'user' type messages.

        Processes tool_result blocks (startLine injection, task completion tracking,
        thinking tool updates) and local-command stderr/stdout messages.
        """
        message = msg.get("message")
        content = message.get("content", []) if isinstance(message, dict) else []

        if isinstance(content, list):
            for block in content:
                if block.get("type") != "tool_result":
                    continue
                tool_id = block.get("tool_use_id")
                raw_output = block.get("content") or ""
                # Claude API tool results can have content as a list of blocks
                if isinstance(raw_output, list):
                    output = "\n".join(
                        b.get("text", "") if isinstance(b, dict) else str(b)
                        for b in raw_output
                    )
                elif not isinstance(raw_output, str):
                    output = str(raw_output)
                else:
                    output = raw_output

                # Inject startLine for Edit tools
                start_line = None
                tool_use_result = msg.get("tool_use_result")
                if tool_use_result and isinstance(tool_use_result, dict):
                    sp = tool_use_result.get("structuredPatch")
                    if sp and isinstance(sp, list) and len(sp) > 0:
                        start_line = sp[0].get("newStart")

                if not start_line and tool_id in session.edit_tool_inputs:
                    edit_input = session.edit_tool_inputs.pop(tool_id)
                    start_line = parse_edit_line_number(output, edit_input.get("new_string", ""))

                if start_line:
                    block["startLine"] = start_line

                # Task completion tracking
                if tool_id in session.active_tasks:
                    task_info = session.active_tasks[tool_id]
                    if "child_tool_ids" not in msg:
                        msg["child_tool_ids"] = {}
                    msg["child_tool_ids"][tool_id] = task_info.child_tool_ids.copy()
                    del session.active_tasks[tool_id]

                # Store result (thinking tools vs regular tools)
                if tool_id in session.thinking_tool_ids:
                    SessionStore.update_thinking_tool_result(
                        session.store_id, tool_id, output, start_line
                    )
                else:
                    tool_use_result = msg.get("tool_use_result")
                    error = ""
                    if isinstance(tool_use_result, dict):
                        error = tool_use_result.get("stderr") or ""
                    elif isinstance(tool_use_result, str):
                        error = tool_use_result
                    if tool_id:
                        SessionStore.update_tool_result(
                            session.store_id, tool_id, output, error, start_line
                        )

        # Handle synthetic messages (local-command-stderr/stdout)
        elif isinstance(content, str) and content.strip():
            stderr_match = re.search(r'<local-command-stderr>(.*?)</local-command-stderr>', content, re.DOTALL)
            if stderr_match:
                SessionStore.add_message(session.store_id, {
                    "role": "error", "content": stderr_match.group(1).strip(),
                    "source": "local-command-stderr", "timestamp": timestamp,
                })
            stdout_match = re.search(r'<local-command-stdout>(.*?)</local-command-stdout>', content, re.DOTALL)
            if stdout_match:
                stdout_text = stdout_match.group(1).strip()
                # Skip storing bare "Compacted" — we already store the richer
                # compact_boundary message with token count and trigger info.
                if stdout_text.lower().startswith("compacted"):
                    logger.debug(f"Skipping redundant local-command-stdout '{stdout_text}' (compact_boundary stored)")
                else:
                    SessionStore.add_message(session.store_id, {
                        "role": "info", "content": stdout_text,
                        "source": "local-command-stdout", "timestamp": timestamp,
                    })

    async def _finalize_turn(self, session: AgentSession, result_msg: dict = None, reason: str = "result"):
        """Finalize a turn: clear state, trigger shadow git commit + summary fork.

        Called from _handle_result_msg (normal completion with cost data) and
        from auto-stop (interrupted for user input, no result message).
        """
        # Clear thinking and task state
        session.in_thinking_mode = False
        session.current_thinking_msg_index = None
        session.thinking_tool_ids = set()
        session.clear_task_tracking()
        session.edit_tool_inputs = {}
        session.is_idle = True
        # Single owner of compaction/heartbeat teardown: every turn ends here
        # regardless of how compaction settled (success boundary, failure, or
        # interrupt), so is_compacting can never strand True on a warm process.
        self._stop_turn_heartbeat(session)
        session.is_compacting = False
        session.compaction_failed = False
        session._ask_tool_id = None
        session._suppressed_ask_ids = set()
        session._api_retry_count = 0
        session._api_error_detected = False
        session._api_retry_pending = False
        session._auth_retry_count = 0
        session._auth_error_signaled = False
        logger.info(f"Claude turn finalized ({reason}) for session {session.store_id}")

        # Revert one-shot effort override armed by Ctrl+Shift+' on the
        # client. Kill the idle process so the next turn respawns with the
        # restored --effort. See ws_chat._handle_user_message for the arm
        # side of this contract.
        if session._oneshot_revert_effort != "_UNSET":
            prior = session._oneshot_revert_effort
            session._oneshot_revert_effort = "_UNSET"
            session.effort_level = prior
            if session.is_idle and session.process:
                session._interrupting = True
                await self.stop_session(session)
                logger.info(
                    f"Reverted one-shot effort for {session.store_id} "
                    f"(restored to: {prior})"
                )

        if not session.turn_tracker:
            return

        # Bump turn number for every turn (even text-only responses)
        session.turn_number += 1

        # Turn summary bar
        rate_limited = session.is_rate_limited
        session.is_rate_limited = False  # Reset for next turn

        # Compute duration: prefer result_msg, fallback to turn_tracker.turn_start
        duration_ms = (result_msg or {}).get("duration_ms", 0)
        if not duration_ms and session.turn_tracker.turn_start:
            try:
                start = datetime.fromisoformat(session.turn_tracker.turn_start)
                duration_ms = int((datetime.now(timezone.utc) - start).total_seconds() * 1000)
            except (ValueError, TypeError):
                pass

        # Primary model = the model that produced this turn's main-thread
        # assistant frames, captured live during the turn (see
        # _handle_assistant_msg). modelUsage covers the WHOLE turn including
        # Task-tool subagents, so the previous max(costUSD) heuristic mislabeled
        # any turn where a subagent outspent the main thread — e.g. a Sonnet
        # subagent at $1.72 beating the Opus main thread at $0.36, rendering
        # "sonnet-5" next to an Opus answer. Cost is only a fallback now, for
        # turns that produced no main-thread frame at all (errors, interrupts).
        model_used = session.turn_tracker.main_thread_model
        if not model_used:
            model_usage = (result_msg or {}).get("modelUsage") or {}
            if model_usage:
                model_used = max(model_usage.keys(),
                                 key=lambda m: model_usage[m].get("costUSD", 0))

        turn_data = {
            "turnNumber": session.turn_number,
            "durationMs": duration_ms,
            "costUsd": (result_msg or {}).get("total_cost_usd", 0),
            "changedFiles": list(session.turn_tracker.modified_files),
            "toolsSummary": session.turn_tracker.get_tools_summary(),
            "fileActions": session.turn_tracker.get_file_actions(),
            "readImages": session.turn_tracker.get_read_images(),
            "rateLimited": rate_limited,
            "model": model_used,
            "dbTurnId": session.turn_tracker.db_turn_id,
        }

        if turn_data and session.ws_connected:
            _turn_fields = ("turnNumber", "durationMs", "costUsd", "changedFiles", "toolsSummary", "fileActions", "readImages", "rateLimited", "model", "dbTurnId")
            summary_msg = {"type": "turn_summary", "cwd": session.cwd}
            for f in _turn_fields:
                summary_msg[f] = turn_data.get(f)
            await session.safe_send(summary_msg)

        # Context meter / turn-summary bar. How we learn the window depends on the
        # provider: Claude forks a `/context` probe (a subprocess, so background);
        # engines without that command (Codex) report per-turn usage, so we
        # synthesize the snapshot from this turn's result inline — no extra
        # process. Skip when rate-limited (pointless either way).
        if session.cwd and not rate_limited:
            if session.provider.capabilities.context_command:
                asyncio.create_task(
                    self._fetch_and_send_context_update(session, turn_data)
                )
            else:
                token_info = session.provider.context_from_result(result_msg or {}, model_used)
                if token_info:
                    await self._emit_context_update(session, token_info, turn_data)

        # Shadow Git + DB completion
        if session.turn_tracker.has_activity and session.cwd and not session.is_comment_thread:
            shadow = get_shadow_git(session.cwd)
            cost_info = CostInfo(
                duration=(result_msg or {}).get("duration_ms", 0) / 1000,
                cost=(result_msg or {}).get("total_cost_usd", 0),
                input_tokens=(result_msg or {}).get("usage", {}).get("input_tokens", 0),
                output_tokens=(result_msg or {}).get("usage", {}).get("output_tokens", 0),
                cache_read_tokens=(result_msg or {}).get("usage", {}).get("cache_read_input_tokens", 0),
                cache_write_tokens=(result_msg or {}).get("usage", {}).get("cache_creation_input_tokens", 0),
            )
            tracker_snapshot = copy.deepcopy(session.turn_tracker)
            # Pass a provider session id — which unlocks the rich-commit fork in
            # commit_turn — only when the provider advertises rich-commit
            # summaries. Each provider forks *itself* to summarize the turn
            # (Claude: --fork-session; Codex: copy-rollout + exec resume); other
            # providers still get a basic shadow-git commit without AI sections.
            rich_commit_session_id = (
                session.session_id
                if session.provider.capabilities.rich_commit_summaries
                else None
            )
            asyncio.create_task(_background_shadow_commit(
                session=session, shadow=shadow, cost_info=cost_info,
                tracker_snapshot=tracker_snapshot, turn_number=session.turn_number,
                provider_session_id=rich_commit_session_id,
                result_msg=result_msg,
                session_model=model_used,
            ))
        elif session.turn_tracker.db_turn_id:
            db_turn_id = session.turn_tracker.db_turn_id
            asyncio.create_task(_complete_db_turn_no_activity(
                db_turn_id, result_msg, session.turn_number,
                main_thread_model=model_used,
            ))

    async def _handle_result_msg(self, session: AgentSession, msg: dict, timestamp: str):
        """Handle result messages: store cost data, then finalize turn."""
        logger.info(f"Claude turn completed (result received) for session {session.store_id}")

        # Some CLIs (Claude) report `total_cost_usd` / `modelUsage` as running
        # totals across the subprocess lifetime. The provider rewrites them to
        # per-turn deltas so downstream stores don't double-count.
        session.provider.normalize_result(msg, session._cost_state)

        # Store result with cost/duration breakdown (before finalize so
        # DB completion always runs even if session store operations fail)
        try:
            if session.store_id:
                model_usage = msg.get("modelUsage", {})
                usage = msg.get("usage", {})

                model_breakdown = {}
                for model_name, mu in model_usage.items():
                    model_breakdown[model_name] = {
                        "cost": mu.get("costUSD", 0),
                        "in": mu.get("inputTokens", 0),
                        "out": mu.get("outputTokens", 0),
                        "cache_read": mu.get("cacheReadInputTokens", 0),
                        "cache_write": mu.get("cacheCreationInputTokens", 0),
                    }

                tools_used = [t.name for t in session.turn_tracker.tools_used] if session.turn_tracker else []

                SessionStore.add_message(session.store_id, {
                    "role": "result",
                    "cost_usd": msg.get("total_cost_usd", 0),
                    "duration_ms": msg.get("duration_ms", 0),
                    "duration_api_ms": msg.get("duration_api_ms", 0),
                    "num_turns": msg.get("num_turns", 1),
                    "is_error": msg.get("is_error", False),
                    "timestamp": timestamp,
                    "model_usage": model_breakdown if model_breakdown else None,
                    "tokens": {
                        "in": usage.get("input_tokens", 0),
                        "out": usage.get("output_tokens", 0),
                        "cache_read": usage.get("cache_read_input_tokens", 0),
                        "cache_write": usage.get("cache_creation_input_tokens", 0),
                    } if usage else None,
                    "tools": tools_used if tools_used else None,
                })

                # Update cumulative cost
                cost = msg.get("total_cost_usd", 0)
                if cost:
                    store_data = SessionStore.load(session.store_id)
                    if store_data:
                        new_cost = store_data.get("total_cost", 0) + cost
                        SessionStore.update_metadata(session.store_id, total_cost=new_cost)
        except Exception as e:
            logger.error(f"Error storing result message: {e}")

        # Detect rate/usage/session limit. Provider regex covers the wording
        # variants ("hit your limit", "hit your session limit", …). OR-preserve:
        # mid-turn detections (synthetic assistant bubble, compaction settle
        # frame) already flagged the turn even when the result itself lands as
        # is_error:false with empty text — the /compact-at-limit shape.
        result_text = msg.get("result", "") or ""
        session.is_rate_limited = session.is_rate_limited or (
            bool(msg.get("is_error")) and session.provider.is_usage_limit(result_text)
        )
        if session.is_rate_limited:
            logger.info(f"Rate limit detected for session {session.store_id}: "
                        f"{result_text[:200] or '(flagged mid-turn)'}")

        # Detect authentication failure (expired token / invalid key / 401) and
        # surface a recoverable signal so the client can offer a one-click
        # re-login (drops the user into a `claude auth login` terminal). The raw
        # synthetic error message is suppressed client-side in favor of this.
        is_auth_failure = (
            bool(msg.get("is_error"))
            and not session.is_rate_limited
            and session.provider.is_auth_error(result_text, msg.get("api_error_status"))
        )
        if is_auth_failure and not session._auth_error_signaled:
            session._auth_error_signaled = True
            logger.info(f"Auth error detected for session {session.store_id}: {result_text[:200]}")
            await session.safe_send(self._auth_error_frame(
                session, msg.get("api_error_status"), result_text))

        # Detect retryable API error in result (500, 529, overloaded). The
        # resend machinery streams over a persistent stdin, so it only applies to
        # persistent providers; ephemeral (per-turn) providers surface the error.
        # Auth failures are excluded — they need a re-login, not a resend, and
        # without the guard one message could trigger both affordances.
        if (bool(msg.get("is_error"))
                and not is_auth_failure
                and session.provider.capabilities.persistent_process
                and not session.is_rate_limited
                and session.provider.is_retryable_api_error(result_text)
                and session._api_retry_count < session._api_retry_max
                and session._last_agent_msg is not None
                and not session._interrupting):
            session._api_error_detected = True
            logger.info(f"Retryable API error in result for {session.store_id}: {result_text[:200]}")
            asyncio.create_task(self._attempt_api_retry(session, source="result"))
            return  # Skip normal result processing — retry takes over

        await self._finalize_turn(session, result_msg=msg, reason="result")

    @staticmethod
    def _auth_error_frame(session: AgentSession, status, message: Optional[str] = None) -> dict:
        """Build the `auth_error` WS frame with engine identity attached.

        Carries the session's own engine label + the provider-declared login
        command (same computation as GET /api/bridge/engine-auth) so the
        client's re-login card says "Log in to Codex" and opens the right CLI
        — not a hardcoded `claude auth login`.
        """
        import shlex
        from painapple_code import bridge_paths

        p = session.provider
        # Family label ("Claude"/"Codex"): login identity is per CLI binary,
        # which driver pairs share via models_key — registry-driven, no
        # provider-name literals.
        engine = (p.models_key or p.name or "claude").capitalize()
        frame = {
            "type": "auth_error",
            "status": status,
            "message": message or (f"Failed to authenticate. Your {engine} "
                                   f"login has expired or is invalid."),
            "provider": p.name,
            "engine": engine,
        }
        if p.auth_login_args:
            config = bridge_paths.load_global_config()
            configured = config.get(p.path_config_key) if p.path_config_key else None
            binary = configured or p.default_binary
            if binary:
                frame["login_command"] = shlex.join([binary, *p.auth_login_args])
        return frame

    async def _cleanup_process(self, session: AgentSession):
        """Clean up after Claude process ends: terminate, log exit, notify client.

        When _interrupting is set (by interrupt_agent), skip client notifications
        since interrupt_agent handles those directly.
        """
        interrupted = session._interrupting
        session.is_running = False
        session.is_idle = True
        session.in_thinking_mode = False

        # Cancel turn heartbeat if running
        self._stop_turn_heartbeat(session)
        session.is_compacting = False
        session.compaction_failed = False

        # Cancel stderr reader
        if session._stderr_task:
            session._stderr_task.cancel()
            try:
                await session._stderr_task
            except asyncio.CancelledError:
                pass

        # Terminate the Claude process
        exit_code = None
        if session.process:
            try:
                exit_code = session.process.returncode
                if exit_code is None:
                    session.process.terminate()
                    await asyncio.wait_for(session.process.wait(), timeout=5.0)
                    exit_code = session.process.returncode
            except asyncio.TimeoutError:
                logger.warning(f"Claude process didn't terminate gracefully, killing")
                session.process.kill()
                try:
                    await session.process.wait()
                    exit_code = session.process.returncode
                except Exception:
                    pass
            except ProcessLookupError:
                pass
            except Exception as e:
                logger.error(f"Error terminating Claude process: {e}")

        # Log exit
        if session.store_id:
            exit_info = f"exit_code={exit_code}"
            if exit_code and exit_code != 0:
                SessionStore.log_raw_error(session.store_id, f"process_exit ({exit_info})", "non-zero exit")
                if not interrupted and exit_code not in session.provider.normal_termination_codes and not session._stale_session_error_sent:
                    await session.safe_send({
                        "type": "stderr",
                        "data": f"Claude process exited unexpectedly (exit code {exit_code})"
                    })
            else:
                SessionStore.log_raw(session.store_id, "event", f"process_exit ({exit_info})")

        session.process = None
        session._read_task = None
        session._stderr_task = None
        session.touch()

        # Auto-retry on transient API error (process died after retryable error in stderr)
        if (session._api_error_detected
                and session._api_retry_count < session._api_retry_max
                and session._last_agent_msg is not None
                and not interrupted):
            logger.info(f"Process died after retryable API error, will retry "
                        f"({session._api_retry_count + 1}/{session._api_retry_max}) for {session.store_id}")
            asyncio.create_task(self._attempt_api_retry(session, source="process_death"))
            return  # Skip session_ended — retry takes over

        if not interrupted:
            await session.safe_send({
                "type": "session_ended",
                "reason": f"Claude process ended (exit={exit_code})"
            })
        logger.info(f"Claude process ended for session {session.store_id} (exit={exit_code})")
        session._interrupting = False

    async def _attempt_api_retry(self, session: AgentSession, source: str = "unknown"):
        """Attempt to retry after a transient API error (500, 529, overloaded).

        Called from _handle_result_msg (error in result) or _cleanup_process (process died).
        Sends status messages to client, waits with backoff, restarts process if needed,
        and resends the last message (or "continue" if partial response exists).
        """
        # Guard against double-invocation (result handler + cleanup can both fire)
        if session._api_retry_pending:
            logger.info(f"API retry already pending for {session.store_id}, skipping duplicate from {source}")
            return

        session._api_retry_count += 1
        session._api_retry_pending = True
        retry_num = session._api_retry_count
        max_retries = session._api_retry_max

        # Exponential backoff: 2s, 4s, 8s, ...
        delay = min(2 ** retry_num, 30)

        logger.info(
            f"API retry {retry_num}/{max_retries} for session {session.store_id} "
            f"(source={source}, delay={delay}s)"
        )

        # Notify client
        await session.safe_send({
            "type": "api_retry_status",
            "retry_num": retry_num,
            "max_retries": max_retries,
            "delay": delay,
            "status": "waiting",
        })

        # Wait with backoff
        await asyncio.sleep(delay)

        # Check if user pressed Stop during wait
        if session._interrupting:
            logger.info(f"API retry cancelled — user interrupted ({session.store_id})")
            session._api_retry_pending = False
            session._api_error_detected = False
            return

        # Notify client we're retrying now
        await session.safe_send({
            "type": "api_retry_status",
            "retry_num": retry_num,
            "max_retries": max_retries,
            "status": "retrying",
        })

        # Restart process if it died
        if not session.is_running or not session.process:
            logger.info(f"Restarting Claude process for retry {retry_num} ({session.store_id})")
            if not await self.start_agent(session):
                logger.error(f"Failed to restart Claude for retry ({session.store_id})")
                session._api_retry_pending = False
                session._api_error_detected = False
                await session.safe_send({
                    "type": "api_retry_status",
                    "retry_num": retry_num,
                    "max_retries": max_retries,
                    "status": "failed",
                    "message": session.start_error or "Failed to restart Claude",
                })
                return

        # Decide what to resend: "continue" if partial response exists, else original message
        if session.turn_tracker and session.turn_tracker.has_activity:
            retry_msg = {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "continue"}]}}
            logger.info(f"Partial response detected, sending 'continue' for retry {retry_num}")
        else:
            retry_msg = session._last_agent_msg
            logger.info(f"No partial response, resending original message for retry {retry_num}")

        success = await self.send_to_agent(session, retry_msg)
        session._api_retry_pending = False
        session._api_error_detected = False

        if not success:
            logger.error(f"Failed to resend message for retry ({session.store_id})")
            await session.safe_send({
                "type": "api_retry_status",
                "retry_num": retry_num,
                "max_retries": max_retries,
                "status": "failed",
                "message": "Failed to resend message",
            })

    async def _read_agent_stderr(self, session: AgentSession):
        """Read and forward Claude's stderr."""
        try:
            while session.process and session.is_running:
                line = await read_line_unlimited(session.process.stderr)
                if not line:
                    break

                line_str = line.decode('utf-8').strip()
                if line_str:
                    logger.warning(f"Claude stderr: {_sanitize_for_log(line_str)}")

                    # Log ALL stderr to session's raw.jsonl for debugging
                    if session.store_id:
                        SessionStore.log_raw_error(
                            session.store_id,
                            "stderr",
                            line_str
                        )

                    # Provider classifies the line; the session applies its own
                    # state gates (retry budget, pending message) on top.
                    stderr_class = session.provider.classify_stderr(line_str)
                    if stderr_class == StderrClass.STALE_SESSION:
                        logger.info(f"Stale session detected, clearing session_id")
                        await session.handle_stale_session()
                    elif stderr_class == StderrClass.COMPACTING:
                        logger.info(f"Auto-compaction detected for session {session.store_id}")
                        await session.safe_send({
                            "type": "status",
                            "status": "compacting",
                            "message": "Compacting conversation history..."
                        })
                    # Retryable API errors (500, 529, overloaded) — suppress raw forwarding
                    elif (stderr_class == StderrClass.RETRYABLE
                          and session._api_retry_count < session._api_retry_max
                          and session._last_agent_msg is not None):
                        session._api_error_detected = True
                        logger.info(f"Retryable API error in stderr for {session.store_id}: {_sanitize_for_log(line_str[:200])}")
                    elif session.provider.capabilities.forward_plain_stderr:
                        await session.safe_send({
                            "type": "stderr",
                            "data": line_str
                        })
                    # else: provider marks plain stderr as noise (e.g. Codex
                    # progress) — already logged to raw.jsonl above, not surfaced.
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Error reading stderr: {e}")
            if session.store_id:
                SessionStore.log_raw_error(
                    session.store_id,
                    f"server_error: Error reading stderr: {e}",
                    traceback.format_exc()
                )
            await session.safe_send({
                "type": "stderr",
                "data": f"Server error reading stderr: {e}"
            })

    async def send_to_agent(self, session: AgentSession, message: dict) -> bool:
        """Send a message to Claude's stdin."""
        if not session.process or not session.is_running:
            return False

        try:
            # Mark as actively processing (not idle)
            session.is_idle = False
            session._last_agent_msg = message  # Store original for potential API error retry

            # JSON-RPC providers (Codex app-server) drive the turn over the
            # transport — lazy thread start/resume, then turn/start — rather than
            # a single stdin write. The reader streams the response notifications.
            if session._transport is not None:
                ok = await session._transport.send_turn(message)
                if session.store_id:
                    SessionStore.log_raw(session.store_id, "in", "[jsonrpc turn/start]", message)
                return ok

            # Provider frames the message for its stdin protocol (identity for Claude).
            msg_json = json.dumps(session.provider.frame_input(message)) + "\n"
            session.process.stdin.write(msg_json.encode('utf-8'))
            await session.process.stdin.drain()
            logger.info(f"Sent to Claude: {msg_json[:200]}...")

            # Log input to raw.jsonl
            if session.store_id:
                SessionStore.log_raw(session.store_id, "in", msg_json, message)

            return True
        except Exception as e:
            logger.error(f"Error sending to Claude: {e}")
            if session.store_id:
                SessionStore.log_raw_error(
                    session.store_id,
                    f"server_error: Error sending to Claude: {e}",
                    traceback.format_exc()
                )
            await session.safe_send({
                "type": "stderr",
                "data": f"Server error sending message: {e}"
            })
            return False

    async def _handle_permission_request(self, session: AgentSession, msg: dict):
        """Forward a provider `permission_request` to the WebSocket client.

        The provider process (claude-sdk driver) is blocked in `can_use_tool`
        until a matching `permission_response` frame reaches its stdin via
        `respond_permission`. The request is kept on the session so a
        reconnecting client gets it re-sent (ws_chat replay).
        """
        request_id = msg.get("request_id")
        if not request_id:
            logger.warning("permission_request without request_id — dropping")
            return
        session._pending_permission_requests[request_id] = msg
        logger.info(f"Permission request {request_id}: {msg.get('tool_name')}")
        await session.safe_send({
            "type": "permission_request",
            **{k: v for k, v in msg.items() if k != "type"},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        session.touch()

    async def respond_permission(self, session: AgentSession, data: dict) -> bool:
        """Deliver the user's permission decision to the provider's stdin.

        Returns False when the request is unknown/expired (process restarted)
        or the process is gone — the caller surfaces that to the client.
        """
        request_id = data.get("request_id")
        if request_id not in session._pending_permission_requests:
            logger.warning(f"permission_response for unknown request {request_id!r}")
            return False
        if not session.process or not session.is_running:
            return False
        request = session._pending_permission_requests[request_id]
        frame = {
            "type": "permission_response",
            "request_id": request_id,
            "behavior": "allow" if data.get("behavior") == "allow" else "deny",
        }
        if data.get("updated_input") is not None:
            frame["updated_input"] = data["updated_input"]
        if data.get("message"):
            frame["message"] = str(data["message"])
        # "Always allow" — index into the request's `suggestions` list; the
        # driver maps it back to the engine's own permission-rule update.
        if isinstance(data.get("suggestion_index"), int):
            frame["suggestion_index"] = data["suggestion_index"]
        try:
            payload = json.dumps(frame) + "\n"
            session.process.stdin.write(payload.encode("utf-8"))
            await session.process.stdin.drain()
        except Exception as e:
            logger.error(f"Error sending permission response: {e}")
            return False
        del session._pending_permission_requests[request_id]
        if session.store_id:
            SessionStore.log_raw(session.store_id, "in", payload, frame)

        # Engine setMode suggestion ("Switch to acceptEdits mode (this
        # session)"): the CLI applies it internally, which used to desync the
        # bridge's mode state — and the UI permission button — from the
        # engine. Mirror the change here. Note: a permission card can only
        # exist on a gate-attached (non-bypass-launched) process, so the
        # launch-time _launched_resolved_mode is left alone.
        if frame["behavior"] == "allow" and isinstance(frame.get("suggestion_index"), int):
            suggestions = request.get("suggestions") or []
            idx = frame["suggestion_index"]
            chosen = suggestions[idx] if 0 <= idx < len(suggestions) else None
            if isinstance(chosen, dict) and chosen.get("type") == "setMode" and chosen.get("mode"):
                new_mode = chosen["mode"]
                # Same legacy collapse as the WS set_permission_mode handler.
                session.permission_mode = new_mode if new_mode != "bypassPermissions" else None
                # The engine already runs the new mode — don't let the lazy
                # check burn a respawn on the next message.
                session._launched_permission_mode = session.permission_mode
                session._plan_sigint_armed = (new_mode == "plan")
                if session.store_id:
                    SessionStore.update_metadata(session.store_id, permission_level=new_mode)
                logger.info(f"Synced permission mode after engine setMode "
                            f"suggestion for {session.store_id}: {new_mode}")
                await session.safe_send({
                    "type": "permission_mode_changed",
                    "mode": new_mode,
                    "applied": "live",
                    "message": f"Permission mode set to: {new_mode}",
                })

        session.touch()
        return True

    # Monotonic control_request ids, unique across all sessions of this bridge.
    _control_ids = itertools.count(1)

    async def send_control(self, session: AgentSession, action: str,
                           payload: Optional[dict] = None,
                           timeout: float = 5.0) -> bool:
        """Round-trip a `control_request` to a live_controls provider process.

        Writes the frame to the process stdin and awaits the driver's
        `control_done` ack (routed by the read loop into _pending_control).
        Returns False on nack, timeout, write failure, or a process that
        can't take controls — callers fall back to the lazy kill+respawn
        path, so a failure here is never worse than the pre-live behavior.
        """
        if (not session.process or not session.is_running
                or not session.provider.capabilities.live_controls):
            return False
        control_id = f"ctl-{next(self._control_ids)}"
        frame = {"type": "control_request", "control_id": control_id,
                 "action": action}
        if payload:
            frame.update(payload)
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        session._pending_control[control_id] = fut
        try:
            data = json.dumps(frame) + "\n"
            session.process.stdin.write(data.encode("utf-8"))
            await session.process.stdin.drain()
            if session.store_id:
                SessionStore.log_raw(session.store_id, "in", data, frame)
            return bool(await asyncio.wait_for(fut, timeout=timeout))
        except Exception as e:
            logger.warning(f"control {action} failed for {session.store_id}: {e}")
            return False
        finally:
            session._pending_control.pop(control_id, None)

    def _arm_interrupt_watchdog(self, session: AgentSession, turn_before: int) -> None:
        """Escalate a graceful interrupt whose turn never finalized.

        The driver acks `interrupt` before the aborted turn's result frame
        arrives. If that frame never lands (wedged CLI), the warm process
        would hold a half-open turn forever — so after a grace window, kill
        it exactly like the SIGINT path would have. Quietly: the client
        already got its interrupted+ready frames.

        Skip conditions: the result arrived (turn_number moved), a new turn
        started (is_idle went False), or the process is already gone.
        """
        async def _watch():
            await asyncio.sleep(10.0)
            if (session.process and session.is_running
                    and session.is_idle
                    and session.turn_number == turn_before):
                logger.warning(
                    f"Graceful interrupt did not finalize within 10s for "
                    f"{session.store_id} — killing the process")
                session._interrupting = True
                await self.stop_session(session)
                session._interrupting = False

        session._interrupt_watchdog = asyncio.create_task(_watch())

    async def interrupt_agent(self, session: AgentSession) -> bool:
        """
        Interrupt Claude's current operation.

        Sends SIGINT to stop current response. Does NOT restart Claude.
        Claude will be restarted automatically when user sends next message.

        Sets _interrupting flag so _cleanup_process (called by the read task's
        finally block) skips sending "session_ended" and error messages.
        """
        if not session.process or not session.is_running:
            return False

        # JSON-RPC providers (Codex app-server): abort the in-flight turn over
        # the wire and keep the persistent process alive for the next turn. The
        # turn/completed (interrupted) notification finalizes via the result
        # handler; we proactively flip to idle so the UI unblocks immediately.
        if session._transport is not None:
            try:
                session._interrupting = True
                session._api_retry_pending = False
                session._api_error_detected = False
                session._api_retry_count = 0
                await session._transport.interrupt()
                await session.safe_send({"type": "interrupted", "message": "Stopping current response..."})
                session.is_idle = True
                session.touch()
                await session.safe_send({"type": "ready", "message": "Stopped. Send your next message."})
                return True
            except Exception as e:
                logger.error(f"Error interrupting via transport: {e}")
                return False
            finally:
                session._interrupting = False

        # Live-controls providers (claude-sdk driver): abort the turn over the
        # control plane and keep the process warm — the next message skips the
        # respawn + --resume cost. The driver first denies any can_use_tool
        # callbacks blocked on pending asks, then calls the SDK's interrupt();
        # the CLI aborts and emits the aborted turn's result frame through the
        # normal stream, so _finalize_turn still records cost/tokens (the
        # SIGINT path below loses them to the process kill). On nack/timeout
        # we fall through to SIGINT — a wedged driver must never survive Stop.
        if (session._transport is None
                and session.provider
                and session.provider.capabilities.live_controls):
            turn_before = session.turn_number
            was_mid_turn = not session.is_idle
            try:
                session._interrupting = True
                session._api_retry_pending = False
                session._api_error_detected = False
                session._api_retry_count = 0
                if await self.send_control(session, "interrupt"):
                    # The driver already denied the blocked asks; retire them
                    # bridge-side too. The client expires its permission cards
                    # on the `interrupted` frame.
                    session._pending_permission_requests = {}
                    await session.safe_send({
                        "type": "interrupted",
                        "message": "Stopping current response..."
                    })
                    session.is_idle = True
                    session.touch()
                    await session.safe_send({
                        "type": "ready",
                        "message": "Stopped. Send your next message."
                    })
                    # The ack precedes the aborted turn's result frame; if a
                    # turn was active and its result never lands, escalate.
                    if was_mid_turn:
                        self._arm_interrupt_watchdog(session, turn_before)
                    return True
                logger.warning(f"Graceful interrupt failed for "
                               f"{session.store_id} — escalating to SIGINT")
            finally:
                # Mirrors the jsonrpc branch: reset now; the result frame
                # finalizes on its own. (Shared narrow edge: a turn already
                # dying of a retryable API error at Stop time may still
                # trigger one auto-retry once the flag is down.)
                session._interrupting = False

        try:
            logger.info("Interrupting Claude with SIGINT")
            session._interrupting = True
            # Cancel any pending API retry
            session._api_retry_pending = False
            session._api_error_detected = False
            session._api_retry_count = 0
            session.process.send_signal(signal.SIGINT)

            # Notify client that we're stopping
            await session.safe_send({
                "type": "interrupted",
                "message": "Stopping current response..."
            })

            # Wait for process to actually end
            try:
                await asyncio.wait_for(session.process.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                logger.warning("Process didn't stop gracefully, killing")
                session.process.kill()
                await session.process.wait()

            # Wait for the read task to finish its cleanup via _cleanup_process
            if session._read_task:
                try:
                    await asyncio.wait_for(session._read_task, timeout=3.0)
                except (asyncio.CancelledError, asyncio.TimeoutError):
                    pass

            session.is_running = False
            session.process = None
            session.touch()

            # Don't restart Claude here - it will be restarted on next message
            await session.safe_send({
                "type": "ready",
                "message": "Stopped. Send your next message."
            })
            return True

        except Exception as e:
            logger.error(f"Error interrupting Claude: {e}")
            return False
        finally:
            session._interrupting = False

    async def stop_session(self, session: AgentSession):
        """Stop a Claude session's process (but keep session in registry)."""
        session.is_running = False

        # Cancel background tasks
        for task in [session._read_task, session._stderr_task]:
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        if session.process:
            try:
                session.process.terminate()
                await asyncio.wait_for(session.process.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                session.process.kill()
            except Exception as e:
                logger.error(f"Error stopping process: {e}")
            session.process = None

        session._transport = None  # drop the JSON-RPC driver bound to that process
        session.touch()  # Update last activity for cleanup timer

    async def _fetch_and_send_context_update(
        self,
        session: 'AgentSession',
        turn_data: Optional[dict] = None
    ):
        """
        Background task to fetch accurate token usage via /context command.

        Runs after each turn completes. Forks from the Claude session to get
        real context window usage, then sends update to connected client
        and stores in session history for analytics.

        Args:
            session: The Claude session
            turn_data: Optional dict with turn info:
                - turnNumber: Current turn number
                - durationMs: Turn duration in milliseconds
                - costUsd: Turn cost in USD
                - changedFiles: List of files modified this turn
                - toolsSummary: Dict of tool name -> count
        """
        try:
            # Resolve effective model for accurate context window size
            effective_model = session.preferred_model
            if not effective_model and session.store_id:
                meta = SessionStore.load_meta(session.store_id)
                if meta and meta.get("preferred_model"):
                    effective_model = meta["preferred_model"]
            if not effective_model:
                from painapple_code import bridge_paths
                from painapple_code.routes.dependencies import preferred_model_survives
                effective_model = bridge_paths.engine_default_model(session.provider)
                # Same catalog gate as launch: a default from another
                # engine's catalog must not steer this engine's probe.
                if not preferred_model_survives(effective_model, session.provider):
                    effective_model = None

            # Pass session ID to get actual context (not just base overhead)
            token_info = await session.provider.fetch_context(
                session.cwd, session.session_id,
                token_profile=resolve_profile(session.token_profile, session.provider),
                model=effective_model,
            )
            if not token_info:
                logger.warning("provider.fetch_context returned None — /context may be broken in this CLI version")
                return
            await self._emit_context_update(session, token_info, turn_data)
        except Exception as e:
            logger.warning(f"Failed to fetch context update: {e}")

    # Turn-data fields copied verbatim onto a context_update / its stored record,
    # so the frontend can match the snapshot to its turn-summary bar.
    _CONTEXT_TURN_FIELDS = (
        "turnNumber", "durationMs", "costUsd", "changedFiles",
        "toolsSummary", "fileActions", "readImages", "rateLimited", "model", "dbTurnId",
    )

    async def _emit_context_update(
        self,
        session: 'AgentSession',
        token_info: dict,
        turn_data: Optional[dict] = None,
    ):
        """Send a context_update to the client and persist it for analytics.

        Shared by both context paths: Claude's `/context` fork
        (`_fetch_and_send_context_update`) and providers that synthesize the
        snapshot from a turn's usage (`provider.context_from_result`).
        """
        update_msg = {
            "type": "context_update",
            "contextTokens": token_info["contextTokens"],
            "contextWindow": token_info["contextWindow"],
            "breakdown": token_info.get("breakdown"),
            "memoryFiles": token_info.get("memoryFiles"),
            "cwd": session.cwd,  # Include cwd for file path resolution
        }
        if turn_data:
            for field in self._CONTEXT_TURN_FIELDS:
                update_msg[field] = turn_data.get(field)

        if session.ws_connected:
            await session.safe_send(update_msg)

        # Store in session history for analytics (include turn data)
        store_msg = {
            "role": "context",
            "contextTokens": token_info["contextTokens"],
            "contextWindow": token_info["contextWindow"],
            "percentage": token_info.get("percentage"),
            "breakdown": token_info.get("breakdown"),
            "memoryFiles": token_info.get("memoryFiles"),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        if turn_data:
            for field in self._CONTEXT_TURN_FIELDS:
                store_msg[field] = turn_data.get(field)

        if session.store_id:
            SessionStore.add_message(session.store_id, store_msg)

        logger.debug(f"Context update: {token_info['contextTokens']}/{token_info['contextWindow']}")

