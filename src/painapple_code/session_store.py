"""Session storage public API.

This module is the import-stable surface. The heavy V2 implementation
lives in session_store_core.
External code only needs `from session_store import SessionStore`.
"""

import logging
from pathlib import Path
from typing import Optional

from painapple_code import bridge_paths

# Re-export so `from session_store import SessionStoreV2` still works.
from painapple_code.session_store_core import SessionStoreV2

logger = logging.getLogger("painapple-code.store")


class SessionStore:
    """
    Backward-compatible wrapper that provides the old API
    while using the new V2 storage format internally.

    Storage: ~/.painapple-code/projects/{hash}/sessions/
    """

    # Cache of stores by project path
    _stores: dict[str, SessionStoreV2] = {}

    @classmethod
    def _get_store(cls, project_path: str) -> SessionStoreV2:
        """Get or create a store for a project path."""
        if project_path not in cls._stores:
            cls._stores[project_path] = SessionStoreV2(project_path=project_path)
        return cls._stores[project_path]

    @classmethod
    def _find_session(cls, session_id: str) -> tuple[Optional[SessionStoreV2], Optional[dict]]:
        """
        Find a session across all projects.
        Returns (store, meta) or (None, None) if not found.
        """
        # First, check all loaded project stores. Iterate a snapshot:
        # sync route dependencies run in FastAPI's threadpool, so another
        # thread can insert into _stores mid-iteration.
        for store in list(cls._stores.values()):
            if store.exists(session_id):
                return store, store.load_meta(session_id)

        # Check all projects in bridge home — include unreachable so
        # lookup-by-id still works for sessions whose project path isn't
        # mounted (load/delete metadata for cleanup, etc.).
        # Don't skip projects already in _stores: a concurrent thread may
        # have loaded one after our first pass, and skipping it here made
        # existing sessions intermittently 404 on cold-cache page loads.
        for project_info in bridge_paths.list_projects(include_unreachable=True):
            store = cls._get_store(project_info["path"])
            if store.exists(session_id):
                return store, store.load_meta(session_id)

        return None, None

    @classmethod
    def generate_id(cls) -> str:
        return SessionStoreV2.generate_id()

    @classmethod
    def get_path(cls, session_id: str) -> Optional[Path]:
        """Returns session directory (not file), or None if session not found."""
        store, _ = cls._find_session(session_id)
        if store:
            return store._session_dir(session_id)
        return None

    @classmethod
    def create(cls, cwd: str, name: str = None) -> dict:
        """Create a new session in the project-based store."""
        store = cls._get_store(cwd)
        return store.create(cwd, name)

    @classmethod
    def create_pending(cls, cwd: str, name: str = None) -> dict:
        """Create session metadata without persisting to disk."""
        store = cls._get_store(cwd)
        return store.create_pending(cwd, name)

    @classmethod
    def persist(cls, meta: dict) -> dict:
        """Persist a pending session to disk."""
        cwd = meta.get("cwd")
        store = cls._get_store(cwd)
        return store.persist(meta)

    @classmethod
    def load(cls, session_id: str) -> Optional[dict]:
        """Load full session data (searches all projects and legacy)."""
        store, _ = cls._find_session(session_id)
        if store:
            return store.load_full(session_id)
        return None

    @classmethod
    def save(cls, session_id: str, data: dict):
        """Save session (only updates metadata in V2)."""
        store, _ = cls._find_session(session_id)
        if not store:
            return
        # Extract metadata fields
        meta_fields = ["name", "cwd", "provider_session_id", "model", "total_cost"]
        meta_updates = {k: data[k] for k in meta_fields if k in data}
        if meta_updates:
            store.update_meta(session_id, **meta_updates)

    @classmethod
    def delete(cls, session_id: str) -> bool:
        """Delete a session (searches all projects and legacy)."""
        store, _ = cls._find_session(session_id)
        if store:
            return store.delete(session_id)
        return False

    @classmethod
    def list_all(cls) -> list[dict]:
        """List all sessions from all projects."""
        all_sessions = []

        # Collect from all project stores
        for project_info in bridge_paths.list_projects():
            project_path = project_info["path"]
            store = cls._get_store(project_path)
            all_sessions.extend(store.list_all())

        # Sort by last_activity descending and deduplicate
        seen_ids = set()
        unique_sessions = []
        for session in sorted(all_sessions, key=lambda s: s.get("last_activity", ""), reverse=True):
            if session["id"] not in seen_ids:
                seen_ids.add(session["id"])
                unique_sessions.append(session)

        return unique_sessions

    @classmethod
    def add_message(cls, session_id: str, message: dict) -> int:
        """
        Add a message to a session.

        Returns:
            Line number (1-indexed) of the added message, or -1 on failure
        """
        store, _ = cls._find_session(session_id)
        if store:
            return store.add_message(session_id, message)
        return -1

    @classmethod
    def update_metadata(cls, session_id: str, **kwargs):
        store, _ = cls._find_session(session_id)
        if store:
            store.update_meta(session_id, **kwargs)

    @classmethod
    def clear_conversation(cls, session_id: str):
        store, _ = cls._find_session(session_id)
        if store:
            store.clear_conversation(session_id)

    @classmethod
    def update_tool_result(cls, session_id: str, tool_use_id: str, output: str, error: str = "", start_line: int = None):
        store, _ = cls._find_session(session_id)
        if store:
            store.update_tool_result(session_id, tool_use_id, output, error, start_line)

    @classmethod
    def add_thinking_message(cls, session_id: str, content: str, timestamp: str = None) -> int:
        store, _ = cls._find_session(session_id)
        if store:
            return store.add_thinking_message(session_id, content, timestamp)
        return -1

    @classmethod
    def add_tool_to_thinking(cls, session_id: str, thinking_index: int, tool_data: dict):
        store, _ = cls._find_session(session_id)
        if store:
            store.add_tool_to_thinking(session_id, thinking_index, tool_data)

    @classmethod
    def update_thinking_tool_result(cls, session_id: str, tool_use_id: str, output: str, start_line: int = None):
        store, _ = cls._find_session(session_id)
        if store:
            store.update_thinking_tool_result(session_id, tool_use_id, output, start_line)

    @classmethod
    def log_raw(cls, session_id: str, direction: str, data: str, parsed: dict = None):
        store, _ = cls._find_session(session_id)
        if store:
            store.log_raw(session_id, direction, data, parsed)

    @classmethod
    def log_raw_error(cls, session_id: str, error: str, context: str = None):
        store, _ = cls._find_session(session_id)
        if store:
            store.log_raw_error(session_id, error, context)

    @classmethod
    def save_project_commands(cls, cwd: str, commands: list):
        """Save slash commands for a project."""
        store = cls._get_store(cwd)
        store.save_project_commands(cwd, commands)

    @classmethod
    def get_project_commands(cls, cwd: str) -> list:
        """Get slash commands for a project."""
        store = cls._get_store(cwd)
        return store.get_project_commands(cwd)

    @classmethod
    def exists(cls, session_id: str) -> bool:
        """Check if a session exists (searches all projects)."""
        store, _ = cls._find_session(session_id)
        return store is not None

    @classmethod
    def get_uploads_path(cls, session_id: str) -> Optional[Path]:
        """Get or create the uploads directory for a session.

        Returns None if the session doesn't exist in any project store.
        """
        store, _ = cls._find_session(session_id)
        if store:
            uploads_dir = store._uploads_dir(session_id)
            uploads_dir.mkdir(parents=True, exist_ok=True)
            return uploads_dir
        return None

    @classmethod
    def load_meta(cls, session_id: str) -> Optional[dict]:
        """Load session metadata only (fast, for listings)."""
        store, meta = cls._find_session(session_id)
        return meta

    @classmethod
    def update_meta(cls, session_id: str, **kwargs):
        """Alias for update_metadata."""
        cls.update_metadata(session_id, **kwargs)

    @classmethod
    def _rewrite_messages(cls, session_id: str, messages: list):
        """Rewrite all messages for a session (used by import)."""
        store, _ = cls._find_session(session_id)
        if store:
            store._rewrite_messages(session_id, messages)
