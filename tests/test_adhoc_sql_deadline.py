"""Ad-hoc SQL must not be able to wedge the bridge.

`/api/shadow-db/sql` is the one query path where the caller writes the SQL, and
CLAUDE.md teaches it to humans and agents alike as the normal way to query. A
`WITH RECURSIVE` typo is a plain SELECT, so it sails past the endpoint's
mutation-keyword validator and then runs forever.

Measured before the fix: one such query froze the event loop (`/health`, which
touches neither auth nor the DB, went unanswered for 2+ minutes), the client
hanging up did not cancel it, and `pkill` — the documented restart — could not
kill the process because uvicorn's graceful shutdown waits on the in-flight
request. Recovery required `kill -9`.

Two mechanisms have to hold for that to stay fixed, and each was independently
insufficient in testing:

  * the query runs off the event loop (`asyncio.to_thread` at the route), and
  * it runs on a private cursor under a watchdog that can actually end it.

These tests cover the second, which is the part with no other safety net:
Python cannot kill a thread and DuckDB has no statement timeout, so if
`interrupt()` stops working there is nothing else to bound the query.
"""

import threading
import time

import duckdb
import pytest

from painapple_code.shadow_db import ShadowDB


# Unbounded by construction: a streaming aggregate over a recursive CTE. Runs
# for hours, allocates almost nothing (so `memory_limit` never trips it), and
# returns a single row (so any row cap is unreachable).
RUNAWAY_SQL = (
    "WITH RECURSIVE t(i) AS ("
    "  SELECT 1 UNION ALL SELECT i + 1 FROM t WHERE i < 300000000"
    ") SELECT count(*) FROM t"
)


@pytest.fixture
def db(tmp_path):
    return ShadowDB(db_path=tmp_path / "shadow-test.duckdb")


def test_runaway_query_is_interrupted_at_the_deadline(db):
    """The watchdog ends the query. Nothing else can."""
    started = time.monotonic()
    with pytest.raises(duckdb.InterruptException):
        db.fetch_columns_adhoc(RUNAWAY_SQL, timeout=1.5)
    elapsed = time.monotonic() - started

    # Generous upper bound: interrupt() is cooperative, so DuckDB ends the query
    # at its next check point rather than instantly. The assertion that matters
    # is that it ends at all, near the deadline rather than never.
    assert 1.0 < elapsed < 15.0, f"took {elapsed:.1f}s"


def test_ordinary_query_is_untouched_by_the_watchdog(db):
    """The deadline must be invisible to real queries — the timer is cancelled
    on the way out, not left to fire into a later query on the same cursor."""
    columns, rows = db.fetch_columns_adhoc("SELECT 42 AS answer", timeout=1.5)
    assert columns == ["answer"]
    assert rows == [(42,)]

    time.sleep(2.0)  # past the deadline the previous call armed
    columns, rows = db.fetch_columns_adhoc("SELECT 7 AS still_fine")
    assert rows == [(7,)]


def test_interrupt_does_not_poison_the_shared_connection(db):
    """The watchdog fires at a wall-clock deadline, so it can land just after
    its own query finished and the writer lock moved on. It must therefore be
    unable to reach anything but its own cursor — interrupting the shared
    connection would kill a turn write that happened to be running."""
    with pytest.raises(duckdb.InterruptException):
        db.fetch_columns_adhoc(RUNAWAY_SQL, timeout=1.5)

    # The connection every real write goes through is still usable.
    assert db._fetch_one("SELECT 1") == (1,)
    db._execute("CREATE TABLE canary (x INTEGER)")
    db._execute("INSERT INTO canary VALUES (99)")
    assert db._fetch_one("SELECT x FROM canary") == (99,)


def test_a_runaway_query_does_not_block_concurrent_reads(db):
    """A private cursor is what keeps a slow read off the writer lock. On the
    shared connection this second query waits behind the first — which is how
    turn recording stalled."""
    errors = []

    def runaway():
        try:
            db.fetch_columns_adhoc(RUNAWAY_SQL, timeout=10.0)
        except duckdb.InterruptException:
            pass
        except Exception as exc:  # pragma: no cover - diagnostic only
            errors.append(exc)

    hog = threading.Thread(target=runaway, daemon=True)
    hog.start()
    time.sleep(1.0)  # let it get going and take whatever it is going to take

    started = time.monotonic()
    assert db._fetch_one("SELECT 1") == (1,)
    elapsed = time.monotonic() - started

    assert elapsed < 5.0, f"concurrent read blocked for {elapsed:.1f}s"
    hog.join(timeout=20)
    assert not errors
