"""Codex provider — the rich-commit summary fork.

`codex exec resume` continues a thread *in place*, so summarizing the turn by
resuming the user's real thread would pollute their conversation. This mixin
copies the thread's rollout under a fresh id and resumes the copy — the
equivalent of Claude's `--fork-session` — then reads the structured JSON back.
Mixed into `CodexProvider`.
"""

from __future__ import annotations

import json
import os
from typing import Optional

from painapple_code import paths
from painapple_code.providers.base import SummaryForkPlan


class _SummaryMixin:
    """Branch off the real thread and summarize the turn with Codex itself."""

    def build_summary_fork(
        self,
        *,
        session_id: str,
        fork_prompt: str,
        schema_json: str,
        cwd: str,
        token_profile: Optional[str] = None,
        session_model: Optional[str] = None,
    ) -> Optional[SummaryForkPlan]:
        """Summarize the turn with Codex itself, branching off the real thread.

        `codex exec resume` continues a thread *in place* (and `--ephemeral`
        doesn't prevent that on resume), so resuming the user's thread would
        append every summary turn into their conversation. Instead we copy the
        thread's rollout under a fresh id and resume the copy — the equivalent of
        Claude's `--fork-session`. `--output-schema` forces the structured shape
        (strict mode: every property required) and `-o` writes the final JSON to
        a temp file. Returns None if the rollout can't be located, in which case
        the turn still gets a basic shadow commit without AI sections.
        """
        import tempfile

        fork = self._fork_rollout(session_id)
        if fork is None:
            return None
        fork_id, copy_path = fork

        schema_fd, schema_path = tempfile.mkstemp(prefix="codex_schema_", suffix=".json")
        with os.fdopen(schema_fd, "w", encoding="utf-8") as f:
            f.write(self._strictify_schema(schema_json))
        out_fd, out_path = tempfile.mkstemp(prefix="codex_summary_", suffix=".json")
        os.close(out_fd)

        # `resume` has no -s flag; sandbox is a config override. read-only keeps
        # the summarizer from touching the workspace.
        argv = [
            self.binary(), "exec", "resume", fork_id,
            "--json", "--skip-git-repo-check",
            "-c", 'sandbox_mode="read-only"',
            "--output-schema", schema_path,
            "-o", out_path,
        ]
        # Optional cheaper summarizer model (seam-described override);
        # default inherits the thread's model.
        summary_model = self.get_summary_model_override()
        if summary_model and not summary_model.startswith("claude"):
            argv += ["-m", summary_model]
        argv.append(fork_prompt)

        return SummaryForkPlan(
            argv=argv,
            env=None,                       # codex uses ambient auth (codex login / CODEX_API_KEY)
            model=summary_model or "codex",
            output_file=out_path,
            cleanup_paths=[copy_path, schema_path, out_path],
        )

    def parse_summary_fork(
        self,
        *,
        plan: SummaryForkPlan,
        returncode: int,
        stdout: bytes,
        stderr: bytes,
    ) -> tuple[Optional[dict], Optional[dict]]:
        """Read the structured JSON from `-o` (fallback: last agent_message)."""
        if returncode != 0:
            return None, None
        structured = None
        if plan.output_file:
            try:
                text = open(plan.output_file, encoding="utf-8").read().strip()
                if text:
                    structured = json.loads(text)
            except (OSError, json.JSONDecodeError):
                structured = None
        if not isinstance(structured, dict):
            structured = self._structured_from_stream(stdout)
        if not isinstance(structured, dict):
            return None, None
        usage = self._usage_from_stream(stdout)
        cost = {
            "cost": 0.0,                    # Codex reports no USD cost
            "input_tokens": usage.get("input_tokens", 0) or 0,
            "output_tokens": usage.get("output_tokens", 0) or 0,
        }
        return structured, cost

    # --- summary-fork helpers ---------------------------------------------

    @staticmethod
    def _codex_sessions_dir():
        """Codex rollout dir (`$CODEX_HOME/sessions` or `~/.codex/sessions`)."""
        from pathlib import Path
        codex_home = os.environ.get("CODEX_HOME")
        base = Path(codex_home) if codex_home else Path.home() / ".codex"
        d = base / "sessions"
        return d if d.is_dir() else None

    def _fork_rollout(self, session_id: str) -> Optional[tuple[str, str]]:
        """Copy a thread's rollout under a fresh id. Returns (new_id, copy_path).

        Codex stores each thread as `sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
        with the uuid in both the filename and the line-1 `session_meta.id`.
        Rewriting that uuid makes a resume-by-id land on the copy, leaving the
        original byte-for-byte untouched.
        """
        import uuid

        sessions_dir = self._codex_sessions_dir()
        if sessions_dir is None:
            return None
        matches = sorted(sessions_dir.glob(f"**/*{session_id}*.jsonl"))
        if not matches:
            return None
        src = matches[0]
        new_id = str(uuid.uuid4())
        dst = src.with_name(src.name.replace(session_id, new_id))
        try:
            dst.write_text(src.read_text(encoding="utf-8").replace(session_id, new_id),
                           encoding="utf-8")
        except OSError:
            return None
        return new_id, str(dst)

    @staticmethod
    def _strictify_schema(schema_json: str) -> str:
        """Widen `required` to every property — Codex's `--output-schema` runs in
        OpenAI strict mode. The model emits empties for inapplicable sections,
        which `structured_to_markdown` skips."""
        try:
            schema = json.loads(schema_json)
        except json.JSONDecodeError:
            return schema_json
        props = schema.get("properties")
        if isinstance(props, dict):
            schema["required"] = list(props.keys())
            schema["additionalProperties"] = False
        return json.dumps(schema)

    @classmethod
    def _iter_events(cls, stdout: bytes):
        for line in stdout.decode(errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue

    @classmethod
    def _structured_from_stream(cls, stdout: bytes) -> Optional[dict]:
        """Fallback when `-o` is empty: the last agent_message holds the JSON."""
        last = None
        for ev in cls._iter_events(stdout):
            if ev.get("type") == "item.completed":
                item = ev.get("item") or {}
                if item.get("type") == "agent_message":
                    last = item.get("text")
        if last:
            try:
                return json.loads(last)
            except json.JSONDecodeError:
                return None
        return None

    @classmethod
    def _usage_from_stream(cls, stdout: bytes) -> dict:
        for ev in cls._iter_events(stdout):
            if ev.get("type") == "turn.completed":
                return ev.get("usage") or {}
        return {}
