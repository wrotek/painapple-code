"""Project-level upload storage + configurable size cap.

Uploads moved from ``sessions/{id}/uploads/`` to ``projects/{hash}/uploads/``
with an index for session attribution; the 10 MB file cap became a setting
(default 128 MB). Everything here runs against a fake store in tmp_path and
a monkeypatched global config — the real data home is never touched.
"""

import io
import json
import os

import pytest

from painapple_code import paths, uploads_store
from painapple_code.routes import api_upload
from painapple_code.routes.dependencies import get_session_store


class _Store:
    def __init__(self, root):
        self.base_dir = root / "sessions"
        self.base_dir.mkdir(parents=True, exist_ok=True)


@pytest.fixture
def config(monkeypatch):
    cfg = {}
    monkeypatch.setattr(paths, "load_global_config", lambda: dict(cfg))
    monkeypatch.setattr(paths, "save_global_config", lambda c: (cfg.clear(), cfg.update(c)))
    return cfg


@pytest.fixture
def store(tmp_path):
    return _Store(tmp_path / "proj")


@pytest.fixture
def wired(app, store, monkeypatch, config):
    """Point both upload routes and the uploads list/serve routes at `store`."""
    monkeypatch.setattr(api_upload, "_session_store", lambda s: store if s else None)
    app.dependency_overrides[get_session_store] = lambda: store
    yield store
    app.dependency_overrides.clear()


# ── size cap ─────────────────────────────────────────────────────────────────

def test_default_cap_is_128mb(config):
    assert uploads_store.get_upload_max_mb() == 128
    assert uploads_store.get_upload_max_bytes() == 128 * 1024 * 1024


@pytest.mark.parametrize("raw,expected", [(0, 1), (99999, 4096), ("junk", 128), (64, 64)])
def test_cap_is_clamped_and_tolerant(config, raw, expected):
    config["upload_max_mb"] = raw
    assert uploads_store.get_upload_max_mb() == expected


def test_settings_endpoint_roundtrip(client, config):
    assert client.get("/api/app/upload-max-mb").json()["upload_max_mb"] == 128
    r = client.put("/api/app/upload-max-mb", json={"upload_max_mb": 256})
    assert r.status_code == 200 and r.json()["upload_max_mb"] == 256
    assert config["upload_max_mb"] == 256
    # Setting the default drops the key rather than pinning it.
    client.put("/api/app/upload-max-mb", json={"upload_max_mb": 128})
    assert "upload_max_mb" not in config
    assert client.put("/api/app/upload-max-mb", json={"upload_max_mb": 0}).status_code == 400
    assert client.put("/api/app/upload-max-mb", json={"upload_max_mb": "x"}).status_code == 400


