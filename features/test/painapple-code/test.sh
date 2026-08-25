#!/usr/bin/env bash
#
# Smoke test for the painapple-code Dev Container Feature.
# Runs inside the test container that `devcontainer features test` builds.
#
# The dev-container-features-test-lib provides `check`, an assertion helper
# that records pass/fail to be reported by the runner. Format:
#   check "<label>" <command...>
# A non-zero exit from the command marks the check as failed.

set -e

# shellcheck source=/dev/null
source dev-container-features-test-lib

# --- 1. Artifacts on disk -------------------------------------------------
check "source-cloned"        test -f /opt/painapple-code/src/painapple_code/server.py
check "requirements-present" test -f /opt/painapple-code/requirements.txt
check "venv-created"         test -x /opt/painapple-code/venv/bin/python
# pyproject sets requires-python >=3.12. Debian bookworm ships 3.11, so on
# that base install.sh has to source a newer interpreter — assert it did.
check "venv-python-supported" /opt/painapple-code/venv/bin/python -c \
    "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)"
check "launcher-installed"   test -x /usr/local/bin/painapple-code-start
check "autostart-hook"       test -f /etc/profile.d/painapple-code.sh

# --- 2. External tools the server spawns ----------------------------------
check "node-on-path"   command -v node
check "claude-on-path" command -v claude
check "git-on-path"    command -v git
check "fd-on-path"     command -v fd
check "rg-on-path"     command -v rg

# --- 3. Python deps actually installed ------------------------------------
check "fastapi-importable" /opt/painapple-code/venv/bin/python -c "import fastapi"
check "uvicorn-importable" /opt/painapple-code/venv/bin/python -c "import uvicorn"

# --- 4. server.py at least parses (catches syntax-level regressions) ------
check "server-py-imports" /opt/painapple-code/venv/bin/python -c "
import ast, pathlib
ast.parse(pathlib.Path('/opt/painapple-code/src/painapple_code/server.py').read_text())
"

# --- 5. Launcher creates its state dir and starts the server --------------
# State lives under $PAINAPPLE_CODE_HOME (default ~/.painapple-code, or
# /workspaces/.painapple-code in Codespaces) — the launcher mkdir -p's it at
# run time; install.sh deliberately creates no system-wide path. Point it at
# a scratch dir so the check doesn't depend on which user the harness runs as.
# Run in a subshell so a failure here doesn't kill the whole test script
# before reportResults() gets called.
check "launcher-runs" bash -c '
    export PAINAPPLE_CODE_HOME=/tmp/painapple-state
    PAINAPPLE_WORKSPACE=/tmp painapple-code-start
    sleep 2
    # State dir + PID file should now exist, pointing at a live process
    test -d "$PAINAPPLE_CODE_HOME"
    test -f "$PAINAPPLE_CODE_HOME/launcher.pid"
    kill -0 "$(cat "$PAINAPPLE_CODE_HOME/launcher.pid")"
'

# --- 6. Server actually serves on the configured port ---------------------
check "server-responds" bash -c '
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        if curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:8765/health \
            | grep -qE "^(200|401|403)$"; then
            exit 0
        fi
        sleep 1
    done
    exit 1
'

# Report results — required closer for the test framework.
reportResults
