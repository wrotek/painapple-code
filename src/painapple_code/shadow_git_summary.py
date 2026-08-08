"""
Shadow Git - summary fork for rich commit messages.

`ShadowGit.commit_turn` delegates to the methods in `_SummaryMixin` when the
project has rich commits enabled:

- `_build_journey_context` reads previous commits' YAML frontmatter and
  filters by branch to assemble a per-session journey timeline.
- `_generate_rich_commit_message` is the heavy lifter: it asks the session's
  provider how to fork itself (`build_summary_fork`), spawns that subprocess,
  registers it for visibility in the Active Sessions widget, parses the
  structured JSON response, and renders a markdown commit body.
- `_extract_title` mines a one-liner title out of the rendered body.
- `_update_session_meta` rolls per-turn cost/file/tool counters back into
  the session's `meta.json` (atomic write).

The mixin holds no state of its own — every method uses attributes set by
`ShadowGit.__init__` (`self.config`, `self.project_path`) and helpers from
the core class (`self._run`).
"""

import asyncio
import json
import logging
import os
import tempfile
import time
from typing import Optional

from painapple_code.bridge_paths import get_sessions_dir
from painapple_code.subprocess_registry import agent_subprocesses, SubprocessType, SubprocessStatus
from painapple_code.utils.proc import popen_kwargs_detached, resolve_binary
from painapple_code.turn_tracker import TurnTracker

from painapple_code.shadow_git_frontmatter import (
    SummaryCost,
    MAX_JOURNEY_TURNS,
    build_journey_section,
    parse_yaml_frontmatter,
)
from painapple_code.shadow_git_sections import (
    build_commit_prompt_for_json,
    build_commit_schema,
    structured_to_markdown,
)

logger = logging.getLogger("painapple-code.shadow-git")


