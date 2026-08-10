"""One server must present as ONE row, even when it is a process chain.

A pipx console script on Windows is three processes — the painapple.exe
launcher, the python.exe it starts, and uvicorn's reload child — and all
three carry identical argv, so the process scan matches all three. That
showed up two ways: phantom rows in `painapple list`, and an ambiguous
`painapple stop` (lifecycle_cmd._kill terminates a single pid, so the
reload child gets respawned by its supervisor while the launcher leaves
the real server serving).

These cases can't be reproduced on Linux — there is exactly one process
per server there, which is also why the collapse must be a strict no-op
on POSIX. Both properties are asserted below.
"""

import pytest

from painapple_code.cli import list_cmd


def _row(pid, port="8765", home="/h", workspace="/proj"):
    return {
        "pid": pid, "port": port, "home": home, "workspace": workspace,
        "name": "", "host": "127.0.0.1", "argv": [], "command": "",
    }


@pytest.fixture
def fake_tree(monkeypatch):
    """Install a synthetic pid->ppid map behind _matched_ancestor."""
    def install(tree):
        def matched_ancestor(pid, by_pid):
            seen = {pid}
            cur = pid
            while True:
                parent = tree.get(cur)
                if not parent or parent in seen:
                    return None
                if parent in by_pid:
                    return parent
                seen.add(parent)
                cur = parent
        monkeypatch.setattr(list_cmd, "_matched_ancestor", matched_ancestor)
    return install


def test_pipx_chain_collapses_to_the_launcher(fake_tree):
    """launcher -> python -> reload child becomes one row: the launcher.

    Terminating the topmost ancestor is the only choice that takes the
    whole chain with it.
    """
    rows = [_row(100), _row(200), _row(300)]
    fake_tree({200: 100, 300: 200})

    out = list_cmd._collapse_chains(rows)

    assert [r["pid"] for r in out] == [100]


def test_workspace_comes_from_the_serving_process_not_the_shim(fake_tree):
    """The launcher's cwd is %TEMP%; the workspace must not be reported
    from it. This is the bug that made a port conflict blame a directory
    the user had never heard of."""
    rows = [
        _row(100, workspace=r"C:\Users\w\AppData\Local\Temp"),
        _row(200, workspace=r"C:\Users\w\proj"),
        _row(300, workspace=r"C:\Users\w\proj"),
    ]
    fake_tree({200: 100, 300: 200})

    out = list_cmd._collapse_chains(rows)

    assert len(out) == 1
    assert out[0]["pid"] == 100          # still the ancestor…
    assert out[0]["workspace"] == r"C:\Users\w\proj"   # …but the real cwd


def test_nested_but_different_server_is_not_swallowed(fake_tree):
    """A second server started from a terminal inside the first is a
    separate deployment — different port — and keeps its own row."""
    rows = [_row(100), _row(200), _row(400, port="8890", home="/h2")]
    fake_tree({200: 100, 400: 200})

    out = list_cmd._collapse_chains(rows)

    assert sorted(r["pid"] for r in out) == [100, 400]


def test_same_port_different_home_is_not_collapsed(fake_tree):
    """Agreeing on port alone is not enough — a different data home is a
    different deployment."""
    rows = [_row(100, home="/h1"), _row(200, home="/h2")]
    fake_tree({200: 100})

    out = list_cmd._collapse_chains(rows)

    assert sorted(r["pid"] for r in out) == [100, 200]


def test_no_chain_is_a_strict_no_op(fake_tree):
    """The POSIX case: unrelated servers, no parent/child relationship."""
    rows = [_row(1, port="8765"), _row(2, port="8855", home="/h2"),
            _row(3, port="8880", home="/h3")]
    fake_tree({})

    out = list_cmd._collapse_chains(rows)

    assert out == rows


def test_cycle_in_the_pid_map_terminates():
    """_matched_ancestor walks a live process table that can race; a
    cycle or a vanished pid must return None, never spin."""
    assert list_cmd._matched_ancestor(-1, {}) is None


def test_live_scan_has_no_self_parented_rows():
    """Guard against the collapse eating real rows on the host running
    the suite: every surviving row's parent must not be another row."""
    rows = list_cmd.local_servers()
    by_pid = {r["pid"] for r in rows}
    for r in rows:
        anc = list_cmd._matched_ancestor(r["pid"], by_pid)
        assert anc is None, f"row {r['pid']} still has matched ancestor {anc}"
