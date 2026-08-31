"""Workspace project mode: --project/--no-project + .git auto-detect.

Pure-function tests — no running server needed (unlike test_sessions.py).
"""

import pytest

from painapple_code.paths import resolve_workspace_is_project
from painapple_code.routes.api_session_welcome import _root_as_workspace_entry


# ─── resolve_workspace_is_project ────────────────────────────────────────────

def test_forced_project(tmp_path):
    is_project, reason = resolve_workspace_is_project(str(tmp_path), True)
    assert is_project is True
    assert "--project" in reason


def test_forced_no_project_beats_git(tmp_path):
    (tmp_path / ".git").mkdir()
    is_project, reason = resolve_workspace_is_project(str(tmp_path), False)
    assert is_project is False
    assert "--no-project" in reason


def test_auto_detect_git_dir(tmp_path):
    (tmp_path / ".git").mkdir()
    is_project, reason = resolve_workspace_is_project(str(tmp_path), None)
    assert is_project is True
    assert reason == "found .git"


def test_auto_detect_git_worktree_file(tmp_path):
    # A git worktree has a .git FILE pointing at the main repo.
    (tmp_path / ".git").write_text("gitdir: /somewhere/else/.git/worktrees/x\n")
    is_project, _ = resolve_workspace_is_project(str(tmp_path), None)
    assert is_project is True


def test_auto_detect_no_git(tmp_path):
    (tmp_path / "some-repo").mkdir()
    is_project, reason = resolve_workspace_is_project(str(tmp_path), None)
    assert is_project is False
    assert reason == "no .git"


def test_auto_detect_ignores_other_manifests(tmp_path):
    # A wrapper dir with a stray requirements.txt must NOT flip to
    # project mode — auto-detect keys on .git only.
    (tmp_path / "requirements.txt").write_text("fastapi\n")
    is_project, _ = resolve_workspace_is_project(str(tmp_path), None)
    assert is_project is False


# ─── _root_as_workspace_entry ────────────────────────────────────────────────

def test_untracked_root_is_single_chip(tmp_path):
    entries = _root_as_workspace_entry(str(tmp_path), projects=[])
    assert len(entries) == 1
    e = entries[0]
    assert e["path"] == str(tmp_path)
    assert e["name"] == tmp_path.name
    assert e["looks_like_project"] is True
    assert isinstance(e["mtime"], float)


def test_tracked_root_yields_no_chip(tmp_path):
    projects = [{"path": str(tmp_path)}]
    assert _root_as_workspace_entry(str(tmp_path), projects) == []


def test_missing_root_yields_no_chip(tmp_path):
    gone = tmp_path / "deleted"
    assert _root_as_workspace_entry(str(gone), projects=[]) == []


# ─── CLI flag parses ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("argv,expected", [
    ([], None),
    (["--project"], True),
    (["--no-project"], False),
])
def test_serve_flag_parses(argv, expected):
    from painapple_code.cli.serve_args import build_parser
    args = build_parser().parse_args(argv)
    assert args.project is expected
