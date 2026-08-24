"""Codex provider — declarative surface + customization roots.

What the Codex adapter *declares about itself*: binary location, availability,
effort/permission vocabularies, and where its skills/agents/plugins live. The
`CodexProvider` combiner in this package's ``__init__`` mixes this in. Kept
separate from launch/translate so the provider's static description reads in one
place.
"""

from __future__ import annotations

import os
from typing import Optional

from painapple_code import paths
from painapple_code.providers.base import PluginBackend

# Context-window size used to meter the context bar. `codex exec --json` reports
# per-turn token usage but — unlike the TUI / app-server protocol — emits NO
# window size and has no `/context` command, so we supply it. The gpt-5-codex
# family is metered by Codex against a 272K-token *input* window (the input split
# of the 400K product window; Codex then applies a ~95% effective cap on top —
# see openai/codex#19319, #19409). The app doesn't manage which Codex model is
# active (models() is empty — it's chosen by `codex login` / config.toml), so we
# meter against this family default rather than a per-model lookup. When a real
# Codex model catalog with per-model windows is registered, context_from_result
# can switch to a model-keyed size with no other change.
_DEFAULT_CONTEXT_WINDOW = 272_000

# Canonical ReasoningEffort ordering — used to order the union vocabulary and
# to clamp a requested level down to the nearest one a model supports. The
# per-model truth is the CLI's own models_cache (supported_reasoning_levels).
_EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
# Pre-cache fallback (codex installed but never run): the classic triad every
# codex model speaks.
_FALLBACK_EFFORTS = ["low", "medium", "high"]


