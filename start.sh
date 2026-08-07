#!/usr/bin/env bash
# Start pAInapple Code Server
#
# Self-bootstrapping: creates the venv and installs Python dependencies on
# first run, or when requirements.txt changes. Safe to run repeatedly.
set -e

cd "$(dirname "$0")"

show_help() {
  cat <<'EOF'
Usage: ./start.sh [OPTIONS] [SERVER-ARGS...]

Bootstraps the Python venv on first run, then launches the Painapple Code
bridge server. Unrecognised arguments are forwarded to
`python -m painapple_code`.

Script options (consumed by start.sh):
  -h, --help          Show this help (plus the server's own --help if the
                      venv is already bootstrapped) and exit. Skips the
                      install step, so it works even when pip is broken.
  --no-install        Skip the venv bootstrap step. Use when the install
                      fails and you just want to start with what's
                      already installed.
  --reinstall         Force `pip install -e .` regardless of the marker.
                      Use after a botched install or to refresh editable
                      metadata.

Environment variables:
  HTTP_HOST           Host to bind (default: 127.0.0.1).
  HTTP_PORT           Port to bind (default: 8765).

Examples:
  ./start.sh                                  # 127.0.0.1:8765
  HTTP_PORT=8880 ./start.sh                   # Pick port via env
  ./start.sh --instance-name DEV --accent orange
  ./start.sh --no-install                     # Skip bootstrap
  ./start.sh --reinstall                      # Force fresh install

Common server flags (forwarded to python -m painapple_code):
  --host HOST         Override HTTP_HOST.
  --port PORT         Override HTTP_PORT.
  --workspace PATH    Working directory for Claude (default: .).
  --instance-name S   Label shown in the UI header.
  --accent COLOR      UI accent color (e.g. orange).
  --shadow-db PATH    Override DuckDB location.
  --log-dir PATH      Override log directory.
  --auth-config-file PATH    Use a different auth/config file.
  --tls auto|on|off   TLS mode (default: auto).

For the full list of server flags, run:
  ./start.sh --help        (if venv is bootstrapped)
  ./start.sh --no-install --help
EOF
}

# Parse script-level flags. Everything else is forwarded to python.
NO_INSTALL=0
FORCE_REINSTALL=0
HELP_REQUESTED=0
FORWARD_ARGS=()

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      HELP_REQUESTED=1
      ;;
    --no-install)
      NO_INSTALL=1
      ;;
    --reinstall)
      FORCE_REINSTALL=1
      ;;
    *)
      FORWARD_ARGS+=("$arg")
      ;;
  esac
done

# --help short-circuit: never touch pip, never touch the venv layout.
if [ "$HELP_REQUESTED" -eq 1 ]; then
  show_help
  if [ -x venv/bin/python ]; then
    echo
    echo "--- python -m painapple_code --help ---"
    exec venv/bin/python -m painapple_code --help
  else
    echo
    echo "(Server-side --help unavailable: run ./start.sh once to bootstrap the venv.)"
    exit 0
  fi
fi

VENV_MARKER="venv/.deps-installed"

if [ ! -d venv ] && [ "$NO_INSTALL" -eq 0 ]; then
  echo "Creating venv..."
  python3 -m venv venv
fi

NEEDS_INSTALL=0
if [ ! -f "$VENV_MARKER" ] || [ requirements.txt -nt "$VENV_MARKER" ] || [ pyproject.toml -nt "$VENV_MARKER" ]; then
  NEEDS_INSTALL=1
fi
if [ "$FORCE_REINSTALL" -eq 1 ]; then
  NEEDS_INSTALL=1
fi
if [ "$NO_INSTALL" -eq 1 ]; then
  if [ "$FORCE_REINSTALL" -eq 1 ]; then
    echo "ERROR: --no-install and --reinstall are mutually exclusive." >&2
    exit 2
  fi
  NEEDS_INSTALL=0
fi

if [ "$NEEDS_INSTALL" -eq 1 ]; then
  echo "Installing Python dependencies into venv..."
  venv/bin/pip install -e .
  touch "$VENV_MARKER"
fi

# Vendor bundles (CodeMirror, xterm) are committed to the repo, so a fresh
# clone has them. A missing file means something's wrong with the checkout.
VENDOR_DIR=src/painapple_code/static/vendor
if [ ! -f "$VENDOR_DIR/codemirror.js" ] || [ ! -f "$VENDOR_DIR/xterm.js" ]; then
  echo "ERROR: vendor bundles missing under $VENDOR_DIR/"
  echo "Rebuild with:  cd tools && npm install"
  exit 1
fi

source venv/bin/activate
exec python -m painapple_code --host "${HTTP_HOST:-127.0.0.1}" --port "${HTTP_PORT:-8765}" "${FORWARD_ARGS[@]}"
