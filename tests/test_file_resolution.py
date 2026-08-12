"""Unit tests for the ranked, context-aware file resolver in utils/file_paths.py.

Covers the fuzzy-search fix: dependency/build dirs (node_modules & co.) are
pruned from the walk, matches rank shallowest-first with mtime tie-breaks,
and context hint dirs override every heuristic tier — including reaching
inside ignored dirs when explicitly hinted.

Regression anchor: right-clicking `index.md` in a terminal `ll docs-ai/readme/`
listing used to resolve to tools/node_modules/napi-build-utils/index.md
(first rglob match) instead of docs-ai/readme/index.md.
"""

import os
import time

from painapple_code.utils.file_paths import (
    resolve_project_files,
    verify_file_paths,
)


def make(root, rel, mtime=None):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("x")
    if mtime is not None:
        os.utime(p, (mtime, mtime))
    return p


def resolve_one(name, cwd, hints=()):
    return resolve_project_files([name], str(cwd), hints)[name]


def test_ignored_dirs_pruned(tmp_path):
    """The original bug: node_modules copy must never beat a real project file."""
    make(tmp_path, "tools/node_modules/napi-build-utils/index.md")
    real = make(tmp_path, "docs-ai/readme/index.md")
    assert resolve_one("index.md", tmp_path) == str(real)


def test_ignored_dirs_are_last_resort(tmp_path):
    """A file that exists ONLY inside an ignored tree still resolves —
    at the lowest priority (unpruned fallback walk)."""
    inside = make(tmp_path, "tools/node_modules/pkg/index.md")
    assert resolve_one("index.md", tmp_path) == str(inside)


def test_fallback_never_beats_project_file(tmp_path):
    """Even a deeper real project file beats any ignored-tree match."""
    make(tmp_path, "node_modules/pkg/readme-x.md")
    real = make(tmp_path, "a/b/c/readme-x.md")
    assert resolve_one("readme-x.md", tmp_path) == str(real)


def test_hint_reaches_ignored_dir(tmp_path):
    """Hints are direct checks — they resolve inside pruned trees."""
    inside = make(tmp_path, "tools/node_modules/pkg/index.md")
    assert resolve_one("index.md", tmp_path, hints=["tools/node_modules/pkg"]) == str(inside)


def test_depth_ranking(tmp_path):
    shallow = make(tmp_path, "aaa/x.md")
    make(tmp_path, "aaa/bbb/ccc/x.md")
    assert resolve_one("x.md", tmp_path) == str(shallow)


def test_mtime_tiebreak_not_alphabetical(tmp_path):
    now = time.time()
    make(tmp_path, "aaa/x.md", mtime=now - 5000)
    newer = make(tmp_path, "zzz/x.md", mtime=now)
    assert resolve_one("x.md", tmp_path) == str(newer)


def test_common_subdir_priority_over_walk(tmp_path):
    """COMMON_SUBDIRS keep their priority over ranked-walk results."""
    now = time.time()
    preferred = make(tmp_path, "src/app.js", mtime=now - 5000)
    make(tmp_path, "zzz/app.js", mtime=now)
    assert resolve_one("app.js", tmp_path) == str(preferred)


def test_hint_beats_common_subdirs_and_ranking(tmp_path):
    """Observed context outranks priors: hint dir wins over a shallower
    match in a COMMON_SUBDIRS dir."""
    make(tmp_path, "docs/index.md")
    hinted = make(tmp_path, "docs-ai/readme/index.md")
    assert resolve_one("index.md", tmp_path, hints=["docs-ai/readme"]) == str(hinted)


def test_exact_match_beats_hint(tmp_path):
    exact = make(tmp_path, "index.md")
    make(tmp_path, "docs-ai/readme/index.md")
    assert resolve_one("index.md", tmp_path, hints=["docs-ai/readme"]) == str(exact)


def test_slashed_name_resolves_via_hint(tmp_path):
    target = make(tmp_path, "docs-ai/readme/index.md")
    assert resolve_one("readme/index.md", tmp_path, hints=["docs-ai"]) == str(target)


def test_slashed_name_never_fuzzy_searched(tmp_path):
    make(tmp_path, "docs-ai/readme/index.md")
    assert resolve_one("nope/index.md", tmp_path) is None


def test_junk_hints_ignored(tmp_path):
    real = make(tmp_path, "docs-ai/readme/index.md")
    hints = ["", ".", "..", "~", "~/d/abbreviated", "https:/malformed.example", "no-such-dir"]
    assert resolve_one("index.md", tmp_path, hints=hints) == str(real)


def test_absolute_name_passthrough(tmp_path):
    target = make(tmp_path, "somewhere/deep/file.txt")
    assert resolve_one(str(target), tmp_path) == str(target)
    assert resolve_one(str(tmp_path / "missing.txt"), tmp_path) is None


def test_depth_limit_respected(tmp_path):
    make(tmp_path, "a/b/c/d/e/too-deep.md")  # 5 dirs below base — beyond limit
    in_range = make(tmp_path, "a/b/c/d/found.md")  # 4 dirs — at the limit
    assert resolve_one("too-deep.md", tmp_path) is None
    assert resolve_one("found.md", tmp_path) == str(in_range)


def test_verify_file_paths_batch(tmp_path):
    real = make(tmp_path, "docs-ai/readme/index.md")
    make(tmp_path, "tools/node_modules/pkg/index.md")
    exact = make(tmp_path, "server.py")
    results = verify_file_paths({"index.md", "server.py", "ghost.py"}, str(tmp_path))
    assert results["index.md"] == str(real)
    assert results["server.py"] == str(exact)
    assert results["ghost.py"] is None


def test_no_cwd_returns_none(tmp_path):
    assert verify_file_paths({"index.md"}, "") == {"index.md": None}
    assert resolve_one("index.md", tmp_path / "does-not-exist") is None
