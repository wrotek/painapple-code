"""Claude provider — declarative surface + customization roots.

What the Claude adapter *declares about itself*: binary location, accounts,
models, effort/permission vocabularies, context fetch, and where its
skills/agents/plugins live. The `ClaudeProvider` combiner in this package's
``__init__`` mixes this in.
"""

from __future__ import annotations

import json
from typing import Optional

from painapple_code.providers.base import PluginBackend
from painapple_code.utils.agent_cli import get_claude_binary, fetch_context_tokens


class _CapabilitiesMixin:
    """Provider self-description: binary, accounts, vocabularies, roots, context."""

    # --- binary -----------------------------------------------------------

    # Settings "CLI path" row + generic engine-path endpoint (shared by both
    # Claude drivers — same binary). The app also owns this engine's model
    # catalog (models.yaml), so Settings renders it editable; per-model
    # show/hide prefs are namespaced under the shared "claude" key so both
    # drivers see the same curation.
    path_config_key = "claude_path"
    default_binary = "claude"
    # "Continue in CLI" quick action → `claude -r <session-id>`.
    cli_resume_template = "claude -r {id}"
    models_editable = True
    models_key = "claude"
    # `claude auth status --json` → {loggedIn, authMethod, email,
    # subscriptionType}; the interactive login flow prints an OAuth URL +
    # paste-back code, which works fine inside a PTY terminal tab.
    auth_status_args = ["auth", "status", "--json"]
    auth_login_args = ["auth", "login"]

    def binary(self) -> str:
        return get_claude_binary()

    def binary_not_found_hint(self) -> str:
        return ("Make sure the Claude Code CLI is installed and 'claude' is on "
                "the server's PATH, or set the full path in Settings → Providers. "
                "Install with: curl -fsSL https://claude.ai/install.sh | bash")

    def summary_model_editable(self) -> bool:
        # Claude's journal model lives in models.yaml (`summary_model`), not
        # a global-config key — override storage, keep the knob.
        return True

    def get_summary_model_override(self) -> Optional[str]:
        from painapple_code.paths import get_summary_model
        return get_summary_model()

    def set_summary_model_override(self, value: Optional[str]) -> None:
        # Empty resets to the shipped default — Claude's journal fork always
        # needs a concrete model (`--model` is mandatory on the fork argv).
        from painapple_code import paths
        cleaned = (value or "").strip() or (
            paths.get_default_models_config().get("summary_model")
            or "claude-haiku-4-5")
        paths.save_models_config({
            "selectable": paths.get_selectable_models(),
            "summary_model": cleaned,
        })

    def parse_auth_status(self, returncode: int, stdout: str, stderr: str) -> dict:
        """Structured status: surface who's logged in and on which plan."""
        try:
            data = json.loads(stdout or "")
        except (ValueError, TypeError):
            data = None
        if not isinstance(data, dict) or "loggedIn" not in data:
            return super().parse_auth_status(returncode, stdout, stderr)
        if not data.get("loggedIn"):
            return {"logged_in": False, "detail": ""}
        bits = [str(b) for b in (data.get("email"), data.get("subscriptionType")) if b]
        return {"logged_in": True, "detail": " · ".join(bits)}

    # --- accounts / models / effort / permissions -------------------------

    def accounts(self) -> list[dict]:
        """Claude accounts == token profiles (`CLAUDE_CODE_OAUTH_TOKEN`).

        Empty id = the ambient login / global-default token. Each named profile
        is a file under ~/.config/painapple-code/tokens/.
        """
        from painapple_code.utils.token_profiles import list_profiles
        accounts = [{"id": "", "label": "Default"}]
        accounts += [{"id": p["name"], "label": p["name"]} for p in list_profiles()]
        return accounts

    def models(self) -> list[dict]:
        from painapple_code.paths import get_selectable_models
        return get_selectable_models()

    def effort_levels(self) -> list[str]:
        # The Claude CLI's full --effort scale.
        return ["low", "medium", "high", "xhigh", "max"]

    def permission_modes(self) -> list[dict]:
        # Claude's native permission modes, in display order — fully self-described
        # here (value/label/desc/color), exactly like every other provider. No
        # Claude permission vocabulary lives anywhere else (strings.yaml, a
        # constant, the frontend); the engine picker and chip read this list.
        return [
            {"value": "plan", "label": "Plan",
             "desc": "Read-only, explore & design", "color": "#8b5cf6"},
            {"value": "dontAsk", "label": "Don't Ask",
             "desc": "Auto-deny unless in allow rules", "color": "#facc15"},
            {"value": "acceptEdits", "label": "Accept Edits",
             "desc": "Auto-approve edits in workspace; deny others", "color": "#fb923c"},
            {"value": "auto", "label": "Auto",
             "desc": "AI classifier reviews each tool call", "color": "#60a5fa"},
            {"value": "bypassPermissions", "label": "YOLO",
             "desc": "Skip all permission checks", "color": "#4ade80"},
        ]

    def default_permission_mode(self) -> str:
        return "dontAsk"

    # --- context metering -------------------------------------------------

    async def fetch_context(
        self,
        cwd: str,
        session_id: Optional[str] = None,
        token_profile: Optional[str] = None,
        model: Optional[str] = None,
    ) -> Optional[dict]:
        return await fetch_context_tokens(
            cwd,
            provider_session_id=session_id,
            token_profile=token_profile,
            model=model,
        )

    # --- customization roots (skills / agents / plugins) ------------------

    def skill_roots(self, cwd: str) -> list[dict]:
        from pathlib import Path
        return [
            {"scope": "project", "dir": Path(cwd) / ".claude" / "skills"},
            {"scope": "personal", "dir": Path.home() / ".claude" / "skills"},
        ]

    def agent_roots(self, cwd: str) -> list[dict]:
        from pathlib import Path
        return [
            {"scope": "project", "dir": Path(cwd) / ".claude" / "agents",
             "fmt": "markdown", "writable": True},
            {"scope": "personal", "dir": Path.home() / ".claude" / "agents",
             "fmt": "markdown", "writable": True},
        ]

    def plugin_backend(self) -> PluginBackend:
        from pathlib import Path
        return PluginBackend(
            binary=self.binary(),
            list_installed_args=["plugins", "list", "--json"],
            list_all_args=["plugins", "list", "--available", "--json"],
            install_verb=["plugins", "install"],
            uninstall_verb=["plugins", "uninstall"],
            enable_verb=["plugins", "enable"],
            disable_verb=["plugins", "disable"],
            marketplace_root=Path.home() / ".claude" / "plugins" / "marketplaces",
        )

    def plugin_skill_dirs(self) -> list[dict]:
        """Skill roots from installed Claude plugins (read-only).

        Claude Code caches every known marketplace under
        ``~/.claude/plugins/marketplaces/`` but only a subset is installed;
        ``installed_plugins.json`` is the authoritative list (keyed
        ``<plugin>@<marketplace>``). We surface only installed plugins' skills.
        """
        from pathlib import Path
        home = Path.home()
        plugins_root = home / ".claude" / "plugins" / "marketplaces"
        if not plugins_root.is_dir():
            return []
        installed = _load_installed_plugin_keys()
        out: list[dict] = []
        for marketplace in sorted(plugins_root.iterdir()):
            plugins_dir = marketplace / "plugins"
            if not plugins_dir.is_dir():
                continue
            for plugin in sorted(plugins_dir.iterdir()):
                if f"{plugin.name}@{marketplace.name}" not in installed:
                    continue
                skills_root = plugin / "skills"
                if skills_root.is_dir():
                    out.append({
                        "label": f"{plugin.name} ({marketplace.name})",
                        "dir": skills_root,
                    })
        return out


def _load_installed_plugin_keys() -> set:
    """`{plugin@marketplace}` keys from ``~/.claude/plugins/installed_plugins.json``.

    Empty set if missing/malformed (treat as "nothing installed" rather than
    "show everything", so the picker reflects the user's /plugin install state).
    """
    from pathlib import Path
    path = Path.home() / ".claude" / "plugins" / "installed_plugins.json"
    try:
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return set()
    plugins = data.get("plugins")
    if not isinstance(plugins, dict):
        return set()
    return set(plugins.keys())