class _SummaryMixin:
    """Rich-commit methods mixed into ShadowGit. Not instantiated directly."""

    def _extract_title(self, message_body: str) -> str:
        """Extract title from rich commit message (first ## Summary line)."""
        for line in message_body.split("\n"):
            line = line.strip()
            if line.startswith("## Summary"):
                continue
            if line and not line.startswith("#"):
                return line[:60]
        return "Update"

    async def _build_journey_context(
        self,
        session_id: str,
        current_branch: Optional[str] = None
    ) -> list[dict]:
        """
        Build journey context from previous commits for this session.

        Fetches previous commits and extracts their summaries from YAML frontmatter.
        When current_branch is provided, only includes entries from the same branch
        to prevent context bleeding across branches.

        Args:
            session_id: Session to get journey for
            current_branch: Current project branch (for filtering)

        Returns:
            List of journey entries: [{turn: 1, summary: "..."}, ...]
        """
        journey = []

        try:
            # Get previous commits for this session (most recent first)
            # Fetch extra commits to allow for branch filtering
            stdout, _, exit_code = await self._run([
                "log",
                f"--grep=\\[{session_id[:8]}",
                f"-n{MAX_JOURNEY_TURNS * 2 + 1}",  # Get extra for branch filtering
                "--format=%H"
            ], check=False)

            if exit_code != 0 or not stdout.strip():
                return []

            commit_hashes = stdout.strip().split("\n")

            # Fetch full commit message for each and extract summary
            # Get extra commits to allow for branch filtering
            for commit_hash in commit_hashes[:MAX_JOURNEY_TURNS * 2]:
                if not commit_hash:
                    continue
                if len(journey) >= MAX_JOURNEY_TURNS:
                    break

                try:
                    msg_stdout, _, _ = await self._run([
                        "log", "-1", "--format=%B", commit_hash
                    ])

                    # Parse YAML frontmatter
                    yaml_data = parse_yaml_frontmatter(msg_stdout)

                    if yaml_data:
                        turn = yaml_data.get('turn', 0)
                        summary = yaml_data.get('summary', '')
                        commit_branch = yaml_data.get('project_branch')

                        # Filter by branch: skip entries from different branches
                        # Include if: no current_branch, no commit_branch (old format), or branches match
                        if current_branch and commit_branch and commit_branch != current_branch:
                            logger.debug(
                                f"Skipping journey entry from different branch: "
                                f"{commit_branch} != {current_branch}"
                            )
                            continue

                        if turn and summary:
                            journey.append({
                                'turn': turn,
                                'summary': summary
                            })
                except Exception as e:
                    logger.debug(f"Failed to parse commit {commit_hash[:8]}: {e}")
                    continue

            # Sort by turn number (oldest first for chronological order)
            journey.sort(key=lambda x: x.get('turn', 0))

        except Exception as e:
            logger.warning(f"Failed to build journey context: {e}")

        return journey

    async def _generate_rich_commit_message(
        self,
        provider,
        provider_session_id: str,
        prompt: str,
        tracker: TurnTracker,
        journey: list[dict] = None,
        bridge_session_id: Optional[str] = None,
        token_profile: Optional[str] = None,
        session_model: Optional[str] = None,
    ) -> tuple[Optional[str], Optional[SummaryCost], Optional[dict]]:
        """
        Fork the session's provider to generate a structured commit message.

        The provider owns the fork mechanism and result parsing
        (`build_summary_fork` / `parse_summary_fork`): Claude branches with
        `--resume --fork-session`, Codex copies its rollout under a fresh id and
        resumes the copy. This method owns the provider-agnostic plumbing —
        prompt + schema assembly, the subprocess registry entry, the 300s
        timeout, cancellation, temp-file cleanup, and rendering the structured
        result to markdown.

        Args:
            provider: The session's Provider (supplies the fork argv + parser).
            provider_session_id: Provider session/thread id the fork resumes.
            prompt: User's prompt for this turn
            tracker: TurnTracker with files and tools
            journey: Previous turns' summaries for context
            bridge_session_id: Bridge session ID (for subprocess tracking)
            token_profile: OAuth token profile for the fork (Claude only)
            session_model: Parent session's model ID (to inherit context tier)

        Returns:
            Tuple of (message_body, summary_cost, structured_data), or
            (None, None, None) when the provider can't fork or the fork fails.
        """
        if not provider_session_id:
            return None, None, None

        # Build journey section for the prompt
        journey_section = build_journey_section(journey or [])

        # Build prompt and schema for structured JSON output
        prompt_type = "file_changes" if tracker.has_file_changes else "tool_only"
        fork_prompt = build_commit_prompt_for_json(
            project_config=self.config,
            prompt_type=prompt_type,
            journey_section=journey_section,
            user_prompt=prompt[:500],
            files=", ".join(sorted(tracker.modified_files)) if tracker.has_file_changes else "",
            tools=tracker.format_for_prompt()
        )
        schema_str = json.dumps(build_commit_schema(self.config, prompt_type))

        # Ask the provider how to fork itself for this turn. None → the provider
        # can't fork (unsupported, or its rollout is missing); the basic shadow
        # commit still happens upstream, just without AI sections.
        plan = provider.build_summary_fork(
            session_id=provider_session_id,
            fork_prompt=fork_prompt,
            schema_json=schema_str,
            cwd=str(self.project_path),
            token_profile=token_profile,
            session_model=session_model,
        )
        if plan is None:
            return None, None, None

        proc = None
        # A provider whose wire isn't the default newline-JSON ("lines") conducts
        # the summary over the live process itself (drive_summary_fork) instead of
        # a one-shot communicate() + parse_summary_fork — e.g. the app-server's
        # JSON-RPC thread/fork + turn/start. We still own spawn/registry/timeout.
        transport_driven = getattr(provider.capabilities, "transport", "lines") != "lines"
        # A provider may hand us the prompt to write over stdin (keeps a large
        # prompt out of argv/ps and clear of ARG_MAX) — that also needs a PIPE.
        stdin_input = getattr(plan, "stdin_input", None)
        try:
            start_time = time.time()
            stdout, stderr = b"", b""

            proc = await asyncio.create_subprocess_exec(
                resolve_binary(plan.argv[0]), *plan.argv[1:],
                stdin=asyncio.subprocess.PIPE if (transport_driven or stdin_input is not None) else None,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(self.project_path),
                env=plan.env,
                **popen_kwargs_detached(),  # isolate from server's process group
            )

            # Register subprocess for visibility in Active Sessions widget
            agent_subprocesses.register(
                pid=proc.pid,
                subprocess_type=SubprocessType.SUMMARY_FORK,
                parent_session_id=bridge_session_id,
                model=plan.model,
                purpose="Rich commit message",
                cwd=str(self.project_path),
            )

            if transport_driven:
                structured_data, cost = await asyncio.wait_for(
                    provider.drive_summary_fork(proc, plan),
                    timeout=300,  # summarizer may need compaction
                )
            else:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(
                        input=stdin_input.encode() if stdin_input is not None else None
                    ),
                    timeout=300  # summarizer may need compaction when context exceeds the window
                )
                # Provider parses its own output → (structured_data, cost).
                structured_data, cost = provider.parse_summary_fork(
                    plan=plan,
                    returncode=proc.returncode or 0,
                    stdout=stdout or b"",
                    stderr=stderr or b"",
                )

            duration = time.time() - start_time

            if not structured_data:
                err = stderr.decode(errors="replace").strip() if stderr else ""
                if not err and stdout:
                    err = stdout.decode(errors="replace").strip()[:300]
                logger.warning(
                    f"Rich-commit fork failed (rc={proc.returncode}): "
                    f"{err[:300] or 'no structured output'}"
                )
                agent_subprocesses.unregister(
                    proc.pid,
                    status=SubprocessStatus.ERROR,
                    error_message=err[:200] or "no structured output",
                )
                return None, None, None

            summary_cost = SummaryCost(
                cost=(cost or {}).get("cost", 0.0),
                input_tokens=(cost or {}).get("input_tokens", 0),
                output_tokens=(cost or {}).get("output_tokens", 0),
                duration=duration,
            )
            message = structured_to_markdown(structured_data, self.config, prompt_type)

            logger.info(
                f"Rich-commit fork: ${summary_cost.cost:.4f} "
                f"({summary_cost.input_tokens}↓ {summary_cost.output_tokens}↑) "
                f"in {duration:.1f}s"
            )

            # Unregister with success status and full details
            agent_subprocesses.unregister(
                proc.pid,
                status=SubprocessStatus.SUCCESS,
                result_preview=message[:100] if message else None,
                cost=summary_cost.cost,
                input_tokens=summary_cost.input_tokens,
                output_tokens=summary_cost.output_tokens,
            )

            return message, summary_cost, structured_data

        except asyncio.TimeoutError:
            logger.warning("Rich-commit fork timed out after 300s")
            # Unregister with timeout status
            if proc:
                agent_subprocesses.unregister(
                    proc.pid,
                    status=SubprocessStatus.TIMEOUT,
                    error_message="Process timed out after 300s",
                )
                # Kill the process if still running
                if proc.returncode is None:
                    try:
                        proc.kill()
                        await proc.wait()
                    except Exception:
                        pass
            return None, None, None
        except asyncio.CancelledError:
            logger.debug("Rich-commit fork cancelled (user sent new prompt)")
            # Unregister with killed status
            if proc:
                agent_subprocesses.unregister(
                    proc.pid,
                    status=SubprocessStatus.KILLED,
                    error_message="Cancelled by new user prompt",
                )
                # Kill the process if still running
                if proc.returncode is None:
                    try:
                        proc.kill()
                        await proc.wait()
                    except Exception:
                        pass
            raise  # Re-raise to propagate cancellation
        except Exception as e:
            logger.exception(f"Rich-commit fork error: {e}")
            # Unregister with error status
            if proc:
                agent_subprocesses.unregister(
                    proc.pid,
                    status=SubprocessStatus.ERROR,
                    error_message=str(e)[:200],
                )
            return None, None, None
        finally:
            # Reap a still-running process. The exec path exits via communicate()
            # and the timeout/cancel branches kill explicitly; this backstops the
            # transport-driven success path and a generic error before any kill.
            if proc is not None and proc.returncode is None:
                try:
                    proc.kill()
                    await proc.wait()
                except Exception:
                    pass
            # Remove any temp copies/files the provider created for this fork
            # (Codex exec's rollout copy + schema/output temp files; none for
            # Claude or the app-server's native fork).
            for path in plan.cleanup_paths:
                try:
                    os.unlink(path)
                except OSError:
                    pass

    async def _update_session_meta(
        self,
        session_id: str,
        commit_hash: str,
        tracker: TurnTracker,
        cost_info,
        summary_cost: Optional[SummaryCost] = None,
        session_title: Optional[str] = None
    ):
        """Update session's meta.json with shadow git info and optional title."""
        sessions_dir = get_sessions_dir(str(self.project_path))
        meta_file = sessions_dir / session_id / "meta.json"

        if not meta_file.exists():
            logger.warning(f"Session meta not found: {meta_file}")
            return

        try:
            meta = json.loads(meta_file.read_text())

            # Update session title if provided (from the summary fork)
            # Skip if user manually renamed the session (manual_name flag)
            if session_title and not meta.get("manual_name"):
                meta["name"] = session_title
                logger.debug(f"Updated session title: {session_title}")

            if "shadow" not in meta:
                meta["shadow"] = {
                    "turn_count": 0,
                    "file_commits": 0,
                    "tool_commits": 0,
                    "first_commit": commit_hash,
                    "files_touched": [],
                    "tools_summary": {},
                    "total_cost": 0,
                    "total_input_tokens": 0,
                    "total_output_tokens": 0,
                    "summary_cost": 0,
                    "summary_calls": 0,
                    "archived": False,
                    "archive_tag": None
                }

            shadow = meta["shadow"]
            shadow["turn_count"] += 1
            shadow["last_commit"] = commit_hash

            if tracker.has_file_changes:
                shadow["file_commits"] += 1
                shadow["files_touched"] = list(set(
                    shadow["files_touched"] + list(tracker.modified_files)
                ))
            else:
                shadow["tool_commits"] += 1

            # Merge tool counts
            for name, count in tracker.get_tools_summary().items():
                shadow["tools_summary"][name] = shadow["tools_summary"].get(name, 0) + count

            shadow["total_cost"] += cost_info.cost
            shadow["total_input_tokens"] += cost_info.input_tokens
            shadow["total_output_tokens"] += cost_info.output_tokens

            # Track summary-fork costs for rich commits.
            # Back-compat: migrate the pre-rename haiku_* keys on first write.
            if summary_cost:
                shadow["summary_cost"] = shadow.get("summary_cost", shadow.pop("haiku_cost", 0)) + summary_cost.cost
                shadow["summary_calls"] = shadow.get("summary_calls", shadow.pop("haiku_calls", 0)) + 1

            # Atomic write to avoid corruption on disk-full
            tmp_path = None
            data = json.dumps(meta, indent=2).encode()
            fd, tmp_path = tempfile.mkstemp(
                dir=meta_file.parent, prefix=".meta_", suffix=".tmp"
            )
            try:
                os.write(fd, data)
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(tmp_path, meta_file)

        except Exception as e:
            logger.exception(f"Failed to update session meta: {e}")
            # Clean up temp file if atomic write failed partway
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
