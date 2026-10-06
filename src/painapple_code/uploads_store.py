"""Project-level upload storage.

Uploads live in ONE directory per project —
``~/.painapple-code/projects/{hash}/uploads/`` — instead of one per session
(``…/sessions/{id}/uploads/``). Browsing what was ever uploaded to a project
used to mean opening every session dir; now it is one folder.

Which session uploaded a file is still known: ``uploads/.index.json`` maps
each stored filename to ``{session_id, original_name, uploaded_at, size,
sha256?}``. The Uploads widget's "Only this session" filter reads it.

Names are unique within the project dir. Two sessions uploading
``report.pdf`` get ``report.pdf`` and ``report-2.pdf`` — the old per-session
layout never collided, so the old upload route simply overwrote; sharing a
directory makes de-duplication mandatory.

**Legacy migration is by hardlink, not move.** ``migrate_legacy()`` links
every file still in a ``sessions/{id}/uploads/`` dir into the project dir and
records ``legacy: "{id}/{name}"`` in the index so it is linked only once. The
originals stay where they were, because (a) transcripts carry absolute
``Uploaded file: …/sessions/{id}/uploads/x`` paths Claude may re-read on
resume, and (b) an older server build sharing the same data home (the
stable tier on a dev box) still serves from the session dirs. A hardlink
costs no space and both paths are ordinary files, so neither breaks.
Caveat: deleting a migrated file from the project dir does not reclaim its
space until the session-dir link is removed too. If linking fails (a
filesystem without hardlinks), the file is left in place and listed from its
legacy location instead.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Optional

from painapple_code import paths
from painapple_code.utils.file_lock import FileLock

logger = logging.getLogger("painapple-code.uploads")

INDEX_NAME = ".index.json"
LOCK_NAME = ".index.lock"
LEGACY_DIR_NAME = "uploads"

# ── Size limit (Settings → System → "Max upload size") ───────────────────────

UPLOAD_MAX_MB_KEY = "upload_max_mb"
DEFAULT_UPLOAD_MAX_MB = 128
MIN_UPLOAD_MAX_MB = 1
MAX_UPLOAD_MAX_MB = 4096


def get_upload_max_mb() -> int:
    """Configured per-upload cap in MiB (global config), clamped to range."""
    raw = paths.load_global_config().get(UPLOAD_MAX_MB_KEY, DEFAULT_UPLOAD_MAX_MB)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_UPLOAD_MAX_MB
    return min(max(value, MIN_UPLOAD_MAX_MB), MAX_UPLOAD_MAX_MB)


def get_upload_max_bytes() -> int:
    return get_upload_max_mb() * 1024 * 1024


# ── Layout ───────────────────────────────────────────────────────────────────

def project_uploads_dir(store, create: bool = True) -> Path:
    """``projects/{hash}/uploads/`` for the store's project.

    Derived from ``store.base_dir`` (``projects/{hash}/sessions``) rather than
    re-hashing ``store.project_path``, so it always sits beside the sessions
    the store actually reads.
    """
    d = Path(store.base_dir).parent / "uploads"
    if create:
        d.mkdir(parents=True, exist_ok=True)
    return d


def _is_listable(p: Path) -> bool:
    return not p.name.startswith(".") and p.is_file()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _load_index(d: Path) -> dict:
    try:
        data = json.loads((d / INDEX_NAME).read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("files"), dict):
            return data
    except FileNotFoundError:
        pass
    except Exception as e:  # corrupt index: rebuildable metadata, not data
        logger.warning(f"Unreadable uploads index in {d}: {e}")
    return {"version": 1, "files": {}}


def _save_index(d: Path, index: dict) -> None:
    tmp = d / (INDEX_NAME + ".tmp")
    tmp.write_text(json.dumps(index, indent=1), encoding="utf-8")
    os.replace(tmp, d / INDEX_NAME)


def _lock(d: Path) -> FileLock:
    return FileLock(d / LOCK_NAME)


def _unique_name(d: Path, name: str, index: dict) -> str:
    """``name`` if free, else ``stem-2.ext``, ``stem-3.ext``, …"""
    taken = index["files"]
    if name not in taken and not (d / name).exists():
        return name
    pp = PurePosixPath(name)
    stem, ext = pp.stem, pp.suffix
    n = 2
    while True:
        candidate = f"{stem}-{n}{ext}"
        if candidate not in taken and not (d / candidate).exists():
            return candidate
        n += 1


# ── Writes ───────────────────────────────────────────────────────────────────

def reserve(store, session_id: Optional[str], name: str,
            original_name: Optional[str] = None) -> Path:
    """Claim a unique filename in the project dir and record its owner.

    Creates the file empty (exclusive create) under the index lock so two
    concurrent uploads of the same name can't both pick it. The caller then
    writes the content and calls ``finalize()`` — or ``discard()`` on error.
    """
    d = project_uploads_dir(store)
    with _lock(d):
        index = _load_index(d)
        stored = _unique_name(d, name, index)
        path = d / stored
        with open(path, "xb"):
            pass
        index["files"][stored] = {
            "session_id": session_id,
            "original_name": original_name or name,
            "uploaded_at": _now(),
        }
        _save_index(d, index)
    return path


def finalize(path: Path, size: int, sha256: Optional[str] = None) -> None:
    """Record size (and optionally a content hash) for a reserved upload."""
    d = path.parent
    with _lock(d):
        index = _load_index(d)
        entry = index["files"].get(path.name)
        if entry is not None:
            entry["size"] = size
            if sha256:
                entry["sha256"] = sha256
            _save_index(d, index)


def discard(path: Path) -> None:
    """Undo a ``reserve()``: remove the file and its index entry."""
    d = path.parent
    try:
        path.unlink(missing_ok=True)
    except OSError as e:
        logger.warning(f"Could not remove partial upload {path}: {e}")
    with _lock(d):
        index = _load_index(d)
        if index["files"].pop(path.name, None) is not None:
            _save_index(d, index)


def write_bytes(store, session_id: Optional[str], name: str, data: bytes,
                original_name: Optional[str] = None,
                record_hash: bool = False) -> Path:
    """Reserve + write + finalize in one call (for small in-memory payloads)."""
    path = reserve(store, session_id, name, original_name)
    try:
        path.write_bytes(data)
    except Exception:
        discard(path)
        raise
    finalize(path, len(data), hashlib.sha256(data).hexdigest() if record_hash else None)
    return path


def find_by_hash(store, session_id: str, sha256: str) -> Optional[str]:
    """Stored name of an upload this session already made with these bytes.

    An image goes through ``/api/upload-image`` (stored once) and is then
    sent inline as base64 with the prompt, which the chat handler used to
    store a SECOND time under a new name. Matching on the hash lets it reuse
    the first copy.
    """
    d = project_uploads_dir(store, create=False)
    if not d.exists():
        return None
    index = _load_index(d)
    for name, entry in index["files"].items():
        if (entry.get("sha256") == sha256 and entry.get("session_id") == session_id
                and (d / name).is_file()):
            return name
    return None


# ── Legacy per-session dirs ──────────────────────────────────────────────────

def _legacy_dirs(store):
    """Yield ``(session_id, uploads_dir)`` for sessions with a legacy dir."""
    base = Path(store.base_dir)
    if not base.exists():
        return
    for sess_dir in base.iterdir():
        up = sess_dir / LEGACY_DIR_NAME
        if up.is_dir():
            yield sess_dir.name, up


def migrate_legacy(store) -> int:
    """Hardlink legacy ``sessions/{id}/uploads/*`` files into the project dir.

    Idempotent: every linked file is recorded as ``legacy: "{id}/{name}"``
    and skipped on later runs. Returns the number of files linked now.
    Cheap when there is nothing to do (one ``iterdir`` per session dir) and
    safe to call on every listing — an older server build sharing the data
    home may still be writing to the legacy dirs.
    """
    pending = []
    for sid, up in _legacy_dirs(store):
        for f in up.iterdir():
            if _is_listable(f):
                pending.append((sid, f))
    if not pending:
        return 0

    d = project_uploads_dir(store)
    linked = 0
    with _lock(d):
        index = _load_index(d)
        done = {e.get("legacy") for e in index["files"].values() if e.get("legacy")}
        for sid, f in pending:
            key = f"{sid}/{f.name}"
            if key in done:
                continue
            stored = _unique_name(d, f.name, index)
            try:
                os.link(f, d / stored)
            except OSError as e:
                # No hardlinks here (FAT, some network mounts, cross-device):
                # leave it in place — list_uploads() still shows it.
                logger.warning(f"Upload migration: could not link {f}: {e}")
                continue
            st = f.stat()
            index["files"][stored] = {
                "session_id": sid,
                "original_name": f.name,
                "uploaded_at": datetime.fromtimestamp(st.st_mtime, timezone.utc)
                                .isoformat().replace("+00:00", "Z"),
                "size": st.st_size,
                "legacy": key,
            }
            done.add(key)
            linked += 1
        if linked:
            _save_index(d, index)
    if linked:
        logger.info(f"Upload migration: linked {linked} legacy file(s) into {d}")
    return linked


def migrate_all_projects() -> int:
    """Run ``migrate_legacy`` over every known project (startup sweep)."""
    from painapple_code.session_store import SessionStore
    total = 0
    for info in paths.list_projects(include_unreachable=True):
        try:
            total += migrate_legacy(SessionStore._get_store(info["path"]))
        except Exception as e:
            logger.warning(f"Upload migration failed for {info.get('path')}: {e}")
    return total


# ── Reads ────────────────────────────────────────────────────────────────────

def list_uploads(store, session_id: Optional[str] = None) -> list[tuple[Path, Optional[str]]]:
    """``(path, owning_session_id)`` for every upload in the project.

    ``session_id`` filters to one session's uploads. Files a failed migration
    left in a legacy dir are included from there, so nothing goes missing.
    """
    migrate_legacy(store)
    d = project_uploads_dir(store, create=False)
    out: list[tuple[Path, Optional[str]]] = []
    linked_legacy: set[str] = set()
    if d.exists():
        index = _load_index(d)
        files = index["files"]
        linked_legacy = {e.get("legacy") for e in files.values() if e.get("legacy")}
        for f in d.iterdir():
            if not _is_listable(f):
                continue
            owner = (files.get(f.name) or {}).get("session_id")
            if session_id is None or owner == session_id:
                out.append((f, owner))
    for sid, up in _legacy_dirs(store):
        if session_id is not None and sid != session_id:
            continue
        for f in up.iterdir():
            if _is_listable(f) and f"{sid}/{f.name}" not in linked_legacy:
                out.append((f, sid))
    return out


def resolve_upload(store, session_id: str, filename: str) -> Optional[Path]:
    """Locate ``filename`` for a ``/api/sessions/{id}/uploads/{filename}`` URL.

    The session's legacy dir wins (old messages name the file exactly as it
    was stored there, and a de-duplicated project copy may carry a ``-2``
    suffix), then the project dir. Returns None for a miss OR a traversal
    attempt; the caller maps that to 404/403 via ``is_traversal``.
    """
    candidates = [
        Path(store.base_dir) / session_id / LEGACY_DIR_NAME,
        project_uploads_dir(store, create=False),
    ]
    for base in candidates:
        p = (base / filename).resolve()
        if not p.is_relative_to(base.resolve()):
            continue
        if p.name.startswith("."):
            continue
        if p.is_file():
            return p
    return None


def is_traversal(store, filename: str) -> bool:
    """True when ``filename`` escapes the uploads dir (→ 403, not 404)."""
    base = project_uploads_dir(store, create=False)
    return not (base / filename).resolve().is_relative_to(base.resolve())
