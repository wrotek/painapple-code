"""Codex provider — command building and image materialization.

Turns a `LaunchOptions` into the `codex exec [resume <id>] --json …` argv,
including the effort→`model_reasoning_effort` and permission→`--sandbox`
mappings. Mixed into `CodexProvider`.
"""

from __future__ import annotations

from typing import Optional

from painapple_code import paths
from painapple_code.providers.base import LaunchOptions

# Effort → `model_reasoning_effort` goes through capabilities'
# effort_for_model(): the CLI's own models_cache declares each model's
# supported reasoning levels, and the requested level is clamped to the
# TARGET model's range (unknown/default model → the range every listed
# model speaks; no cache → the classic low/medium/high triad).

# Permission value → codex `--sandbox` policy. `codex exec` has no approval flag
# (it runs non-interactively with approvals off); the sandbox policy alone
# governs what model-generated commands may do. read-only blocks all writes;
# workspace-write allows in-workspace edits; danger-full-access removes the
# sandbox entirely.
#
# New sessions store Codex's OWN native vocabulary (see permission_modes), so
# those map to themselves. The Claude-vocabulary rows are a back-compat shim for
# sessions created before Codex registered native modes — provider is frozen
# after the first turn, so such a session keeps its stored canonical value.
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
# An unrecognised / unset mode: let the agent do work but stay sandboxed.
_DEFAULT_SANDBOX = "workspace-write"


class _LaunchMixin:
    """Builds the per-turn `codex exec` command line."""

    def frame_input(self, message: dict) -> dict:
        # Never called: `codex exec` is ephemeral (persistent_process=False) —
        # the turn's prompt rides in argv via LaunchOptions.prompt, so nothing
        # is ever framed for stdin. Raise so a mis-wired send fails loudly.
        raise NotImplementedError(
            "codex exec embeds the prompt in argv; it has no stdin protocol")

    def build_command(self, opts: LaunchOptions) -> list[str]:
        cmd = [self.binary(), "exec"]

        # Resume an existing thread, else start a fresh one.
        if opts.session_id:
            cmd += ["resume", opts.session_id]

        cmd += ["--json", "--skip-git-repo-check"]

        # Pass `-m` only for a model THIS engine actually offers; otherwise let
        # Codex use its configured default (from `codex login` /
        # ~/.codex/config.toml). The session's model hierarchy defaults to a
        # *Claude* id, which isn't in Codex's catalog, so it's never forwarded —
        # and when a real Codex catalog is registered, `-m` starts working with
        # no change here.
        forwarded_model = None
        if opts.model and any(m.get("id") == opts.model for m in self.models()):
            forwarded_model = opts.model
            cmd += ["-m", opts.model]

        if opts.effort:
            # Clamp to what the model that will actually run supports (the
            # configured default when no -m is forwarded → conservative range).
            mapped = self.effort_for_model(opts.effort, forwarded_model)
            if mapped:
                # The config key is `model_reasoning_effort` — a bare
                # `reasoning_effort` override is silently ignored by Codex.
                cmd += ["-c", f"model_reasoning_effort={mapped}"]

        # Sandbox policy. The top-level `codex exec` takes `-s <mode>`, but the
        # `resume` subcommand has no `-s` flag — there the policy is a config
        # override (`-c sandbox_mode=...`, parsed as TOML / raw string).
        sandbox = _SANDBOX_BY_MODE.get(opts.permission_mode or "", _DEFAULT_SANDBOX)
        if opts.session_id:
            cmd += ["-c", f'sandbox_mode="{sandbox}"']
        else:
            cmd += ["-s", sandbox]

        # Images: write base64 uploads to temp files and pass their paths.
        image_paths = self._materialize_images(opts.images)
        if image_paths:
            cmd += ["-i", ",".join(image_paths)]

        # Prompt is the final positional argument. Empty string is valid
        # (e.g. an API-retry "continue" turn with no new text).
        cmd.append(opts.prompt or "")

        return cmd

    @staticmethod
    def _materialize_images(images: Optional[list]) -> list[str]:
        """Decode base64 upload objects to temp files; return their paths."""
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
                else:  # fall back to the system temp dir
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