class _CapabilitiesMixin:
    """Provider self-description: binary, availability, vocabularies, roots."""

    # --- binary / availability -------------------------------------------

    # Settings "CLI path" row + generic engine-path endpoint (shared by both
    # Codex drivers — same binary). Model definitions stay read-only in
    # Settings — the Codex CLI owns them (models_cache.json) — but per-model
    # show/hide toggles apply, namespaced under the shared "codex" key so
    # both drivers see the same curation.
    path_config_key = "codex_path"
    default_binary = "codex"
    # "Continue in CLI" quick action → `codex exec resume <thread-id>` (both
    # Codex drivers resume the same rollout by thread id; codex_app_server
    # inherits this mixin).
    cli_resume_template = "codex exec resume {id}"
    models_key = "codex"
    # `codex login status` exits 0/1 with a one-line status (base parser
    # handles it — note codex prints to stderr). Login uses the device-code
    # flow: plain `codex login` binds a localhost callback on the SERVER,
    # which a remote client can never reach; --device-auth prints a URL +
    # code that work from any device. (Caution: starting either flow drops
    # the existing auth.json before the new login completes.)
    auth_status_args = ["login", "status"]
    auth_login_args = ["login", "--device-auth"]
    # Auto-journal: both Codex drivers self-summarize on the Codex side and
    # share the optional cheaper-summarizer override; empty = the summary
    # fork inherits the session thread's model.
    summary_model_config_key = "codex_summary_model"
    summary_model_placeholder = "session model"

    def parse_auth_status(self, returncode: int, stdout: str, stderr: str) -> dict:
        parsed = super().parse_auth_status(returncode, stdout, stderr)
        if not parsed.get("logged_in"):
            # Codex's logged-out line is literally "Not logged in" — the UI
            # already says that; an echoed detail would just duplicate it.
            parsed["detail"] = ""
        return parsed

    def binary(self) -> str:
        return paths.load_global_config().get(
            self.path_config_key, self.default_binary)

    def is_available(self) -> tuple[bool, Optional[str]]:
        """Codex needs both the CLI on PATH and an authenticated `codex login`.

        Auth lives in `$CODEX_HOME/auth.json` (or `~/.codex/`); an API key in the
        environment also works. We only block when there's *no* sign of setup —
        a present config dir is treated as good enough so we don't false-negative.
        """
        ok, reason = super().is_available()
        if not ok:
            return False, "Codex CLI not installed — `npm i -g @openai/codex`"
        from pathlib import Path
        codex_home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
        authed = (
            (codex_home / "auth.json").exists()
            or (codex_home / "config.toml").exists()
            or codex_home.is_dir()
            or bool(os.environ.get("CODEX_API_KEY") or os.environ.get("OPENAI_API_KEY"))
        )
        if not authed:
            return False, "Codex not signed in — run `codex login`"
        return True, None

    def _listed_models_cache(self) -> list[dict]:
        """Raw ``visibility=list`` entries from the CLI's models cache,
        priority-sorted. Shared source for models() / effort_levels() /
        effort_for_model(). Missing/malformed cache → empty list."""
        import json
        from pathlib import Path
        codex_home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
        try:
            with (codex_home / "models_cache.json").open(encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            return []
        entries = data.get("models") if isinstance(data, dict) else None
        if not isinstance(entries, list):
            return []
        listed = [
            m for m in entries
            if isinstance(m, dict) and m.get("visibility") == "list" and m.get("slug")
        ]
        listed.sort(key=lambda m: m.get("priority") or 0)
        return listed

    @staticmethod
    def _model_efforts(entry: dict) -> list[str]:
        """One cache entry's ``supported_reasoning_levels`` → effort names."""
        out: list[str] = []
        for lvl in entry.get("supported_reasoning_levels") or []:
            effort = lvl.get("effort") if isinstance(lvl, dict) else None
            if isinstance(effort, str) and effort:
                out.append(effort)
        return out

    def models(self) -> list[dict]:
        """Codex's own model catalog, read from the CLI's cache.

        The Codex CLI maintains ``$CODEX_HOME/models_cache.json`` (refreshed
        from the backend's model registry on every run): slug, display name,
        description, visibility, priority and supported reasoning levels per
        model. Surfacing that file — rather than a hardcoded list — keeps the
        picker in lockstep with whatever this Codex install actually offers.
        Missing/malformed cache (codex installed but never run) → empty
        catalog, and the UI shows only the engine-default option.

        The launch paths guard on this: exec passes ``-m`` only for ids listed
        here; the app-server forwards any non-Claude id (so an explicit pick
        still works even while the cache is absent). With a catalog present the
        app OWNS the default — `paths.engine_default_model` resolves the
        top (priority-first) listed model and the launch forwards it, so a
        fresh session runs a concrete model rather than deferring to the CLI's
        own config. Only an ABSENT catalog (no cache) falls back to
        `codex login` / config.toml (and the picker/chip hide entirely).

        Each entry carries ``efforts`` — the model's OWN reasoning-effort
        range — so pickers can narrow the engine-level union to the selected
        model (launch clamps to the same list via effort_for_model).
        """
        return [
            {
                "id": m["slug"],
                "label": m.get("display_name") or m["slug"],
                "desc": m.get("description") or "",
                "efforts": [
                    lvl for lvl in _EFFORT_ORDER
                    if lvl in self._model_efforts(m)
                ],
            }
            for m in self._listed_models_cache()
        ]

    # --- effort / permissions --------------------------------------------

    def effort_levels(self) -> list[str]:
        """Codex's effort vocabulary, read from the CLI's own model registry.

        ``models_cache.json`` self-describes ``supported_reasoning_levels``
        per model (the 5.6 family reaches xhigh/max/ultra; older models stop
        at xhigh). The engine-level vocabulary is the ordered union across
        the listed catalog — the offering is wide, and ``effort_for_model``
        clamps at launch to what the *target* model actually supports.
        Missing cache → the classic triad every codex model speaks.
        """
        union: set = set()
        for entry in self._listed_models_cache():
            union.update(self._model_efforts(entry))
        ordered = [lvl for lvl in _EFFORT_ORDER if lvl in union]
        return ordered or list(_FALLBACK_EFFORTS)

    def effort_for_model(self, effort: Optional[str], model: Optional[str]) -> Optional[str]:
        """Clamp a requested reasoning effort to the target model's own range.

        The wire value must be one the model actually supports — the CLI's
        registry is authoritative, and an out-of-range value risks a rejected
        turn. Known model → its ``supported_reasoning_levels``; unknown or
        default model → the intersection every listed model speaks (still
        cache-driven); no cache → the classic triad. A level above the range
        clamps down to the highest supported one (``ultra`` → ``max`` on a
        model that stops there; legacy Claude ``max`` → ``xhigh`` where that's
        the top); one below clamps up to the lowest. Returns None when no
        effort was requested (or the value is garbage) — codex then runs its
        own default.
        """
        if not effort or effort not in _EFFORT_ORDER:
            return None
        entries = self._listed_models_cache()
        supported: list[str] = []
        if entries:
            if model:
                entry = next((m for m in entries if m.get("slug") == model), None)
                if entry:
                    supported = [
                        lvl for lvl in _EFFORT_ORDER
                        if lvl in self._model_efforts(entry)
                    ]
            if not supported:
                sets = [s for s in (set(self._model_efforts(m)) for m in entries) if s]
                common = set.intersection(*sets) if sets else set()
                supported = [lvl for lvl in _EFFORT_ORDER if lvl in common]
        if not supported:
            supported = list(_FALLBACK_EFFORTS)
        if effort in supported:
            return effort
        idx = _EFFORT_ORDER.index(effort)
        below = [lvl for lvl in supported if _EFFORT_ORDER.index(lvl) <= idx]
        return below[-1] if below else supported[0]

    def permission_modes(self) -> list[dict]:
        # Codex's OWN native sandbox vocabulary — the provider owns this list and
        # the session stores these values directly (no Claude-vocabulary
        # indirection). `color` lets the UI render each tier without knowing
        # Codex's scheme. _SANDBOX_BY_MODE (launch.py) passes them to `--sandbox`.
        return [
            {"value": "read-only", "label": "Read-only",
             "desc": "Sandboxed — no file writes", "color": "#8b5cf6"},
            {"value": "workspace-write", "label": "Workspace write",
             "desc": "Edit files in the workspace", "color": "#fb923c"},
            {"value": "danger-full-access", "label": "Full access",
             "desc": "No sandbox — full disk & network", "color": "#f87171"},
        ]

    def default_permission_mode(self) -> str:
        # A fresh Codex session should be able to do work but stay sandboxed —
        # not inherit Claude's global default (e.g. 'dontAsk' → read-only).
        return "workspace-write"

    # --- customization roots (skills / plugins / agents) ------------------

    def skill_roots(self, cwd: str) -> list[dict]:
        # Codex uses the same folder-form SKILL.md format as Claude, only the
        # locations differ. `.agents/skills` is the preferred cross-agent
        # convention; `.codex/skills` is the still-supported repo layout; the
        # CODEX_HOME location is deprecated-but-supported for the user scope.
        # Listed highest-priority first — the first project/personal entry is
        # also where a new skill of that scope is created.
        from pathlib import Path
        home = Path.home()
        codex_home = Path(os.environ.get("CODEX_HOME") or home / ".codex")
        return [
            {"scope": "project", "dir": Path(cwd) / ".agents" / "skills"},
            {"scope": "project", "dir": Path(cwd) / ".codex" / "skills"},
            {"scope": "personal", "dir": home / ".agents" / "skills"},
            {"scope": "personal", "dir": codex_home / "skills"},
        ]

    def plugin_backend(self) -> PluginBackend:
        # `codex plugin list --json` → {installed, available} (same shape as
        # Claude); `codex plugin add/remove` install/uninstall. Codex has no
        # enable/disable (the UI hides the toggle). Inventory is skipped: Codex
        # caches plugins under an unstable ~/.codex/.tmp snapshot dir, and bundles
        # components differently — not worth walking here.
        return PluginBackend(
            binary=self.binary(),
            list_installed_args=["plugin", "list", "--json"],
            list_all_args=["plugin", "list", "--json"],
            install_verb=["plugin", "add"],
            uninstall_verb=["plugin", "remove"],
            enable_verb=None,
            disable_verb=None,
            marketplace_root=None,
        )

    def agent_roots(self, cwd: str) -> list[dict]:
        # Codex agents are TOML (`<name>.toml`): project `.codex/agents`, user
        # `~/.codex/agents` (or $CODEX_HOME/agents). Read-only in the browser for
        # now — the schema (developer_instructions / model_reasoning_effort /
        # sandbox_mode) and TOML round-trip differ from Claude's markdown agents;
        # editing is a separate follow-up. (Built-in roles default/worker/explorer
        # have no file and aren't listed, mirroring Claude's built-in subagents.)
        from pathlib import Path
        home = Path.home()
        codex_home = Path(os.environ.get("CODEX_HOME") or home / ".codex")
        return [
            {"scope": "project", "dir": Path(cwd) / ".codex" / "agents",
             "fmt": "toml", "writable": False},
            {"scope": "personal", "dir": codex_home / "agents",
             "fmt": "toml", "writable": False},
        ]

    # --- context metering -------------------------------------------------

    def context_from_result(self, result_msg: dict, model: Optional[str] = None) -> Optional[dict]:
        # Codex has no /context command, but turn.completed.usage.input_tokens is
        # the full conversation context fed to the model that turn — i.e. the live
        # window occupancy, which is exactly what Codex's own TUI meters. The
        # canonical result (built by _result_from_usage) carries it as
        # usage.input_tokens; cached tokens are a *subset* of that, so we don't add
        # them. No per-section breakdown exists in exec mode.
        usage = (result_msg or {}).get("usage") or {}
        in_tok = usage.get("input_tokens") or 0
        if not in_tok:
            return None
        window = _DEFAULT_CONTEXT_WINDOW
        return {
            "contextTokens": in_tok,
            "contextWindow": window,
            "percentage": round(in_tok / window * 100, 1) if window else None,
            "breakdown": None,
            "memoryFiles": None,
        }
