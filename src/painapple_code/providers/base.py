"""
Provider interface + the data types it exchanges with the session layer.

A `Provider` owns everything CLI-shaped: how to build the launch argv, how to
frame a user message for stdin, how to parse a stdout line into a canonical
event, how to normalize cost, and how to classify stderr. The generic session
lifecycle (subprocess spawn, registry, turn tracking, WebSocket plumbing) lives
in `services/agent_session.py` and delegates to `session.provider`.

The canonical event shape is Claude's stream-json schema (see the package
docstring). `ClaudeProvider` is therefore a near-identity adapter; other
providers translate their native output into this shape inside `parse_line`.

Providers must be stateless — any per-subprocess running state (e.g. Claude's
cumulative cost) is held in a per-session `CostState` passed in by the caller,
so a single provider instance can be shared across all sessions.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


@dataclass(frozen=True)
class Capabilities:
    """Declarative feature flags a provider's CLI supports.

    Generic code branches on these instead of assuming Claude semantics — e.g.
    the shadow-git rich-commit summary fork only runs when `rich_commit_summaries`
    is set.
    """
    resume: bool = False             # supports resuming a prior session
    fork: bool = False               # supports forking a session (--fork-session)
    permission_modes: bool = False   # has a permission-mode concept
    effort: bool = False             # has an effort/thinking-budget knob
    thinking_display: bool = False   # streams thinking blocks
    context_command: bool = False    # can report context-window usage
    cumulative_cost: bool = False    # reports cost as a per-process running total
    # Supports the post-turn background fork that generates AI rich-commit
    # sections (summary, tags, work_done, …). The fork resumes the provider's
    # own on-disk session, so today only Claude can do it; named for what it
    # gates, not the Haiku model it happens to use.
    rich_commit_summaries: bool = False
    # Process model. True (Claude): one long-lived subprocess reads successive
    # user messages from stdin across many turns. False (Codex): a fresh
    # subprocess per turn with the prompt in argv that exits when the turn ends —
    # a normal exit, not "session ended". The session layer branches on this.
    persistent_process: bool = True
    # Wire protocol the session layer speaks to the subprocess. "lines" (default):
    # newline-delimited JSON — read events off stdout, write user messages to
    # stdin (the only shape Claude/Codex-exec need). "jsonrpc": the provider
    # supplies a transport (see `make_transport`) that owns a bidirectional
    # JSON-RPC conversation — a multi-step turn handshake, id-correlated
    # responses, and server-initiated requests — none of which the one-way line
    # protocol can express. Implies `persistent_process=True`; the session layer
    # delegates the send/intake/interrupt side to the transport but still reads
    # stdout with the same loop (so `parse_line` + `translate_events` apply).
    transport: str = "lines"
    # Whether ordinary (StderrClass.NONE) stderr lines are surfaced to the
    # client. Codex prints human progress to stderr even with --json, so its
    # adapter sets this False (the lines are still logged to raw.jsonl).
    forward_plain_stderr: bool = True
    # Interactive permission prompts: the provider's process emits
    # `permission_request` events on stdout and accepts `permission_response`
    # frames on stdin (claude-sdk driver via `can_use_tool`). The session layer
    # round-trips these to the WebSocket client instead of relying on headless
    # auto-deny. Providers without it keep the is_error-tool-result behavior.
    interactive_permissions: bool = False
    # Control-plane frames over the same stdin/stdout pipe: the process accepts
    # `control_request` frames (set_permission_mode / set_model / interrupt)
    # and acks each with a `control_done` line (claude-sdk driver via the SDK
    # client's control methods). The session layer then applies mode/model
    # changes live instead of lazy kill+respawn, and Stop interrupts the turn
    # without killing the process. Distinct from the jsonrpc transport's native
    # interrupt (Codex), which rides the transport object. Acks are mandatory:
    # on nack/timeout callers fall back to the kill+respawn path, so a failed
    # control is never worse than not having the capability at all.
    live_controls: bool = False


@dataclass
class LaunchOptions:
    """Fully-resolved values for one subprocess launch.

    The session layer resolves model/effort/permission from its hierarchy
    (in-memory override → session meta → global config) and passes the resolved
    values here; the provider only turns them into argv. `None` means "let the
    CLI use its own default".
    """
    model: Optional[str] = None
    # Automatic fallback when the primary model is overloaded/unavailable
    # (`--fallback-model`). None = no fallback, the CLI default.
    fallback_model: Optional[str] = None
    effort: Optional[str] = None
    permission_mode: Optional[str] = None
    session_id: Optional[str] = None            # resume target
    fork_from_session_id: Optional[str] = None  # fork source (takes precedence)
    # Ephemeral providers (persistent_process=False) embed the turn's prompt and
    # images in the launch argv rather than streaming them over stdin. Ignored by
    # persistent providers, which frame the message via `frame_input` instead.
    prompt: Optional[str] = None
    images: Optional[list] = None


@dataclass
class CostState:
    """Per-subprocess cumulative cost/usage tracker.

    Only meaningful for providers whose CLI reports running totals across the
    subprocess lifetime (Claude). One instance per subprocess; reset by the
    session layer on each (re)start via `provider.new_cost_state()`.
    """
    cum_cost: float = 0.0
    cum_usage: dict = field(default_factory=dict)


@dataclass
class SummaryForkPlan:
    """How to spawn a provider's post-turn rich-commit summarizer fork.

    The shadow-git layer owns the generic plumbing (subprocess registry,
    timeout, cancellation, markdown rendering); a provider only supplies the
    argv + any temp files it created (via `build_summary_fork`) and later turns
    the raw output back into structured data (via `parse_summary_fork`). The
    fork must summarize the turn *without* mutating the user's real session —
    Claude branches with `--fork-session`; Codex copies its rollout under a
    fresh id first (`codex exec resume` writes in place).
    """
    argv: list[str]
    env: Optional[dict] = None
    model: str = ""                       # label for the Active Sessions widget
    output_file: Optional[str] = None     # file the structured JSON lands in (None → stdout)
    cleanup_paths: list = field(default_factory=list)  # temp copies/files to remove after
    # Prompt to feed the fork over stdin instead of an argv element. Keeps a
    # large journey/tools prompt out of `ps` and clear of ARG_MAX. When set, the
    # spawner opens stdin as a PIPE and writes this before reading stdout; the
    # provider MUST omit the prompt from argv (e.g. Claude's bare `-p`, no
    # positional). None → the prompt rides in argv as before.
    stdin_input: Optional[str] = None
    # Provider-private data for a transport-driven summary (see
    # `drive_summary_fork`). Line/exec providers leave this None and use the
    # spawned argv's stdout via `parse_summary_fork`; a JSON-RPC provider stashes
    # here what its drive step needs (source thread id, prompt, output schema, …).
    payload: Optional[dict] = None


@dataclass(frozen=True)
class PluginBackend:
    """How to drive an engine's plugin-manager CLI for the plugins browser.

    Both Claude (`claude plugins …`) and Codex (`codex plugin …`) expose a
    ``list --json`` returning ``{installed, available}`` and install/uninstall
    verbs, so the route stays generic and only the verbs/paths differ. Engines
    without an enable/disable concept leave those ``None`` (the UI hides the
    toggle). ``marketplace_root`` is the on-disk dir used for the component
    inventory; ``None`` skips inventory for that engine.
    """
    binary: str
    list_installed_args: list             # args yielding {installed, available} for installed only
    list_all_args: list                   # same but including the marketplace catalog
    install_verb: list                    # e.g. ["plugins","install"] / ["plugin","add"]
    uninstall_verb: list
    enable_verb: Optional[list] = None    # None → engine has no enable/disable
    disable_verb: Optional[list] = None
    marketplace_root: Optional[object] = None  # Path for component inventory; None → skip


class StderrClass(str, Enum):
    """Classification of a single stderr line. The session layer applies its
    own state gates (retry budget, etc.) on top of this pure-text verdict."""
    NONE = "none"                    # ordinary diagnostic — forward to client
    STALE_SESSION = "stale_session"  # resume target no longer exists
    COMPACTING = "compacting"        # context auto-compaction in progress
    RETRYABLE = "retryable"          # transient API error worth retrying


class Provider(ABC):
    """Adapter for one CLI AI agent. See module docstring for the contract."""

    name: str = "base"
    display_name: str = "Base"
    # One-line, user-facing "what is this engine" for the picker row. Each
    # provider self-describes (nothing is hardcoded per engine in the UI).
    description: str = ""
    # Whether this engine is offered in the picker out of the box. The user
    # flips engines on/off in Settings (`providers_enabled` config overrides);
    # this is only the pre-override default, self-described so nothing is
    # hardcoded per engine elsewhere. Defaults True so a drop-in third-party
    # provider shows up without extra steps; in-tree "same engine, plainer
    # driver" variants (claude CLI, codex exec) ship False to keep the picker
    # down to one entry per engine. Disabled ≠ unavailable: existing sessions
    # bound to a disabled engine keep working, and explicit API selection
    # (?provider=, PUT) still accepts it — this gates only the UI listing.
    default_enabled: bool = True
    # Global-config key holding a user override for `binary()` (e.g.
    # "claude_path"), and the bare command it falls back to when unset.
    # Drives the generic Settings "CLI path" row + /api/bridge/engine-path
    # endpoint; None → this engine has no path setting (row hidden).
    # Same-engine driver variants share one key (both Claude drivers run the
    # same binary), so the setting edits the engine, not the driver.
    path_config_key: Optional[str] = None
    default_binary: str = ""
    # Copy-paste CLI hint for the "Continue in CLI" quick action: a shell
    # command template that resumes a session by id ("{id}" placeholder). Self-
    # described so the client never hardcodes an engine's resume verb (Claude
    # "claude -r {id}", Codex "codex exec resume {id}"). None → the action is
    # hidden for this engine.
    cli_resume_template: Optional[str] = None
    # Whether the app owns this engine's model catalog (Settings shows an
    # editor writing models.yaml). False → `models()` is read-only, sourced
    # from the engine's own tooling (e.g. Codex's models_cache.json), and
    # Settings renders the definitions without edit affordances (per-model
    # show/hide toggles still apply — see `enabled_models()`).
    models_editable: bool = False
    # Namespace for per-model visibility prefs (the `models_disabled` config
    # map: {key: [hidden ids]}). Driver variants that surface the SAME
    # catalog (claude/claude-sdk share models.yaml; codex/codex-app-server
    # share models_cache.json) set one key so hiding a model hides it on
    # both. None → this provider's own name (a drop-in provider gets its own
    # namespace with no extra steps).
    models_key: Optional[str] = None
    # CLI login surface (Settings → Engines auth row). `auth_status_args` are
    # appended to the resolved binary for a fast non-interactive login-status
    # probe (drives GET /api/bridge/engine-auth/{name}); None → the engine
    # shows no login row. `auth_login_args` is the CLI's own interactive
    # login flow — the client runs it in a PTY terminal tab, so pick a
    # variant whose prompts survive a remote box (device-code flows beat
    # open-a-browser flows that bind localhost on the server).
    auth_status_args: Optional[list] = None
    auth_login_args: Optional[list] = None
    # Auto-journal (rich-commit summary) model. The journal fork always runs
    # on the session's OWN engine — only the engine that owns a conversation
    # can fork it — so the summarizer model is inherently a per-engine
    # setting. Providers storing the override in the global config set the
    # key here (driver pairs share one, like `path_config_key`); providers
    # with their own storage override the get/set methods instead (Claude →
    # models.yaml `summary_model`). Neither → no journal-model knob in
    # Settings. `summary_model_placeholder` names what an EMPTY override
    # means for this engine (e.g. Codex inherits the session's model).
    summary_model_config_key: Optional[str] = None
    summary_model_placeholder: str = ""
    capabilities: Capabilities = Capabilities()

    # --- launch -----------------------------------------------------------

    @abstractmethod
    def binary(self) -> str:
        """Resolve the CLI executable (name on PATH or absolute path)."""

    def binary_not_found_hint(self) -> str:
        """User-facing remediation appended when the executable can't be spawned.

        Providers with a configurable path setting should point at it here.
        """
        return "Install the CLI and make sure it's on the server's PATH."

    @abstractmethod
    def build_command(self, opts: LaunchOptions) -> list[str]:
        """Build the full subprocess argv for a streaming session."""

    @abstractmethod
    def frame_input(self, message: dict) -> dict:
        """Envelope a user message for the CLI's stdin protocol.

        Only called on the stdin line path (persistent ``"lines"`` providers).
        The argument is the canonical user message; return the exact dict to
        JSON-encode onto the process's stdin. Providers that never read turns
        from stdin — ephemeral argv prompts (`persistent_process=False`) or a
        JSON-RPC transport — should raise `NotImplementedError` so a mis-wired
        send fails loudly instead of silently writing garbage.
        """

    def make_transport(self, process, opts: "LaunchOptions", session) -> Optional[object]:
        """Build the JSON-RPC transport driver for a freshly spawned process.

        Only called when ``capabilities.transport == "jsonrpc"``; returns the
        object the session layer drives instead of the stdin/stdout line
        protocol (``None`` falls back to lines). It is intentionally duck-typed
        — kept off the seam to avoid an asyncio dependency here — and must
        provide:

            async initialize() -> None
                Run the post-spawn handshake (e.g. JSON-RPC ``initialize``).
            intake(native: dict) -> bool
                Inspect one parsed stdout message *before* translation: resolve
                pending responses, answer server-initiated requests. Return True
                to let it continue to ``translate_events`` (it's a stream event),
                False to swallow it (protocol bookkeeping).
            async send_turn(message: dict) -> bool
                Send one user turn (the canonical user message), running any lazy
                thread start/resume first.
            async interrupt() -> None
                Abort the in-flight turn without killing the process.

        ``process`` is the live `asyncio` subprocess, ``opts`` the resolved
        `LaunchOptions` for this launch, and ``session`` the owning
        `AgentSession` (for `cwd`, `session_id`, store id, metadata writes).
        """
        return None

    # --- output parsing ---------------------------------------------------

    def parse_line(self, raw: str) -> dict:
        """Parse one raw stdout line into a canonical event dict.

        Default is `json.loads` (identity for Claude's stream-json). Raises
        `json.JSONDecodeError` on a non-event line, which the caller forwards as
        `raw_output` — preserve that contract when overriding.
        """
        return json.loads(raw)

    def translate_events(self, event: dict, state: dict) -> list[dict]:
        """Translate one native event into zero or more canonical events.

        The canonical shape is Claude's stream-json schema
        (`system`/`assistant`/`user`/`result`), which the session handlers
        consume. Claude is already canonical, so the default is identity. A
        single native line may fan out (e.g. a Codex command result becomes an
        assistant `tool_use` *and* a user `tool_result`), hence the list return.

        `state` is a per-subprocess scratch dict owned and reset by the session
        layer — providers stay stateless by stashing per-turn translation state
        (item-id → tool-id maps, etc.) there rather than on `self`.
        """
        return [event]

    @abstractmethod
    def session_id_from_event(self, event: dict) -> Optional[str]:
        """Extract the CLI's session id from a *native* (pre-translation)
        event, or None when this event doesn't carry one.

        Every engine names this differently (Claude: `session_id` on each
        stream-json line; Codex: `thread_id` on `thread.started`), so there is
        no neutral default — each provider reads its own wire.
        """

    def new_cost_state(self) -> CostState:
        """Fresh per-subprocess cost tracker (reset on each (re)start)."""
        return CostState()

    def normalize_result(self, msg: dict, state: CostState) -> None:
        """Normalize a `result` event in place (e.g. cumulative→delta).

        Default is a no-op — the provider already reports per-turn figures.
        Providers with `capabilities.cumulative_cost` rewrite `msg` using
        `state` and update `state` for the next result.
        """
        return None

    # --- error / lifecycle classification ---------------------------------

    def classify_stderr(self, line: str) -> StderrClass:
        """Classify a stderr line. Default: ordinary diagnostic."""
        return StderrClass.NONE

    def is_retryable_api_error(self, text: str) -> bool:
        """Whether an error string is a transient API error worth retrying."""
        return False

    def is_auth_error(self, text: str, api_error_status: Optional[int] = None) -> bool:
        """Whether a failed turn is an authentication failure the user can fix
        by re-logging in (expired token, invalid key, 401). The session layer
        surfaces a one-click re-login affordance when this is True.

        `text` is the turn's result/error string; `api_error_status` is the
        CLI's numeric HTTP status when present (Claude reports `api_error_status`
        on the result event). Default: never an auth error.
        """
        return False

    def is_usage_limit(self, text: str) -> bool:
        """Whether `text` reports a usage/rate/session limit ("You've hit your
        limit · resets 5pm", "hit your session limit", …).

        The session layer checks this against MORE than the result string,
        because engines don't deliver limits uniformly: the Claude CLI can
        surface one as a synthetic assistant bubble in a turn whose result is
        `is_error:false` (e.g. a /compact continuation), or in a compaction
        settle frame's `compact_error`. When True the turn is marked
        rate-limited: the turn bar shows it and the /context probe is skipped.

        Implementations should require SHORT text (genuine limit reports are
        one-liners) so long prose that merely quotes a limit phrase — an
        assistant reply discussing limits, pasted logs — can never match.
        Default: never a limit.
        """
        return False

    @property
    def normal_termination_codes(self) -> frozenset:
        """Exit codes that mean "stopped normally", not "crashed". Defaults to
        the signal-based set shared with the Claude CLI."""
        from painapple_code.utils.agent_cli import NORMAL_TERMINATION_CODES
        return NORMAL_TERMINATION_CODES

    # --- rich-commit summary fork -----------------------------------------

    def build_summary_fork(
        self,
        *,
        session_id: str,
        fork_prompt: str,
        schema_json: str,
        cwd: str,
        token_profile: Optional[str] = None,
        session_model: Optional[str] = None,
    ) -> Optional["SummaryForkPlan"]:
        """Plan the post-turn fork that generates rich-commit sections.

        Returns a `SummaryForkPlan` (argv + temp files), or None when the
        provider can't fork this turn (no session id, rollout not found, …) — in
        which case the turn still gets a basic shadow commit, just without
        AI-generated sections. Only called when
        `capabilities.rich_commit_summaries` is set.
        """
        return None

    def parse_summary_fork(
        self,
        *,
        plan: "SummaryForkPlan",
        returncode: int,
        stdout: bytes,
        stderr: bytes,
    ) -> tuple[Optional[dict], Optional[dict]]:
        """Parse the fork's output into (structured_data, cost).

        `structured_data` is the section_id→value dict (or None on failure);
        `cost` is `{"cost", "input_tokens", "output_tokens"}` (or None). The
        shadow-git layer renders the dict to markdown and records the cost.
        """
        return None, None

    async def drive_summary_fork(
        self,
        proc,
        plan: "SummaryForkPlan",
    ) -> tuple[Optional[dict], Optional[dict]]:
        """Conduct a transport-driven summary over an already-spawned process.

        The shadow-git layer always spawns ``plan.argv``; for a provider whose
        ``capabilities.transport`` isn't the default ``"lines"`` it then hands the
        live process here (stdin piped) instead of reading its stdout. The
        provider runs whatever multi-step conversation its wire needs (e.g. a
        JSON-RPC ``thread/fork`` + ``turn/start``) and returns the same
        ``(structured_data, cost)`` pair as `parse_summary_fork`, leaving the
        process terminated. The shadow-git layer keeps owning the registry entry,
        the 300s timeout, and cleanup.

        Only called for non-``"lines"`` providers; the default raises so a
        mis-declared provider fails loudly rather than silently producing no
        sections.
        """
        raise NotImplementedError(
            f"{self.display_name} declares a non-line transport but has no "
            "drive_summary_fork")

    # --- introspection ----------------------------------------------------

    async def fetch_context(
        self,
        cwd: str,
        session_id: Optional[str] = None,
        token_profile: Optional[str] = None,
        model: Optional[str] = None,
    ) -> Optional[dict]:
        """Report context-window usage for a session, or None if unsupported.

        Used by providers whose CLI has a dedicated context probe
        (`capabilities.context_command`) — e.g. Claude forks a `/context` run.
        Spawns a subprocess, so the session layer calls it in the background.
        """
        return None

    def context_from_result(
        self,
        result_msg: dict,
        model: Optional[str] = None,
    ) -> Optional[dict]:
        """Synthesize a context-window snapshot from a finished turn's result.

        For engines with no `/context` command (`context_command=False`) that
        nonetheless report per-turn token usage, the session layer calls this
        right after a turn instead of `fetch_context` — deriving the meter from
        the turn's own usage costs no extra subprocess. Returns the same shape
        `fetch_context` does (``{contextTokens, contextWindow, percentage?,
        breakdown?, memoryFiles?}``) or None when no usage is available.

        Default None — providers that probe via `fetch_context` (Claude) leave
        this unimplemented; the two paths are mutually exclusive per provider.
        """
        return None

    # --- selection metadata (drives the engine picker UI) -----------------

    def is_available(self) -> tuple[bool, Optional[str]]:
        """Whether this provider's CLI is installed and usable.

        Returns ``(available, reason_if_not)``. The default probes `binary()`
        on PATH; providers add auth/login checks by overriding. The UI greys
        out unavailable providers and shows `reason` as the fix hint.
        """
        import shutil
        from pathlib import Path
        try:
            binary = self.binary()
        except NotImplementedError as e:
            return False, str(e)
        except Exception as e:  # pragma: no cover - defensive
            return False, f"{self.display_name} unavailable: {e}"
        found = Path(binary).exists() if Path(binary).is_absolute() else shutil.which(binary)
        if not found:
            return False, f"{binary} not found on PATH"
        return True, None

    def parse_auth_status(self, returncode: int, stdout: str, stderr: str) -> dict:
        """Interpret the `auth_status_args` probe → ``{logged_in, detail}``.

        Default: exit 0 = logged in, first non-empty output line as the
        user-facing detail (scans both streams — CLIs disagree on where
        status text goes). Providers with structured status output override.
        """
        line = next(
            (ln.strip() for ln in f"{stdout or ''}\n{stderr or ''}".splitlines() if ln.strip()),
            "")
        return {"logged_in": returncode == 0, "detail": line[:160]}

    def accounts(self) -> list[dict]:
        """Selectable identities/accounts for this provider.

        The session "account" leaf under a provider: each entry is
        ``{"id": str, "label": str}`` where ``id`` is the value stored on the
        session (empty string = the provider's default/ambient login). Claude
        maps these to token profiles; Codex uses ambient `codex login` and so
        returns none. Empty list = the UI shows no account sub-menu.
        """
        return []

    def models(self) -> list[dict]:
        """In-app selectable models for this provider: ``{id, label, desc}``.

        Empty = the app doesn't manage this engine's model (e.g. Codex uses the
        model configured by `codex login`), and the UI hides the model chip.

        This is the FULL catalog (definitions). What pickers actually offer is
        `enabled_models()` — the same list minus ids the user hid in Settings.
        """
        return []

    def disabled_model_ids(self) -> set:
        """Model ids the user hid for this engine (Settings → Engines toggles).

        Read from the global config's ``models_disabled`` map under this
        provider's `models_key` namespace. May contain ids not in the current
        catalog (e.g. a CLI-owned catalog changed underneath) — kept as-is so
        the preference survives catalog churn.
        """
        from painapple_code import bridge_paths
        raw = (bridge_paths.load_global_config().get("models_disabled") or {})
        ids = raw.get(self.models_key or self.name)
        if not isinstance(ids, list):
            return set()
        return {x for x in ids if isinstance(x, str) and x}

    def summary_model_editable(self) -> bool:
        """Whether Settings shows an auto-journal model knob for this engine."""
        return bool(self.summary_model_config_key)

    def get_summary_model_override(self) -> Optional[str]:
        """The configured journal-model override; None/empty = engine default
        (for Codex that means the summary fork inherits the thread's model)."""
        if not self.summary_model_config_key:
            return None
        from painapple_code import bridge_paths
        value = bridge_paths.load_global_config().get(self.summary_model_config_key)
        return value if isinstance(value, str) and value else None

    def set_summary_model_override(self, value: Optional[str]) -> None:
        """Persist (or clear with None/empty) the journal-model override."""
        if not self.summary_model_config_key:
            raise ValueError(f"{self.display_name} has no journal-model setting")
        from painapple_code import bridge_paths
        config = bridge_paths.load_global_config()
        cleaned = (value or "").strip()
        if cleaned:
            config[self.summary_model_config_key] = cleaned
        else:
            config.pop(self.summary_model_config_key, None)
        bridge_paths.save_global_config(config)

    def enabled_models(self) -> list[dict]:
        """`models()` minus the user's hidden set — the catalog pickers offer.

        Everything that treats the catalog as an *offering* consumes this
        (describe() → /api/providers → chip/popup/setup panel/default-model
        select, and `preferred_model_survives`). Launch-side foreign-id guards
        keep using the raw `models()` so a session bound to a since-hidden
        model keeps working.
        """
        disabled = self.disabled_model_ids()
        if not disabled:
            return self.models()
        return [m for m in self.models() if m.get("id") not in disabled]

    def effort_levels(self) -> list[str]:
        """Effort levels this engine meaningfully distinguishes, low→high.

        Empty when `capabilities.effort` is False. Claude exposes the full
        low→max scale; Codex caps at high, so it lists only what changes the
        outcome (the UI hides the rest).
        """
        return []

    @abstractmethod
    def permission_modes(self) -> list[dict]:
        """Permission options for this engine: ``{value, label, desc, color}``.

        ``value`` is this provider's OWN native vocabulary, stored verbatim on
        the session and passed through at launch (e.g. Codex →
        read-only/workspace-write/danger-full-access). ``color`` lets the UI
        render the tier without knowing the provider's scheme. Every provider
        must self-describe its modes — there is no shared fallback vocabulary
        (the permission endpoints and the engine picker read this list, and
        `valid_permission_values()` unions it across providers).
        """

    def default_permission_mode(self) -> Optional[str]:
        """This provider's own default permission value (one of
        ``permission_modes()``), used for a fresh session instead of inheriting
        the app's global (Claude) default. ``None`` → use the global default.
        """
        return None

    # --- customization surfaces (skills / agents browsers) ----------------

    def skill_roots(self, cwd: str) -> list[dict]:
        """Editable skill-search roots for this engine, highest-priority first.

        Each entry is ``{"scope": str, "dir": Path}`` for a directory holding
        folder-form skills (``<name>/SKILL.md`` — the open Agent Skills format
        every engine shares). The generic skills route walks them in order; the
        first entry for a given scope is also where a new skill of that scope is
        created. An engine may list several dirs under one scope (e.g. a
        preferred location plus a legacy one). Empty → no skills for this engine.
        """
        return []

    def plugin_skill_dirs(self) -> list[dict]:
        """Read-only plugin-provided skill roots: ``[{"label": str, "dir": Path}]``.

        Each ``dir`` holds folder-form skills like `skill_roots`, sourced from
        this engine's installed plugins/marketplaces (so the provider owns the
        marketplace layout). Empty → no plugin skills surfaced.
        """
        return []

    def agent_roots(self, cwd: str) -> list[dict]:
        """Agent-definition search roots for the agents browser, highest-priority
        first. Each entry is ``{"scope": str, "dir": Path, "fmt": str,
        "writable": bool}``.

        ``fmt`` selects the parser: ``"markdown"`` (Claude's flat ``<name>.md``
        with YAML frontmatter) or ``"toml"`` (Codex's ``<name>.toml``). The route
        normalizes both into the same ``{frontmatter, body}`` the widget renders.
        ``writable=False`` makes the browser show those agents read-only (no
        create/edit/delete). Empty → no agents for this engine.
        """
        return []

    def plugin_backend(self) -> Optional["PluginBackend"]:
        """How to drive this engine's plugin-manager CLI, or None if it has no
        plugin system. The plugins route uses this instead of assuming Claude."""
        return None

    def describe(self) -> dict:
        """Serialize provider metadata (capabilities, availability, accounts)."""
        from dataclasses import asdict
        available, reason = self.is_available()
        return {
            "name": self.name,
            "display_name": self.display_name,
            "description": self.description,
            "default_enabled": self.default_enabled,
            "capabilities": asdict(self.capabilities),
            "available": available,
            "unavailable_reason": reason,
            "accounts": self.accounts(),
            "models": self.enabled_models(),
            "models_editable": self.models_editable,
            "models_key": self.models_key or self.name,
            "path_configurable": bool(self.path_config_key),
            "default_binary": self.default_binary,
            "efforts": self.effort_levels(),
            "permission_modes": self.permission_modes(),
            "default_permission_mode": self.default_permission_mode(),
            "cli_resume_template": self.cli_resume_template,
        }