def test_12mb_file_now_accepted(client, wired):
    data = os.urandom(12 * 1024 * 1024)
    r = client.post("/api/upload-file?session=s1",
                    files={"file": ("big.bin", io.BytesIO(data), "application/octet-stream")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["size"] == len(data)
    stored = uploads_store.project_uploads_dir(wired) / body["stored_name"]
    assert stored.read_bytes() == data


def test_over_cap_is_413_and_leaves_nothing(client, wired, config):
    config["upload_max_mb"] = 1
    r = client.post("/api/upload-file?session=s1",
                    files={"file": ("big.bin", io.BytesIO(b"x" * (1024 * 1024 + 1)), "application/octet-stream")})
    assert r.status_code == 413
    assert "1 MB" in r.json()["detail"]
    d = uploads_store.project_uploads_dir(wired)
    assert [p.name for p in d.iterdir() if not p.name.startswith(".")] == []
    assert uploads_store._load_index(d)["files"] == {}


def test_empty_file_rejected_and_cleaned(client, wired):
    r = client.post("/api/upload-file?session=s1",
                    files={"file": ("e.txt", io.BytesIO(b""), "text/plain")})
    assert r.status_code == 400
    assert not (uploads_store.project_uploads_dir(wired) / "e.txt").exists()


# ── project dir + attribution ────────────────────────────────────────────────

def _upload(client, session, name, data=b"hello"):
    r = client.post(f"/api/upload-file?session={session}",
                    files={"file": (name, io.BytesIO(data), "text/plain")})
    assert r.status_code == 200, r.text
    return r.json()


def test_files_land_in_project_dir_deduplicated(client, wired):
    a = _upload(client, "s1", "report.txt", b"one")
    b = _upload(client, "s2", "report.txt", b"two")
    assert a["stored_name"] == "report.txt"
    assert b["stored_name"] == "report-2.txt"
    d = uploads_store.project_uploads_dir(wired)
    assert (d / "report.txt").read_bytes() == b"one"
    assert (d / "report-2.txt").read_bytes() == b"two"
    # Nothing written under the session dirs any more.
    assert not any(wired.base_dir.rglob("report*"))


def test_listing_scopes(client, wired):
    _upload(client, "s1", "a.txt")
    _upload(client, "s2", "b.txt")
    mine = client.get("/api/sessions/s1/uploads?scope=session").json()
    assert [f["name"] for f in mine["files"]] == ["a.txt"]
    assert mine["dir"].endswith("uploads")
    proj = client.get("/api/sessions/s1/uploads?scope=project").json()
    assert sorted((f["name"], f["session_id"]) for f in proj["files"]) == [("a.txt", "s1"), ("b.txt", "s2")]
    # Index/lock files never show up as uploads.
    assert all(not f["name"].startswith(".") for f in proj["files"])


def test_serve_from_project_dir_and_block_traversal(client, wired):
    _upload(client, "s1", "a.txt", b"content")
    # Any session of the project can address the file.
    assert client.get("/api/sessions/s2/uploads/a.txt").content == b"content"
    assert client.get("/api/sessions/s1/uploads/nope.txt").status_code == 404
    assert client.get("/api/sessions/s1/uploads/.index.json").status_code == 404
    assert client.get("/api/sessions/s1/uploads/..%2F..%2Fsecret").status_code in (403, 404)


# ── legacy migration ─────────────────────────────────────────────────────────

def _legacy(store, sid, name, data):
    d = store.base_dir / sid / "uploads"
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_bytes(data)
    return d / name


def test_migration_hardlinks_without_moving(store, config):
    old_a = _legacy(store, "s1", "doc.pdf", b"A")
    old_b = _legacy(store, "s2", "doc.pdf", b"B")
    assert uploads_store.migrate_legacy(store) == 2
    d = uploads_store.project_uploads_dir(store)
    by_owner = {e["session_id"]: n for n, e in uploads_store._load_index(d)["files"].items()}
    assert (d / by_owner["s1"]).read_bytes() == b"A"
    assert (d / by_owner["s2"]).read_bytes() == b"B"
    # Originals untouched (old transcripts + older server builds rely on them)
    # and the project copy is the same inode, not a duplicate.
    assert old_a.read_bytes() == b"A" and old_b.exists()
    assert os.path.samefile(old_a, d / by_owner["s1"])
    # Idempotent.
    assert uploads_store.migrate_legacy(store) == 0


def test_migrated_files_listed_once(store, config):
    _legacy(store, "s1", "x.txt", b"1")
    rows = uploads_store.list_uploads(store)
    assert len(rows) == 1 and rows[0][1] == "s1"


def test_legacy_url_prefers_session_copy(store, config):
    """Old messages reference `/sessions/s2/uploads/doc.pdf`; after migration
    s2's copy is stored as doc-2.pdf, so the legacy dir must win."""
    _legacy(store, "s1", "doc.pdf", b"A")
    _legacy(store, "s2", "doc.pdf", b"B")
    uploads_store.migrate_legacy(store)
    assert uploads_store.resolve_upload(store, "s2", "doc.pdf").read_bytes() == b"B"
    assert uploads_store.resolve_upload(store, "s1", "doc.pdf").read_bytes() == b"A"


def test_unlinkable_file_still_listed(store, config, monkeypatch):
    _legacy(store, "s1", "x.txt", b"1")

    def no_link(*a, **k):
        raise OSError("no hardlinks here")
    monkeypatch.setattr(uploads_store.os, "link", no_link)
    rows = uploads_store.list_uploads(store, "s1")
    assert [(p.name, sid) for p, sid in rows] == [("x.txt", "s1")]


# ── image de-duplication ─────────────────────────────────────────────────────

def test_find_by_hash_matches_same_session_only(store, config):
    import hashlib
    data = b"\x89PNG fake"
    uploads_store.write_bytes(store, "s1", "img_1.png", data, record_hash=True)
    digest = hashlib.sha256(data).hexdigest()
    assert uploads_store.find_by_hash(store, "s1", digest) == "img_1.png"
    assert uploads_store.find_by_hash(store, "s2", digest) is None


def test_index_survives_corruption(store, config):
    d = uploads_store.project_uploads_dir(store)
    (d / uploads_store.INDEX_NAME).write_text("{not json")
    p = uploads_store.write_bytes(store, "s1", "a.txt", b"x")
    assert json.loads((d / uploads_store.INDEX_NAME).read_text())["files"][p.name]["session_id"] == "s1"
