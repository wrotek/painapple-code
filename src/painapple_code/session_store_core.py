"""Session Storage V2: directory-based, per-project.

The core class lives here; the public-API facade is in session_store.py.
"""

import json
import logging
import os
import secrets
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Iterator

from painapple_code import bridge_paths

logger = logging.getLogger("painapple-code.store")


class SessionStoreV2:
    """
    Directory-based session storage.

    Each session is a directory containing:
    - meta.json: Small metadata file (id, name, cwd, cost, timestamps)
    - messages.jsonl: Append-only message log (one JSON per line)
    - tools/: Directory for tool output files

    Storage location: ~/.painapple-code/projects/{project-hash}/sessions/
    """

    # Tool output size threshold - outputs larger than this go to separate files
    TOOL_OUTPUT_THRESHOLD = 500  # chars

    def __init__(self, project_path: str):
        """
        Initialize session store.

        Args:
            project_path: Project directory (cwd). Sessions are stored
                         in ~/.painapple-code/projects/{hash}/sessions/.
        """
        self.project_path = project_path
        bridge_paths.ensure_project_dir(project_path)
        self.base_dir = bridge_paths.get_sessions_dir(project_path)
        self.base_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def generate_id() -> str:
        """Generate a short unique session ID."""
        return secrets.token_urlsafe(8)  # ~11 chars, URL-safe

    def _session_dir(self, session_id: str) -> Path:
        """Get the directory path for a session."""
        return self.base_dir / session_id

    def _meta_path(self, session_id: str) -> Path:
        """Get the meta.json path for a session."""
        return self._session_dir(session_id) / "meta.json"

    def _messages_path(self, session_id: str) -> Path:
        """Get the messages.jsonl path for a session."""
        return self._session_dir(session_id) / "messages.jsonl"

    def _raw_log_path(self, session_id: str) -> Path:
        """Get the raw.jsonl path for a session (raw Claude output log)."""
        return self._session_dir(session_id) / "raw.jsonl"

    def _tools_dir(self, session_id: str) -> Path:
        """Get the tools/ directory path for a session."""
        return self._session_dir(session_id) / "tools"

    def _uploads_dir(self, session_id: str) -> Path:
        """Get the uploads/ directory path for a session."""
        return self._session_dir(session_id) / "uploads"

    def _stash_path(self, session_id: str) -> Path:
        """Get the stash.json path for a session."""
        return self._session_dir(session_id) / "stash.json"

    def _tool_filename(self, tool_name: str, tool_id: str) -> str:
        """Generate filename for a tool output file."""
        # Strip 'toolu_' prefix if present
        suffix = tool_id.replace("toolu_", "") if tool_id.startswith("toolu_") else tool_id
        # Sanitize tool name (remove any problematic chars)
        safe_name = "".join(c for c in tool_name if c.isalnum() or c in "-_")
        return f"{safe_name}_{suffix}.txt"

    # ─────────────────────────────────────────────────────────────────
    # Session CRUD
    # ─────────────────────────────────────────────────────────────────

    def create_pending(self, cwd: str, name: str = None) -> dict:
        """
        Create session metadata WITHOUT persisting to disk.
        Use persist() to actually write to disk when first message arrives.
        This avoids cluttering history with empty sessions.
        """
        session_id = self.generate_id()
        now = datetime.now(timezone.utc).isoformat()

        meta = {
            "id": session_id,
            "name": name or cwd.split("/")[-1] or "New Session",
            "cwd": cwd,
            "provider": None,  # None → resolved to the box-wide default at launch
            "provider_session_id": None,
            "model": None,
            "total_cost": 0,
            "message_count": 0,
            "slash_commands": [],
            "created_at": now,
            "last_activity": now,
            "_pending": True,  # Flag indicating not yet persisted
        }

        # Include project hash for reverse lookup (new storage format)
        if self.project_path:
            meta["project_hash"] = bridge_paths.get_project_hash(self.project_path)

        return meta

    def persist(self, meta: dict) -> dict:
        """
        Persist a pending session to disk.
        Call this when first message arrives or Claude sends init.
        Returns the meta dict with _pending flag removed.
        """
        if not meta.get("_pending"):
            return meta  # Already persisted

        session_id = meta["id"]
        session_dir = self._session_dir(session_id)

        # Create directory structure
        session_dir.mkdir(parents=True, exist_ok=True)
        self._tools_dir(session_id).mkdir(exist_ok=True)

        # Remove pending flag and write
        meta = {k: v for k, v in meta.items() if k != "_pending"}
        self._write_meta(session_id, meta)

        # Create empty log files
        self._messages_path(session_id).touch()
        self._raw_log_path(session_id).touch()

        logger.info(f"Persisted session directory: {session_id}")
        return meta

    def create(self, cwd: str, name: str = None) -> dict:
        """Create a new session with directory structure (immediate persistence)."""
        session_id = self.generate_id()
        session_dir = self._session_dir(session_id)

        # Create directory structure
        session_dir.mkdir(parents=True, exist_ok=True)
        self._tools_dir(session_id).mkdir(exist_ok=True)

        # Initialize metadata
        now = datetime.now(timezone.utc).isoformat()
        meta = {
            "id": session_id,
            "name": name or cwd.split("/")[-1] or "New Session",
            "cwd": cwd,
            "provider_session_id": None,
            "model": None,
            "total_cost": 0,
            "message_count": 0,
            "slash_commands": [],  # Claude slash commands for autocomplete
            "created_at": now,
            "last_activity": now,
        }

        # Include project hash for reverse lookup (new storage format)
        if self.project_path:
            meta["project_hash"] = bridge_paths.get_project_hash(self.project_path)

        # Write meta.json
        self._write_meta(session_id, meta)

        # Create empty messages.jsonl and raw.jsonl
        self._messages_path(session_id).touch()
        self._raw_log_path(session_id).touch()

        logger.info(f"Created session directory: {session_id}")
        return meta

    def exists(self, session_id: str) -> bool:
        """Check if a session exists."""
        return self._meta_path(session_id).exists()

    def load_meta(self, session_id: str) -> Optional[dict]:
        """Load only session metadata (fast, for listings).

        If meta.json is empty/corrupt (e.g. from disk-full), attempts to
        reconstruct minimal metadata from raw.jsonl and re-persist it.
        """
        meta_path = self._meta_path(session_id)
        if not meta_path.exists():
            return None
        try:
            text = meta_path.read_text()
            if not text.strip():
                raise ValueError("empty meta.json")
            meta = json.loads(text)
            # Back-compat: the provider conversation-id key was claude_session_id
            # before the provider-neutral rename. Normalize on read so existing
            # sessions still resume; the old key is dropped on the next write.
            if "claude_session_id" in meta and "provider_session_id" not in meta:
                meta["provider_session_id"] = meta.pop("claude_session_id")
            return meta
        except Exception as e:
            logger.warning(f"Corrupt meta for {session_id}: {e}, attempting recovery")
            meta = self._recover_meta(session_id)
            if meta:
                self._write_meta(session_id, meta)
                logger.info(f"Recovered meta for {session_id} from raw.jsonl")
            return meta

    def load_full(self, session_id: str) -> Optional[dict]:
        """Load full session data including all messages (for restore)."""
        meta = self.load_meta(session_id)
        if not meta:
            return None

        # Load messages from JSONL
        messages = list(self._read_messages(session_id))

        # Hydrate tool outputs from files
        for msg in messages:
            self._hydrate_tool_output(session_id, msg)

        return {**meta, "messages": messages}

    def _write_meta(self, session_id: str, meta: dict):
        """Write metadata to meta.json atomically (temp file + rename).

        Avoids data loss on disk-full: writes to temp file first, then
        atomic rename. If write fails, the original meta.json is untouched.
        """
        meta_path = self._meta_path(session_id)
        tmp_path = None
        try:
            data = json.dumps(meta, indent=2).encode()
            fd, tmp_path = tempfile.mkstemp(
                dir=meta_path.parent, prefix=".meta_", suffix=".tmp"
            )
            try:
                os.write(fd, data)
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(tmp_path, meta_path)
        except Exception as e:
            logger.error(f"Failed to write meta for {session_id}: {e}")
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

    def _recover_meta(self, session_id: str) -> Optional[dict]:
        """Reconstruct minimal meta from raw.jsonl when meta.json is corrupt."""
        raw_path = self._raw_log_path(session_id)
        if not raw_path.exists() or raw_path.stat().st_size == 0:
            logger.warning(f"Cannot recover {session_id}: no raw.jsonl")
            return None

        try:
            cwd = None
            provider_session_id = None
            model = None
            first_ts = None
            last_ts = None
            msg_count = 0

            with open(raw_path) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    ts = entry.get("ts")
                    if ts and not first_ts:
                        first_ts = ts
                    if ts:
                        last_ts = ts

                    # Extract init data
                    if entry.get("subtype") == "init" and entry.get("data"):
                        try:
                            init = json.loads(entry["data"])
                            cwd = cwd or init.get("cwd")
                            provider_session_id = provider_session_id or init.get("session_id")
                            model = model or init.get("model")
                        except json.JSONDecodeError:
                            pass

                    # Count user messages
                    if entry.get("dir") == "in" and entry.get("type") == "user":
                        msg_count += 1

            if not cwd:
                logger.warning(f"Cannot recover {session_id}: no cwd in raw.jsonl")
                return None

            now = datetime.now(timezone.utc).isoformat()
            meta = {
                "id": session_id,
                "name": cwd.split("/")[-1] or "Recovered Session",
                "cwd": cwd,
                "provider_session_id": provider_session_id,
                "model": model,
                "total_cost": 0,
                "message_count": msg_count,
                "slash_commands": [],
                "created_at": first_ts or now,
                "last_activity": last_ts or now,
                "_recovered": True,
            }

            if self.project_path:
                meta["project_hash"] = bridge_paths.get_project_hash(self.project_path)

            return meta

        except Exception as e:
            logger.error(f"Recovery failed for {session_id}: {e}")
            return None

    def update_meta(self, session_id: str, **kwargs):
        """Update specific metadata fields (allows adding new fields)."""
        meta = self.load_meta(session_id)
        if meta:
            # Allow known fields to be added/updated
            allowed_fields = {
                "name", "description", "cwd", "provider_session_id", "model",
                "total_cost", "message_count", "slash_commands", "max_thinking_tokens",
                "token_profile", "preferred_model", "permission_level",
                "effort_level", "provider",
            }
            for key, value in kwargs.items():
                if key in meta or key in allowed_fields:
                    meta[key] = value
            meta["last_activity"] = datetime.now(timezone.utc).isoformat()
            self._write_meta(session_id, meta)

    def delete(self, session_id: str) -> bool:
        """Delete a session and all its data."""
        session_dir = self._session_dir(session_id)
        if session_dir.exists():
            shutil.rmtree(session_dir)
            logger.info(f"Deleted session: {session_id}")
            return True
        return False

    def list_all(self) -> list[dict]:
        """List all sessions (metadata only, sorted by last_activity)."""
        sessions = []

        for entry in self.base_dir.iterdir():
            if entry.is_dir() and (entry / "meta.json").exists():
                meta = self.load_meta(entry.name)
                if meta:
                    sessions.append(meta)

        # Sort by last_activity descending
        sessions.sort(key=lambda s: s.get("last_activity", ""), reverse=True)
        return sessions

    # ─────────────────────────────────────────────────────────────────
    # Message Storage (append-only JSONL)
    # ─────────────────────────────────────────────────────────────────

    def _read_messages(self, session_id: str) -> Iterator[dict]:
        """Read all messages from JSONL file."""
        messages_path = self._messages_path(session_id)
        if not messages_path.exists():
            return

        try:
            with open(messages_path, 'r') as f:
                for line_num, line in enumerate(f, 1):
                    line = line.strip()
                    if line:
                        try:
                            yield json.loads(line)
                        except json.JSONDecodeError as e:
                            logger.warning(f"Skipping invalid JSON at line {line_num} in {session_id}: {e}")
        except Exception as e:
            logger.error(f"Failed to read messages for {session_id}: {e}")

    def _append_message(self, session_id: str, message: dict) -> int:
        """Append a single message to JSONL file. Returns new message count."""
        messages_path = self._messages_path(session_id)
        try:
            with open(messages_path, 'a') as f:
                f.write(json.dumps(message) + '\n')

            # Update message count in meta
            meta = self.load_meta(session_id)
            if meta:
                new_count = meta.get("message_count", 0) + 1
                meta["message_count"] = new_count
                meta["last_activity"] = datetime.now(timezone.utc).isoformat()
                self._write_meta(session_id, meta)
                return new_count

        except Exception as e:
            logger.error(f"Failed to append message to {session_id}: {e}")
        return -1

    def add_message(self, session_id: str, message: dict) -> int:
        """
        Add a message to the session.

        Returns:
            Line number (1-indexed) of the added message, or -1 on failure
        """
        # Add timestamp if not present
        if "timestamp" not in message:
            message["timestamp"] = datetime.now(timezone.utc).isoformat()

        return self._append_message(session_id, message)

    # ─────────────────────────────────────────────────────────────────
    # Raw Output Logging (append-only, captures everything from Claude)
    # ─────────────────────────────────────────────────────────────────

    def log_raw(self, session_id: str, direction: str, data: str, parsed: dict = None):
        """
        Log raw Claude I/O to raw.jsonl for debugging/audit.

        Args:
            session_id: Session ID
            direction: "in" (to Claude), "out" (from Claude), or "event" (lifecycle events)
            data: Raw string data
            parsed: Parsed JSON if available (for type extraction)
        """
        raw_path = self._raw_log_path(session_id)
        if not raw_path.exists():
            return  # Session doesn't exist or not initialized

        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "dir": direction,
        }

        # Add type info if parsed
        if parsed and isinstance(parsed, dict):
            entry["type"] = parsed.get("type", "unknown")
            if parsed.get("subtype"):
                entry["subtype"] = parsed["subtype"]

        # Handle different directions
        if direction == "out":
            # Claude output - include raw data (truncated if huge)
            if len(data) > 10000:
                entry["data"] = data[:10000] + f"...[truncated, total {len(data)} chars]"
                entry["truncated"] = True
            else:
                entry["data"] = data
        elif direction == "in":
            # Input to Claude - just log size (content in messages.jsonl)
            entry["size"] = len(data)
        elif direction == "event":
            # Lifecycle events (process start/stop, etc.)
            entry["event"] = data
        else:
            entry["data"] = data

        try:
            with open(raw_path, 'a') as f:
                f.write(json.dumps(entry) + '\n')
        except Exception as e:
            logger.error(f"Failed to write raw log for {session_id}: {e}")

    def log_raw_error(self, session_id: str, error: str, context: str = None):
        """Log an error/anomaly to raw.jsonl."""
        raw_path = self._raw_log_path(session_id)
        if not raw_path.exists():
            return

        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "dir": "error",
            "error": error,
        }
        if context:
            entry["context"] = context[:1000]  # Truncate context

        try:
            with open(raw_path, 'a') as f:
                f.write(json.dumps(entry) + '\n')
        except Exception as e:
            logger.error(f"Failed to write raw error log for {session_id}: {e}")

    # ─────────────────────────────────────────────────────────────────
    # Tool Output Storage (separate files for large outputs)
    # ─────────────────────────────────────────────────────────────────

    def _save_tool_output(self, session_id: str, tool_name: str, tool_id: str, output: str) -> str:
        """
        Save tool output to a separate file.
        Returns the filename for reference in the message.
        """
        tools_dir = self._tools_dir(session_id)
        tools_dir.mkdir(exist_ok=True)

        filename = self._tool_filename(tool_name, tool_id)
        filepath = tools_dir / filename

        try:
            filepath.write_text(output)
            logger.debug(f"Saved tool output: {filename} ({len(output)} chars)")
        except Exception as e:
            logger.error(f"Failed to save tool output {filename}: {e}")

        return filename

    def _load_tool_output(self, session_id: str, filename: str) -> Optional[str]:
        """Load tool output from file."""
        filepath = self._tools_dir(session_id) / filename
        if filepath.exists():
            try:
                return filepath.read_text()
            except Exception as e:
                logger.error(f"Failed to load tool output {filename}: {e}")
        return None

    def _hydrate_tool_output(self, session_id: str, message: dict):
        """
        Hydrate tool output from file if stored externally.
        Modifies message in-place.
        """
        # Handle regular tool messages
        if message.get("role") == "tool" and message.get("tool_output_file"):
            output = self._load_tool_output(session_id, message["tool_output_file"])
            if output is not None:
                message["tool_output"] = output

        # Handle thinking messages with nested tools
        if message.get("role") == "thinking" and message.get("tools"):
            for tool in message["tools"]:
                if tool.get("toolOutputFile"):
                    output = self._load_tool_output(session_id, tool["toolOutputFile"])
                    if output is not None:
                        tool["toolOutput"] = output

    def add_tool_message(self, session_id: str, tool_name: str, tool_id: str, tool_input: dict):
        """Add a tool invocation message."""
        message = {
            "role": "tool",
            "tool_name": tool_name,
            "tool_id": tool_id,
            "tool_input": tool_input,
            "tool_completed": False,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        self._append_message(session_id, message)

    def update_tool_result(self, session_id: str, tool_id: str, output: str, error: str = "", start_line: int = None):
        """
        Update a tool message with its result.
        Large outputs are stored in separate files.
        """
        # Read all messages to find and update the tool
        messages = list(self._read_messages(session_id))
        updated = False

        for msg in reversed(messages):
            if msg.get("role") == "tool" and msg.get("tool_id") == tool_id:
                msg["tool_completed"] = True
                msg["tool_error"] = error

                # Store startLine for Edit tools (from structuredPatch)
                if start_line:
                    msg["startLine"] = start_line

                # Store large outputs in separate file
                if len(output) > self.TOOL_OUTPUT_THRESHOLD:
                    filename = self._save_tool_output(
                        session_id,
                        msg.get("tool_name", "Unknown"),
                        tool_id,
                        output
                    )
                    msg["tool_output_file"] = filename
                    msg["tool_output"] = f"[Stored in {filename}]"
                else:
                    msg["tool_output"] = output

                updated = True
                break

        if updated:
            # Rewrite messages file (necessary for updates)
            self._rewrite_messages(session_id, messages)

    def _rewrite_messages(self, session_id: str, messages: list):
        """Rewrite all messages (used for updates/imports)."""
        messages_path = self._messages_path(session_id)
        try:
            with open(messages_path, 'w') as f:
                for msg in messages:
                    f.write(json.dumps(msg) + '\n')

            # Update message count in meta
            self.update_meta(session_id, message_count=len(messages))
        except Exception as e:
            logger.error(f"Failed to rewrite messages for {session_id}: {e}")

    # ─────────────────────────────────────────────────────────────────
    # Thinking Message Support
    # ─────────────────────────────────────────────────────────────────

    def add_thinking_message(self, session_id: str, content: str, timestamp: str = None) -> int:
        """Add a thinking message. Returns the message index."""
        messages_path = self._messages_path(session_id)

        # Count existing messages to get index
        msg_count = sum(1 for _ in self._read_messages(session_id))

        message = {
            "role": "thinking",
            "content": content,
            "tools": [],
            "timestamp": timestamp or (datetime.now(timezone.utc).isoformat()),
        }
        self._append_message(session_id, message)
        return msg_count

    def add_tool_to_thinking(self, session_id: str, thinking_index: int, tool_data: dict):
        """Add a tool to an existing thinking message."""
        messages = list(self._read_messages(session_id))

        if 0 <= thinking_index < len(messages):
            msg = messages[thinking_index]
            if msg.get("role") == "thinking":
                msg["tools"].append({
                    "toolName": tool_data.get("name"),
                    "toolId": tool_data.get("id"),
                    "toolInput": tool_data.get("input"),
                    "toolOutput": None,
                    "toolCompleted": False,
                })
                self._rewrite_messages(session_id, messages)

    def update_thinking_tool_result(self, session_id: str, tool_id: str, output: str, start_line: int = None):
        """Update a tool result within a thinking message."""
        messages = list(self._read_messages(session_id))
        updated = False

        for msg in reversed(messages):
            if msg.get("role") == "thinking" and msg.get("tools"):
                for tool in msg["tools"]:
                    if tool.get("toolId") == tool_id:
                        tool["toolCompleted"] = True

                        # Store large outputs in separate file
                        if len(output) > self.TOOL_OUTPUT_THRESHOLD:
                            filename = self._save_tool_output(
                                session_id,
                                tool.get("toolName", "Unknown"),
                                tool_id,
                                output
                            )
                            tool["toolOutputFile"] = filename
                            tool["toolOutput"] = f"[Stored in {filename}]"
                        else:
                            tool["toolOutput"] = output

                        # Store startLine for Edit tools (from structuredPatch)
                        if start_line:
                            tool["startLine"] = start_line

                        updated = True
                        break
                if updated:
                    break

        if updated:
            self._rewrite_messages(session_id, messages)

    # ─────────────────────────────────────────────────────────────────
    # Clear / Reset
    # ─────────────────────────────────────────────────────────────────

    def clear_conversation(self, session_id: str):
        """Clear conversation history and reset for fresh start."""
        # Clear messages file
        messages_path = self._messages_path(session_id)
        if messages_path.exists():
            messages_path.write_text("")

        # Clear tools directory
        tools_dir = self._tools_dir(session_id)
        if tools_dir.exists():
            shutil.rmtree(tools_dir)
            tools_dir.mkdir()

        # Reset metadata
        self.update_meta(
            session_id,
            provider_session_id=None,
            message_count=0,
        )

        logger.info(f"Cleared conversation for {session_id}")

    # ─────────────────────────────────────────────────────────────────
    # Project-level Command Storage
    # ─────────────────────────────────────────────────────────────────
    # Slash commands are per-project (CWD), not per-session.
    # This allows new sessions to show commands before Claude starts.

    def _project_data_path(self, cwd: str) -> Path:
        """Get the project-data.json path for storing per-project data."""
        if self.project_path:
            # New: store in project's bridge directory
            return bridge_paths.get_project_dir(cwd) / "project-data.json"
        else:
            # Legacy: store in sessions directory
            return self.base_dir / "projects.json"

    def _load_project_data(self, cwd: str) -> dict:
        """Load project data."""
        path = self._project_data_path(cwd)
        if path.exists():
            try:
                return json.loads(path.read_text())
            except Exception as e:
                logger.error(f"Failed to load project data: {e}")
        return {}

    def _save_project_data(self, cwd: str, data: dict):
        """Save project data."""
        path = self._project_data_path(cwd)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(data, indent=2))
        except Exception as e:
            logger.error(f"Failed to save project data: {e}")

    def save_project_commands(self, cwd: str, commands: list):
        """Save slash commands for a project (CWD)."""
        data = self._load_project_data(cwd)
        data["slash_commands"] = commands
        data["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._save_project_data(cwd, data)
        logger.debug(f"Saved {len(commands)} commands for project {cwd}")

    def get_project_commands(self, cwd: str) -> list:
        """Get slash commands for a project (CWD)."""
        data = self._load_project_data(cwd)
        return data.get("slash_commands", [])

    # ─────────────────────────────────────────────────────────────────
    # Stash (context references)
    # ─────────────────────────────────────────────────────────────────

    def get_stash(self, session_id: str) -> list:
        """Get all stash items for a session."""
        stash_path = self._stash_path(session_id)
        if not stash_path.exists():
            return []
        try:
            data = json.loads(stash_path.read_text())
            return data.get("items", [])
        except Exception as e:
            logger.warning(f"Error reading stash for {session_id}: {e}")
            return []

    def _save_stash(self, session_id: str, items: list) -> bool:
        """Save stash items for a session. Returns True on success."""
        stash_path = self._stash_path(session_id)
        try:
            # Ensure session directory exists (may not if session is pending or different user)
            stash_path.parent.mkdir(parents=True, exist_ok=True)
            stash_path.write_text(json.dumps({"items": items}, indent=2))
            return True
        except Exception as e:
            logger.error(f"Error saving stash for {session_id}: {e}")
            return False

    def add_stash_item(self, session_id: str, item: dict) -> bool:
        """Add an item to the session stash. Returns True on success."""
        items = self.get_stash(session_id)
        items.insert(0, item)  # Newest first
        return self._save_stash(session_id, items)

    def remove_stash_item(self, session_id: str, item_id: str) -> bool:
        """Remove an item from the session stash. Returns True on success."""
        items = self.get_stash(session_id)
        items = [i for i in items if i.get("id") != item_id]
        return self._save_stash(session_id, items)

    def update_stash_item(self, session_id: str, item_id: str, updates: dict) -> tuple[bool, bool]:
        """Update a stash item (toggle enabled, edit note, etc).

        Returns (found, saved) tuple:
        - found: whether the item was found
        - saved: whether the save succeeded (only meaningful if found)
        """
        items = self.get_stash(session_id)
        for item in items:
            if item.get("id") == item_id:
                item.update(updates)
                saved = self._save_stash(session_id, items)
                return (True, saved)
        return (False, False)

    def clear_stash(self, session_id: str) -> bool:
        """Clear all items from a session stash."""
        stash_path = self._stash_path(session_id)
        if stash_path.exists():
            stash_path.unlink()
        return True

    # Sent-history cap per session — trimmed oldest-first on every mark-sent
    # so stash.json can't grow unbounded
    STASH_HISTORY_LIMIT = 50

    def mark_stash_sent(self, session_id: str, item_ids: list,
                        message_id: str = None, sent_at: str = None,
                        sent_session_id: str = None) -> tuple[int, bool]:
        """Mark stash items as sent (history) instead of deleting them.

        Sets status/sentAt/sentWithMessageId/sentInSessionId and disables
        the items, then trims sent history beyond STASH_HISTORY_LIMIT
        (oldest sentAt dropped first).

        Returns (marked_count, saved) tuple.
        """
        items = self.get_stash(session_id)
        ids = set(item_ids or [])
        now = sent_at or (datetime.now(timezone.utc).isoformat())

        marked = 0
        for item in items:
            if item.get("id") in ids:
                item["status"] = "sent"
                item["enabled"] = False
                item["sentAt"] = now
                item["sentWithMessageId"] = message_id
                item["sentInSessionId"] = sent_session_id
                marked += 1

        if marked == 0:
            return (0, True)

        # Trim oldest sent entries beyond the cap
        sent = [i for i in items if i.get("status") == "sent"]
        if len(sent) > self.STASH_HISTORY_LIMIT:
            sent.sort(key=lambda i: i.get("sentAt") or "", reverse=True)
            keep_ids = {i.get("id") for i in sent[:self.STASH_HISTORY_LIMIT]}
            items = [i for i in items
                     if i.get("status") != "sent" or i.get("id") in keep_ids]

        return (marked, self._save_stash(session_id, items))

    def clear_stash_scope(self, session_id: str, scope: str = "all") -> bool:
        """Clear stash items by scope: 'pending', 'history', or 'all'."""
        if scope == "all":
            return self.clear_stash(session_id)

        items = self.get_stash(session_id)
        if scope == "pending":
            items = [i for i in items if i.get("status") == "sent"]
        elif scope == "history":
            items = [i for i in items if i.get("status") != "sent"]
        else:
            return False
        return self._save_stash(session_id, items)
