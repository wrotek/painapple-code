"""Codex app-server provider — launch argv + JSON-RPC param shaping.

`build_command` is trivial (`codex app-server --stdio`); the interesting part is
turning resolved `LaunchOptions` + a canonical user message into the
`thread/start` / `turn/start` JSON-RPC params. That shaping lives here (the
provider owns everything CLI-shaped) so the transport driver stays pure plumbing
— it just calls `provider.thread_start_params(...)` etc. Mixed into
`CodexAppServerProvider`.
"""

from __future__ import annotations

from typing import Optional

from painapple_code import paths
from painapple_code.providers.base import LaunchOptions

# Effort → `turn/start.effort` (ReasoningEffort) goes through capabilities'
# effort_for_model(): the CLI's own models_cache declares each model's
# supported reasoning levels, and the requested level is clamped to the
# TARGET model's range — mirroring codex exec (unknown/default model → the
# range every listed model speaks; no cache → the low/medium/high triad).

# Permission value → app-server `SandboxMode` (thread/start.sandbox). The
# app-server's native vocabulary is identical to codex exec's, so new sessions
# (which store the native value) map to themselves; the Claude-vocabulary rows
# are a back-compat shim for sessions created before native modes existed.
_SANDBOX_BY_MODE = {
    # Codex-native (identity)
    "read-only": "read-only",
    "workspace-write": "workspace-write",
    "danger-full-access": "danger-full-access",
    # Legacy Claude-vocabulary (pre-native sessions)
    "plan": "read-only",
    "dontAsk": "read-only",
    "acceptEdits": "workspace-write",
    "auto": "workspace-write",
    "bypassPermissions": "danger-full-access",
}
_DEFAULT_SANDBOX = "workspace-write"


class _LaunchMixin:
    """Builds the app-server launch argv and the JSON-RPC turn/thread params."""

    def frame_input(self, message: dict) -> dict:
        # Never called: turns go over the JSON-RPC transport (`send_turn`), not
        # the stdin line path. Raise so a mis-wired send fails loudly.
        raise NotImplementedError(
            "codex app-server turns ride the JSON-RPC transport, not stdin lines")

    def build_command(self, opts: LaunchOptions) -> list[str]:
        # Persistent JSON-RPC process over stdio. Model/effort/sandbox are NOT
        # argv here — they ride on the thread/start + turn/start params below.
        return [self.binary(), "app-server", "--stdio"]

    # --- JSON-RPC param shaping (called by the transport) -----------------

    def thread_start_params(self, opts: LaunchOptions, cwd: str) -> dict:
        """Params for a fresh `thread/start`.

        P1 sets `approvalPolicy="never"`: the sandbox alone governs what
        model-generated commands may do, exactly like `codex exec` (which runs
        approvals-off). Interactive approvals are a later phase.
        """
        params: dict = {
            "cwd": cwd,
            "sandbox": _SANDBOX_BY_MODE.get(opts.permission_mode or "", _DEFAULT_SANDBOX),
            "approvalPolicy": "never",
        }
        model = self._wire_model(opts.model)
        if model:
            params["model"] = model
        return params

    def thread_resume_params(self, opts: LaunchOptions, thread_id: str, cwd: str) -> dict:
        """Params for `thread/resume` (continue an existing thread by id)."""
        params: dict = {"threadId": thread_id, "cwd": cwd}
        model = self._wire_model(opts.model)
        if model:
            params["model"] = model
        return params

    def thread_fork_params(self, opts: LaunchOptions, fork_from_id: str, cwd: str) -> dict:
        """Params for `thread/fork` — branch a source thread into a fresh one.

        The native equivalent of Claude's `--resume <id> --fork-session`: the
        app-server loads the source thread from disk and forks it into a new
        *persisted* thread (no rollout-file copy). Deliberately not `ephemeral`
        — the fork becomes the new session's thread, captured from the
        response and resumed on subsequent turns. Sandbox/approval/model mirror
        `thread_start_params` so the branch inherits the session's resolved
        settings. `sandbox` and `permissions` are mutually exclusive in the
        schema; we use `sandbox` (our native vocabulary), so `permissions` is
        omitted.
        """
        params: dict = {
            "threadId": fork_from_id,
            "cwd": cwd,
            "sandbox": _SANDBOX_BY_MODE.get(opts.permission_mode or "", _DEFAULT_SANDBOX),
            "approvalPolicy": "never",
        }
        model = self._wire_model(opts.model)
        if model:
            params["model"] = model
        return params

    def turn_start_params(self, opts: LaunchOptions, thread_id: str, input_items: list) -> dict:
        """Params for `turn/start` — the per-turn input plus effort/model."""
        # `summary` opts in to reasoning summaries — WITHOUT it the app-server
        # emits reasoning items with empty summary/content arrays (thinking
        # blocks would render blank). "auto" lets the backend pick the format,
        # matching the codex TUI's own default.
        params: dict = {"threadId": thread_id, "input": input_items,
                        "summary": "auto"}
        model = self._wire_model(opts.model)
        if opts.effort:
            # Clamp to the range the model that will actually run supports
            # (forwarded pick, else the conservative default-model range).
            mapped = self.effort_for_model(opts.effort, model)
            if mapped:
                params["effort"] = mapped
        if model:
            params["model"] = model
        return params

    def build_turn_input(self, message: dict) -> list[dict]:
        """Canonical user message → app-server `UserInput[]`.

        The canonical shape (built in ws_chat) is
        ``{"type":"user","message":{"role":"user","content": str | [blocks]}}``.
        Text becomes a ``text`` input; base64 image blocks are materialized to
        temp files and passed as ``localImage`` inputs.
        """
        content = (message or {}).get("message", {}).get("content", "")
        items: list[dict] = []
        if isinstance(content, str):
            if content:
                items.append({"type": "text", "text": content})
            return items
        if isinstance(content, list):
            image_sources = []
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and block.get("text"):
                    items.append({"type": "text", "text": block["text"]})
                elif block.get("type") == "image":
                    image_sources.append(block)
            for path in self._materialize_images(image_sources):
                items.append({"type": "localImage", "path": path})
        return items

    @staticmethod
    def _wire_model(model: Optional[str]) -> Optional[str]:
        """Only forward a model the app-server would accept.

        The session model hierarchy defaults to a *Claude* id (which Codex would
        reject); never forward that — let the app-server use the model configured
        by `codex login` / config.toml. A non-Claude id is passed through.
        """
        if model and not model.startswith("claude"):
            return model
        return None

    @staticmethod
    def _materialize_images(images: Optional[list]) -> list[str]:
        """Decode base64 image blocks to temp files; return their paths."""
        if not images:
            return []
        import base64
        import tempfile
        import uuid
        out_dir = paths.DATA_HOME / "tmp" / "codex-images"
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            out_dir = None
        paths: list[str] = []
        for img in images:
            source = img.get("source", {}) if isinstance(img, dict) else {}
            if source.get("type") != "base64" or not source.get("data"):
                continue
            media_type = source.get("media_type", "image/png")
            ext = "jpg" if "jpeg" in media_type else media_type.split("/")[-1]
            name = f"img_{uuid.uuid4().hex[:10]}.{ext}"
            try:
                data = base64.b64decode(source["data"])
                if out_dir is not None:
                    p = out_dir / name
                    p.write_bytes(data)
                else:
                    fd = tempfile.NamedTemporaryFile(
                        prefix="codex_img_", suffix=f".{ext}", delete=False
                    )
                    fd.write(data)
                    fd.close()
                    p = fd.name
                paths.append(str(p))
            except (OSError, ValueError):
                continue
        return paths
