#!/usr/bin/env python3
"""
pAInapple Code Server

An HTTP + WebSocket server that lets remote clients (a browser, an iPad PWA)
interact with Claude Code running on this machine.

Usage:
    python server.py [--port 8765] [--host 127.0.0.1] [--cwd /path/to/project]
"""

import asyncio
import atexit
import faulthandler
import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import signal
import stat
import sys
import time
import yaml
from contextlib import asynccontextmanager
from functools import lru_cache
from starlette.middleware.base import BaseHTTPMiddleware
from pathlib import Path
from typing import Any, Dict, NoReturn, Optional

from painapple_code import PACKAGE_DIR, REPO_ROOT
from painapple_code.cli.serve_args import DEFAULT_PORT, build_parser

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.types import ASGIApp
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
import uvicorn

# ═══════════════════════════════════════════════════════════════════════
# Project imports
# ═══════════════════════════════════════════════════════════════════════
from painapple_code.server_logging import setup_logging, AccessLogMiddleware
from painapple_code.session_store import SessionStore
from painapple_code import bridge_paths

from painapple_code.services.agent_session import AgentBridge
from painapple_code.auth_middleware import (
    AuthMiddleware,
    derive_cookie_token,
    ensure_config_file,
    mint_download_token,
    safe_next,
    sync_derived_config,
)

# Loggers are configured in main(), not at import. We grab the named singletons
# here so module-level references resolve, but attach NO handlers — deferring
# keeps `python -m painapple_code --help` (and argparse errors) from creating the
# log dir, opening log files, and redirecting stderr as a mere import side effect.
# setup_logging() in main() configures these same singleton objects.
logger = logging.getLogger("painapple-code")
access_logger = logging.getLogger("painapple-code.access")


# Global bridge instance
bridge: Optional["AgentBridge"] = None

# Instance identity config (set via CLI --instance-name / --accent)
instance_config: dict = {}
_instance_icons_dir: Optional[Path] = None

# ═══════════════════════════════════════════════════════════════════════
# Crash diagnostics: signal handlers + faulthandler
# ═══════════════════════════════════════════════════════════════════════
def _signal_handler(signum, frame):
    """Log signal before dying — catches SIGTERM/SIGHUP that kill silently."""
    sig_name = signal.Signals(signum).name
    logger.critical(f"SIGNAL RECEIVED: {sig_name} (pid={os.getpid()})")
    # Dump all thread tracebacks
    faulthandler.dump_traceback(file=sys.stderr, all_threads=True)
    # Re-raise with default handler so process actually dies
    signal.signal(signum, signal.SIG_DFL)
    if sys.platform == "win32":
        # os.kill(pid, sig) can't re-deliver arbitrary signals on Windows
        # (only CTRL_C/CTRL_BREAK events); the diagnostics above are the
        # point of this handler, so just exit with the conventional code.
        os._exit(128 + signum)
    os.kill(os.getpid(), signum)

# Enable faulthandler for SIGSEGV/SIGABRT/SIGFPE/SIGBUS tracebacks
faulthandler.enable(file=sys.stderr, all_threads=True)
# Trap signals that would normally kill silently. SIGHUP doesn't exist on
# Windows — build the tuple defensively instead of naming it directly.
for _sig in (signal.SIGTERM, getattr(signal, "SIGHUP", None)):
    if _sig is not None:
        signal.signal(_sig, _signal_handler)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup/shutdown."""
    # Pin the running version before anything can change on disk under us.
    # An editable checkout can be fast-forwarded mid-run (deploy.fish does
    # exactly that), and only a snapshot taken here still describes the code
    # this process actually imported.
    from painapple_code.routes.api_bridge import capture_boot_version
    capture_boot_version()

    # `git` is a hard requirement, not an optional extra: the auto-journal
    # shells out to it for every turn, and the Git panel for every diff.
    # Without it the failure is SILENT — ShadowGit.init_repo() catches the
    # FileNotFoundError, logs at exception level and returns False, so the
    # server comes up looking healthy and simply never journals anything.
    # Say so once, loudly, at boot instead.
    if shutil.which("git") is None:
        hint = (
            " Windows: install Git for Windows (https://git-scm.com/download/win),"
            " which also provides the bash that the optional shadow-git/"
            "shadow-query helpers run under."
            if sys.platform == "win32" else ""
        )
        logger.warning(
            "git not found on PATH — the auto-journal (shadow git) and the "
            "Git panel are both disabled. Install git and restart." + hint
        )

    # Bridge is created in main() before uvicorn.run() so --cwd is available
    if bridge:
        bridge.start_cleanup_task()
        logger.info("Painapple Code initialized")
    # Deliberately a hint, not an auto-build: shelling out to npm on the boot
    # path would put a network call (and a new failure mode) in front of
    # serving, for what is only an optimisation. Gated on the build script
    # being present, so it fires only where the fix is actually available —
    # a from-source install, never a wheel (which ships a bundle already).
    delivery = frontend_delivery()
    if delivery["reason"] in _BUNDLE_REMEDY:
        logger.info(
            "Frontend is not bundled — a cold page load fetches ~190 modules. "
            f"{_BUNDLE_REMEDY[delivery['reason']]}."
        )
    yield
    if bridge and bridge._cleanup_task:
        bridge._cleanup_task.cancel()
        try:
            await bridge._cleanup_task
        except asyncio.CancelledError:
            pass
    if bridge:
        total = len(bridge.sessions)
        running = sum(1 for s in bridge.sessions.values() if s.is_running)
        logger.info(f"Painapple Code shutting down (sessions={total}, running={running})")
    else:
        logger.info("Painapple Code shutting down")


app = FastAPI(title="Painapple Code", lifespan=lifespan)

# ── Static asset versioning ────────────────────────────────────────────
#
# Every cacheable asset URL carries ?v=<digest>. `/app` computes the digest
# once per page load and stamps it onto every asset it references; each JS
# module then stamps its own imports with the version it was *requested* at,
# so a single page load threads one consistent version through the whole
# module graph without the server holding any global "current version" state.
#
# A versioned URL is served `immutable`, so a warm reload issues zero asset
# requests. Correctness rests entirely on the digest changing whenever any
# asset does — hence content hashing (below) rather than a bare mtime.
_ASSET_GLOBS = ("css/*.css", "js/**/*.js", "vendor/*.js", "vendor/*.css", "dist/*.js", "sw.js")

# Prebuilt single-file frontend, generated by `npm run build:app` in tools/.
# Absent in an editable checkout — dev serves the 186 modules individually so
# edit->refresh needs no build step — and present in the wheel and image, where
# a cold load would otherwise be ~195 requests across ~6 dependency waves.
_BUNDLE_REL = "dist/app.bundle.js"


_bundle_stale_logged = False


def _bundle_path() -> Optional[Path]:
    """The frontend bundle to serve, or None to serve loose modules.

    PAINAPPLE_NO_BUNDLE=1 forces per-file serving even when a bundle exists,
    so a packaged install can still be debugged against readable sources.

    In a checkout, a bundle older than the newest module is treated as absent:
    someone built it and then edited a source, and serving the stale bundle
    would silently swallow the edit while the version digest moved. Falling
    back to loose modules keeps edit->refresh honest.

    That check is deliberately scoped to a checkout, identified by the build
    script sitting next to the package. An installed package has no editable
    sources, and every file lands at install time in whatever order the
    installer unpacked them — mtimes there carry no signal at all, and
    comparing them rejected the shipped bundle essentially at random.
    """
    global _bundle_stale_logged
    if os.environ.get("PAINAPPLE_NO_BUNDLE"):
        return None
    p = PACKAGE_DIR / "static" / _BUNDLE_REL
    if not p.is_file():
        return None
    if not (REPO_ROOT / "build-frontend.sh").is_file():
        return p
    try:
        built = p.stat().st_mtime_ns
        newest = max(
            (f.stat().st_mtime_ns for f in (PACKAGE_DIR / "static" / "js").rglob("*.js")),
            default=0,
        )
    except OSError:
        return p
    if newest > built:
        if not _bundle_stale_logged:
            _bundle_stale_logged = True
            logger.warning(
                "Frontend bundle is older than static/js — serving loose modules. "
                "Run ./build-frontend.sh to refresh it, or ./build-frontend.sh "
                "--clean to stay unbundled."
            )
        return None
    return p


# Why the frontend isn't bundled → what to do about it. The remedy differs by
# install shape, and pointing someone at a build script that isn't there is
# worse than saying nothing.
_BUNDLE_REMEDY = {
    # A checkout: the build script is right there next to the package.
    "checkout": "Run ./build-frontend.sh (--clean to undo)",
    # Installed from source without npm on PATH, so setup.py's build hook
    # skipped the bundle. There is no checkout here to build from.
    "unbuilt": "Install Node and reinstall to get a bundled build",
}


def frontend_delivery() -> Dict[str, Any]:
    """How the frontend is being served, and why.

    Shared by the startup hint and /api/info (which feeds the About widget)
    so the two can't drift. `reason` is a stable key, not prose — the client
    owns the wording (strings.yaml), the server owns the fact.
    """
    if _bundle_path():
        return {"bundled": True, "reason": None}
    # Not a problem to report: someone asked for loose modules on purpose.
    if os.environ.get("PAINAPPLE_NO_BUNDLE"):
        return {"bundled": False, "reason": "disabled"}
    if (REPO_ROOT / "build-frontend.sh").is_file():
        return {"bundled": False, "reason": "checkout"}
    return {"bundled": False, "reason": "unbuilt"}


# Accepts the current digest plus the legacy integer-mtime versions that older
# cached pages still send. Anything else is rejected rather than reflected —
# the version is interpolated into served JS, so it must never carry arbitrary
# text (or regex-replacement escapes).
_VERSION_RE = re.compile(r"[0-9a-f]{1,32}\Z")


def _valid_version(v: Optional[str]) -> Optional[str]:
    """Return `v` if it is a well-formed asset version, else None."""
    return v if v and _VERSION_RE.match(v) else None


def _asset_stamps() -> tuple:
    """(path, mtime_ns, size) for every cacheable asset — cheap change probe."""
    static_dir = PACKAGE_DIR / "static"
    entries = []
    for pattern in _ASSET_GLOBS:
        for f in static_dir.glob(pattern):
            try:
                st = f.stat()
            except OSError:
                continue
            entries.append((str(f.relative_to(static_dir)), st.st_mtime_ns, st.st_size))
    # strings.js is generated from this YAML and cached like any other module,
    # so a strings-only edit has to move the version too.
    try:
        st = (PACKAGE_DIR / "data" / "strings.yaml").stat()
        entries.append(("../data/strings.yaml", st.st_mtime_ns, st.st_size))
    except OSError:
        pass
    return tuple(sorted(entries))


@lru_cache(maxsize=4)
def _content_version(stamps: tuple) -> str:
    """Digest of asset *contents*, recomputed only when a stamp changes.

    Hashing content rather than mtimes costs one ~5 MB read per edit and buys
    two things: a deploy that happens to preserve mtimes can't serve stale
    immutable assets, and reverting a file returns the previous version, so
    the browser reuses what it already has.
    """
    h = hashlib.blake2b(digest_size=6)
    static_dir = PACKAGE_DIR / "static"
    for name, _mtime, _size in stamps:
        h.update(name.encode())
        h.update(b"\0")
        try:
            h.update((static_dir / name).read_bytes())
        except OSError:
            pass
        h.update(b"\0")
    return h.hexdigest()


def _asset_version() -> str:
    """Current frontend build id. ~2 ms warm; only rehashes after an edit."""
    return _content_version(_asset_stamps())


class StaticCacheMiddleware(BaseHTTPMiddleware):
    """Single owner of Cache-Control for /static/.

    Versioned URLs are immutable (the version changes when content does);
    unversioned ones stay uncached so direct hits and the service worker's
    bare precache list keep picking up edits.
    """

    async def dispatch(self, request, call_next):
        response = await call_next(request)
        if not request.url.path.startswith("/static/"):
            return response
        if _valid_version(request.query_params.get("v")) and response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            # MutableHeaders is a Mapping with mutators bolted on — no .pop().
            for stale in ("Pragma", "Expires"):
                if stale in response.headers:
                    del response.headers[stale]
        else:
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response


def _json_for_html(value) -> str:
    """Serialize ``value`` for embedding inside an HTML <script> data block.

    A raw ``</script>`` sequence anywhere in the JSON would close the element
    early and let the remainder be parsed as markup. Escaping ``<`` sidesteps
    that (and ``<!--``) without changing what ``JSON.parse`` sees: ``\\u003c``
    is just ``<`` to any JSON reader. ``&`` is left alone — script data blocks
    are CDATA-ish and do not run entity decoding.
    """
    return json.dumps(value).replace("<", "\\u003c")


# CSP (WP-04): scripts are fully locked to 'self' — no 'unsafe-inline'. Every
# executable inline <script> was externalized (boot.js/login.js/
# feature-triage.js) and every inline on* handler replaced by a delegated
# data-act dispatch (action-delegate.js), so a script injected into
# model/tool output cannot execute. Server-injected config rides in
# <script type="application/json"> data blocks, which are not script-src
# subjects. style-src still needs 'unsafe-inline' — inline style="" attributes
# remain across the widgets (Stage 2, lower value: style injection is not code
# execution). `ws:`/`wss:` in connect-src keeps WebSocket reconnect working.
_CSP_STAGE1 = (
    "default-src 'self'; "
    "base-uri 'self'; "
    "object-src 'none'; "
    "frame-ancestors 'none'; "
    # Remote images render in markdown/model output (shields.io badges, repo
    # READMEs, image URLs) — allow https:; scripts/styles stay locked.
    "img-src 'self' data: blob: https:; "
    "font-src 'self' data:; "
    "style-src 'self' 'unsafe-inline'; "
    "script-src 'self'; "
    "connect-src 'self' ws: wss:; "
    # https: framing keeps the browser-widget's direct (non-proxy) mode working.
    "frame-src 'self' https:"
)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Baseline security response headers for the main app.

    Exemptions:
    - ``/api/browser`` — the browser-widget proxy serves iframe content with
      its own sandbox CSP; framing headers here would break it.
    - ``/view`` — the standalone file viewer ships its own inline assets; the
      strict CSP is not applied there (it still gets the non-CSP headers).
    """

    async def dispatch(self, request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path.startswith("/api/browser"):
            return response
        h = response.headers
        h.setdefault("X-Content-Type-Options", "nosniff")
        h.setdefault("Referrer-Policy", "no-referrer")
        h.setdefault(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), usb=(), payment=()",
        )
        h.setdefault("X-Frame-Options", "DENY")
        if not path.startswith("/view"):
            h.setdefault("Content-Security-Policy", _CSP_STAGE1)
        return response


# Gzip is scoped to the app's own text assets rather than mounted globally.
# Starlette's GZipMiddleware ignores status codes, so a global mount would
# compress a 206 Partial Content and break Range requests; there is no media
# under static/ (js/css/html + 11 small icons), so gating on these prefixes
# keeps ranges out of scope by construction. Binary suffixes are skipped since
# they don't compress. Non-HTTP scopes (WebSockets) never reach the responder.
_GZIP_PREFIXES = ("/static/", "/app")
_GZIP_SKIP_SUFFIXES = (".png", ".ico", ".woff", ".woff2")


class ScopedGZipMiddleware:
    """Apply GZipMiddleware only to the static asset routes.

    The web client pulls ~185 ES modules + the concatenated stylesheet on a
    cold load (~5 MB uncompressed). One GZipMiddleware instance is reused
    across requests — it holds config only, building a fresh responder per
    call — so this wrapper is a pure path gate.
    """

    def __init__(self, app: ASGIApp, minimum_size: int = 1024, compresslevel: int = 6) -> None:
        self.app = app
        self.gzip = GZipMiddleware(app, minimum_size=minimum_size, compresslevel=compresslevel)

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        if not path.startswith(_GZIP_PREFIXES) or path.endswith(_GZIP_SKIP_SUFFIXES):
            await self.app(scope, receive, send)
            return
        await self.gzip(scope, receive, send)


# Middleware order: last added = outermost = runs first on request.
# CORS outermost so preflight OPTIONS bypasses auth entirely.
# AuthMiddleware reads password / cookie token from scope["app"].state at
# request time — main() / create_app() populate that state before serving.
# Gzip is added first = innermost, so it compresses the route's own body
# before the header-stamping middlewares run.
app.add_middleware(ScopedGZipMiddleware)
app.add_middleware(AccessLogMiddleware, logger=access_logger)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(StaticCacheMiddleware)
app.add_middleware(AuthMiddleware)
def _loopback_origins(port) -> set:
    """This bridge's own loopback origins on ``port`` — the no-config default
    trust set. Derived from the actual bind, never hardcoded per-deployment."""
    return {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}


def resolve_allowed_origins(public_origins=(), port=None) -> set:
    """Single source of truth for trusted browser origins — feeds both CORS
    and the HTTP/WebSocket Origin checks (auth_middleware).

    This set is only an *exception list* for genuinely cross-origin callers. It
    is NOT how the normal client is authorized: `check_csrf_origin` accepts any
    request whose Origin matches the host it was reached on (config-free), so a
    LAN bind or a proxied hostname works without appearing here.

    Precedence: explicit config (BRIDGE_ALLOWED_ORIGINS env + ``--public-origin``)
    wins and REPLACES the loopback default. That replacement is deliberate and
    load-bearing: ``Origin: http://127.0.0.1:PORT`` is asserted by the *browser*,
    so on a remote/proxied deployment it means "a page served by whatever is
    listening on the VICTIM's own localhost:PORT" — the hostile-local-app case
    in the threat model, not this server. Once a deployment tells us its real
    origin, the loopback guess is worse than useless.

    With no explicit config we trust loopback on the port we actually bound
    (falling back to DEFAULT_PORT when the caller has no argv yet, e.g. the
    import-time CORS wiring). Non-loopback binds get the same derived pair:
    the browser may well sit on the same machine as the bridge.
    """
    origins = set()
    env = os.environ.get("BRIDGE_ALLOWED_ORIGINS", "").strip()
    if env:
        origins.update(o.strip() for o in env.split(",") if o.strip())
    origins.update(o for o in (public_origins or ()) if o)
    if origins:
        return origins

    return _loopback_origins(port or DEFAULT_PORT)


def resolve_allowed_hosts() -> list:
    """Host allowlist for TrustedHostMiddleware (defense-in-depth vs DNS
    rebinding). Reads ``BRIDGE_ALLOWED_HOSTS`` / ``BRIDGE_ALLOWED_ORIGINS`` from
    the ENV only (this middleware is constructed at import, before argv is
    parsed) — the ``--public-origin`` flag does NOT enable it. Returns ``["*"]``
    (off) unless one of those env vars is set, since the primary CSRF boundary
    is the Origin-vs-Host check in auth_middleware (config-free) and the
    ``bridge_auth`` cookie is domain-bound, which already defeats rebinding.
    When enforcing, loopback + the TestClient host join the configured hosts.
    """
    from urllib.parse import urlparse
    hosts = set()
    env_hosts = os.environ.get("BRIDGE_ALLOWED_HOSTS", "").strip()
    if env_hosts:
        hosts.update(h.strip() for h in env_hosts.split(",") if h.strip())
    origins_env = os.environ.get("BRIDGE_ALLOWED_ORIGINS", "").strip()
    if origins_env:
        for o in origins_env.split(","):
            h = urlparse(o.strip()).hostname
            if h:
                hosts.add(h)
    if not hosts:
        return ["*"]
    hosts.update({"localhost", "127.0.0.1", "::1", "testserver"})
    return sorted(hosts)


# CORS allow-list. Constructed at import (before argv), so it reflects the ENV
# (BRIDGE_ALLOWED_ORIGINS) only — NOT --public-origin. This governs whether a
# cross-origin browser may *read* a credentialed response; it is not the CSRF
# boundary (that's the runtime Origin-vs-Host check in auth_middleware, refined
# by main() with --public-origin + host/port). The same-origin app never needs
# CORS, so the env default is sufficient for the common case.
# Override via BRIDGE_ALLOWED_ORIGINS=https://foo.example.com,https://bar.example.com
_cors_origins = sorted(resolve_allowed_origins())

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# DNS-rebinding defense-in-depth: reject foreign Host headers, but only when
# BRIDGE_ALLOWED_HOSTS/ORIGINS is set in the env (see resolve_allowed_hosts).
# Added last = outermost, so a bad Host is rejected first.
_allowed_hosts = resolve_allowed_hosts()
if _allowed_hosts != ["*"]:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=_allowed_hosts)


def init_auth_state(app_: FastAPI, config_file: Optional[Path] = None) -> None:
    """Load the YAML config and populate auth state on the app.

    Called from main() at startup and from tests via the create_app() factory.
    Repeat calls just refresh state — middleware is already registered at
    module-load time and reads state dynamically via scope["app"].state.
    """
    # CONFIG_HOME, not a hand-built default: it honors PAINAPPLE_CODE_CONFIG,
    # which the Windows smoke workflow (and any isolated test run) sets
    # expecting the auth file to follow — previously only the data home
    # moved and the password file still landed in the real user profile.
    cfg_path = config_file or (bridge_paths.CONFIG_HOME / "config.yaml")
    password, newly_created = ensure_config_file(cfg_path)
    # Derived material (api_token + the two revocation epochs) is synced to
    # disk here: the api_token must be readable by scripts WITHOUT the
    # password, so it is stored rather than recomputed by every caller.
    derived = sync_derived_config(cfg_path, password)
    app_.state.auth_password = password
    app_.state.auth_cookie_token = derive_cookie_token(password, derived["cookie_epoch"])
    app_.state.auth_api_token = derived["api_token"]
    app_.state.auth_config_file = str(cfg_path)
    app_.state.auth_newly_created = newly_created
    # Trusted-origin set for the HTTP/WS Origin checks. main() refines this
    # with --public-origin + the bound host/port; tests (create_app) get the
    # env-or-loopback default, which is what the Origin checks read.
    if not getattr(app_.state, "allowed_origins", None):
        app_.state.allowed_origins = resolve_allowed_origins()


def create_app(config_file: Optional[Path] = None) -> FastAPI:
    """Factory that returns the configured app with auth state loaded.

    Tests pass a tmp_path-backed config file so they never touch the real
    ~/.config/painapple-code/config.yaml.
    """
    init_auth_state(app, config_file)
    return app

# ═══════════════════════════════════════════════════════════════════════
# Route Modules
# ═══════════════════════════════════════════════════════════════════════
from painapple_code.routes.api_shadow import router as shadow_router
from painapple_code.routes.api_shadow_search import router as shadow_search_router
from painapple_code.routes.api_shadow_files import router as shadow_files_router
from painapple_code.routes.api_prompts import router as prompts_router
from painapple_code.routes.api_drafts import router as drafts_router
from painapple_code.routes.api_costs import router as costs_router
from painapple_code.routes.api_files import router as files_router
from painapple_code.routes.api_search import router as search_router
from painapple_code.routes.api_git import router as git_router
from painapple_code.routes.api_bridge import router as bridge_router
from painapple_code.routes.api_bridge_config import router as bridge_config_router
from painapple_code.routes.api_bridge_session_prefs import router as bridge_session_prefs_router
from painapple_code.routes.api_bridge_commit_sections import router as bridge_commit_sections_router
from painapple_code.routes.api_project_config import router as project_config_router
from painapple_code.routes.api_sessions import router as sessions_router
from painapple_code.routes.api_session_stash import router as session_stash_router
from painapple_code.routes.api_session_welcome import router as session_welcome_router
from painapple_code.routes.api_logs import router as logs_router

# The terminal needs a pseudo-terminal backend: pty/fcntl/termios on
# POSIX, pywinpty (ConPTY) on Windows. Both are declared dependencies for
# their platform, so this normally succeeds everywhere — but a Windows
# install that skipped the optional pywinpty should lose only the
# terminal tab, not the server. TERMINAL_AVAILABLE feeds the client via
# INSTANCE_CONFIG so the UI hides the widget/shortcut instead of offering
# a button that 404s.
from painapple_code.utils.pty_backend import PTY_AVAILABLE, PTY_UNAVAILABLE_REASON

TERMINAL_AVAILABLE = PTY_AVAILABLE
if PTY_AVAILABLE:
    from painapple_code.routes.api_terminal import router as terminal_router
else:
    terminal_router = None
    logger.warning(f"Terminal disabled: {PTY_UNAVAILABLE_REASON}")

from painapple_code.routes.api_upload import router as upload_router
from painapple_code.routes.api_exec import router as exec_router
from painapple_code.routes.api_viewer import router as viewer_router
from painapple_code.routes.api_browser import router as browser_router
from painapple_code.routes.api_shadow_db import router as shadow_db_router
from painapple_code.routes.api_tasks import router as tasks_router

from painapple_code.routes.api_skills import router as skills_router
from painapple_code.routes.api_commands import router as commands_router
from painapple_code.routes.api_agents import router as agents_router
from painapple_code.routes.api_plugins import router as plugins_router
from painapple_code.routes.api_providers import router as providers_router

from painapple_code.routes.ws_chat import router as chat_router
app.include_router(chat_router)
app.include_router(shadow_router)
app.include_router(skills_router)
app.include_router(commands_router)
app.include_router(providers_router)
app.include_router(agents_router)
app.include_router(plugins_router)
app.include_router(shadow_search_router)
app.include_router(shadow_files_router)
app.include_router(prompts_router)
app.include_router(drafts_router)
app.include_router(costs_router)
app.include_router(files_router)
app.include_router(search_router)
app.include_router(git_router)
app.include_router(bridge_router)
app.include_router(bridge_config_router)
app.include_router(bridge_session_prefs_router)
app.include_router(bridge_commit_sections_router)
app.include_router(project_config_router)
app.include_router(sessions_router)
app.include_router(session_stash_router)
app.include_router(session_welcome_router)
app.include_router(logs_router)
if terminal_router is not None:
    app.include_router(terminal_router)

app.include_router(upload_router)
app.include_router(exec_router)
app.include_router(viewer_router)
app.include_router(browser_router)
app.include_router(shadow_db_router)
app.include_router(tasks_router)

# ── Perf snapshot upload (for capturing browser state from iPad) ──
@app.post("/api/perf/snapshot")
async def upload_perf_snapshot(request: Request):
    """Accept a browser state snapshot and enrich with server-side session data.

    Dev-only: the snapshot writer lives under the gitignored tests/perf/, so
    this endpoint is absent from public / wheel installs (404 when the module
    isn't present) rather than 500-ing on a missing import.
    """
    import sys
    perf_dir = REPO_ROOT / "tests" / "perf"
    if not (perf_dir / "snapshot.py").exists():
        raise HTTPException(status_code=404, detail="Perf snapshot capture is not available in this build")
    sys.path.insert(0, str(perf_dir))
    from snapshot import save_uploaded_snapshot
    data = await request.json()

    # V2 enrichment: bundle server-side messages.jsonl + meta.json for each session
    server_sessions = {}
    total_server_bytes = 0
    MAX_SERVER_BYTES = 50 * 1024 * 1024  # 50MB cap
    try:
        store_ids = []
        # Get storeIds from session_summary (browser already parsed these)
        for s in data.get("session_summary", []):
            sid = s.get("store_id") or s.get("storeId")
            if sid:
                store_ids.append(sid)

        for store_id in store_ids:
            store, meta = SessionStore._find_session(store_id)
            if not store or not meta:
                continue
            messages_path = store._messages_path(store_id)
            messages_content = ""
            messages_count = 0
            if messages_path.exists():
                messages_content = messages_path.read_text(encoding="utf-8")
                messages_count = sum(1 for line in messages_content.splitlines() if line.strip())

            msg_bytes = len(messages_content.encode("utf-8"))
            if total_server_bytes + msg_bytes > MAX_SERVER_BYTES:
                logger.warning(f"Perf snapshot: skipping {store_id}, would exceed {MAX_SERVER_BYTES // 1024 // 1024}MB cap")
                continue
            total_server_bytes += msg_bytes

            # Determine project_hash from session directory path
            project_hash = store.base_dir.parent.name  # .../projects/{hash}/sessions/ → {hash}

            server_sessions[store_id] = {
                "project_hash": project_hash,
                "meta": meta,
                "messages_jsonl": messages_content,
                "messages_count": messages_count,
                "messages_bytes": msg_bytes,
            }
    except Exception as e:
        logger.warning(f"Failed to enrich snapshot with server data: {e}")

    if server_sessions:
        data["server_sessions"] = server_sessions
        data["version"] = data.get("version", 2)

    path = save_uploaded_snapshot(data, instance_name=instance_config.get("name"))
    sessions = data.get("session_summary", [])
    total_msgs = sum(s.get("message_count", 0) for s in sessions)
    total_server_msgs = sum(s["messages_count"] for s in server_sessions.values())
    client_sessions = data.get("client_sessions", {})
    total_client_msgs = sum(s.get("message_count", 0) for s in client_sessions.values())
    client_bytes = data.get("client_sessions_bytes", 0)
    logger.info(f"Perf snapshot saved: {path.name} ({len(sessions)} sessions, {total_msgs} localStorage msgs, "
                f"{len(server_sessions)} server sessions, {total_server_msgs} server msgs, "
                f"{len(client_sessions)} client sessions, {total_client_msgs} client msgs, "
                f"server={total_server_bytes / 1024 / 1024:.1f}MB, client={client_bytes / 1024 / 1024:.1f}MB)")
    return {
        "ok": True,
        "path": str(path.name),
        "sessions": len(sessions),
        "messages": total_msgs,
        "server_sessions": len(server_sessions),
        "server_messages": total_server_msgs,
        "server_bytes_mb": round(total_server_bytes / 1024 / 1024, 2),
        "client_sessions": len(client_sessions),
        "client_messages": total_client_msgs,
        "client_bytes_mb": round(client_bytes / 1024 / 1024, 2),
    }

# Concatenated stylesheet, cached by content-freshness key (see caller).
# maxsize=2 keeps the previous build around during an edit without growing.
@lru_cache(maxsize=2)
def _build_concatenated_css(cache_key: tuple) -> str:
    css_dir = PACKAGE_DIR / "static" / "css"
    parts = []
    for f in sorted(css_dir.glob("*.css")):
        parts.append(f"/* === {f.name} === */")
        # Explicit encoding: Python picks the locale codec otherwise, which is
        # cp1252 on a stock Windows box — any non-ASCII byte in a stylesheet
        # then raises UnicodeDecodeError and takes down the whole page load.
        parts.append(f.read_text(encoding="utf-8"))
    return "\n".join(parts)


# Serve concatenated CSS from modules (must be before static mount)
@app.get("/static/styles.css")
async def serve_concatenated_css(v: str = None):
    """Concatenate CSS modules from static/css/ on-the-fly."""
    css_dir = PACKAGE_DIR / "static" / "css"
    if not css_dir.exists():
        # Fall back to static styles.css if css/ directory doesn't exist
        static_css = PACKAGE_DIR / "static" / "styles.css"
        if static_css.exists():
            return FileResponse(static_css, media_type="text/css")
        raise HTTPException(status_code=404, detail="CSS not found")

    # Concatenate all CSS files in order. Cached by (newest mtime, file count)
    # so editing/adding/removing a module still shows up on the next refresh —
    # the no-build-step workflow is preserved, we just stop re-reading ~1.1 MB
    # off the event loop on every request.
    css_files = sorted(css_dir.glob("*.css"))
    cache_key = (max((f.stat().st_mtime_ns for f in css_files), default=0), len(css_files))
    content = await asyncio.to_thread(_build_concatenated_css, cache_key)

    # Cache-Control is owned by StaticCacheMiddleware (versioned => immutable).
    return Response(content=content, media_type="text/css")


# LRU cache for processed JS content - avoids repeated file I/O and regex.
# Key: (filename, mtime_ns, cache_bust_version), Value: processed content.
# mtime_ns is in the key so an edit is picked up even when a client replays an
# older version string. maxsize covers the whole tree (186 modules) across a
# couple of live versions — at 128 a single cold page load thrashed.
@lru_cache(maxsize=512)
def _process_js_file(subdir: str, filename: str, mtime_ns: int, cache_bust: str) -> str:
    """Read and process JS file with cache-busted imports. Cached by filename+mtime+version."""
    js_path = PACKAGE_DIR / "static" / subdir / filename
    content = js_path.read_text(encoding="utf-8")
    # Match static imports: from './foo.js' or from '../foo.js'
    content = re.sub(r"from\s+['\"]((\.\.?/)+[^'\"]+\.js)['\"]", rf"from '\1{cache_bust}'", content)
    # Side-effect imports have no `from` clause: import './foo.js';
    # (`import(` can't match here — a quote must follow the whitespace.)
    content = re.sub(r"import\s+['\"]((\.\.?/)+[^'\"]+\.js)['\"]", rf"import '\1{cache_bust}'", content)
    # Match dynamic imports: import('./foo.js') or import('../foo.js')
    content = re.sub(r"import\(\s*['\"]((\.\.?/)+[^'\"]+\.js)['\"]\s*\)", rf"import('\1{cache_bust}')", content)
    # Root-absolute asset literals — the lazily loaded vendor bundles
    # (codemirror ~1 MB, xterm ~283 KB) reference themselves as
    # '/static/vendor/x.js' via import() and injected <script>/<link> tags.
    # Relative-only rewriting left them unversioned, so they were refetched on
    # every page load that opened an editor or terminal.
    content = re.sub(
        r"(['\"])(/static/[^'\"]+\.(?:js|css))\1", rf"\1\2{cache_bust}\1", content
    )
    return content

# Serve strings.yaml as ES module (must be before catch-all JS route)
@lru_cache(maxsize=1)
def _load_strings_yaml(mtime: float) -> str:
    """Read strings.yaml and convert to ES module. Cached by file mtime."""
    yaml_path = PACKAGE_DIR / "data" / "strings.yaml"
    with open(yaml_path, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    return f"// Auto-generated from strings.yaml — do not edit\nexport default {json.dumps(data, ensure_ascii=False)};\n"

@app.get("/static/js/strings.js")
async def serve_strings_js(v: str = None):
    """Serve strings.yaml as an ES module for frontend consumption."""
    yaml_path = PACKAGE_DIR / "data" / "strings.yaml"
    if not yaml_path.exists():
        raise HTTPException(status_code=404, detail="strings.yaml not found")
    mtime = yaml_path.stat().st_mtime
    content = await asyncio.to_thread(_load_strings_yaml, mtime)
    return Response(content=content, media_type="application/javascript")


async def _serve_rewritten_js(subdir: str, filename: str, v: Optional[str]) -> Response:
    """Serve a .js file from static/<subdir>/ with its asset URLs version-stamped."""
    js_path = PACKAGE_DIR / "static" / subdir / filename
    # Containment: {filename:path} allows ../ segments — resolve and confirm the
    # target stays inside the root before touching disk (defense-in-depth;
    # this route is auth-gated, but never serve an out-of-tree file).
    js_root = (PACKAGE_DIR / "static" / subdir).resolve()
    if not js_path.resolve().is_relative_to(js_root):
        raise HTTPException(status_code=404, detail="File not found")
    try:
        st = js_path.stat()
    except OSError:
        raise HTTPException(status_code=404, detail="File not found")
    if not stat.S_ISREG(st.st_mode):
        raise HTTPException(status_code=404, detail="File not found")

    # Stamp imports with the version THIS module was requested at, so one page
    # load threads a single version through the whole graph. Falling back to the
    # live version covers unversioned hits (direct curl, the SW precache list).
    version = _valid_version(v) or await asyncio.to_thread(_asset_version)

    # Run blocking I/O in thread pool to avoid blocking event loop
    # LRU cache means subsequent requests for same file are instant
    content = await asyncio.to_thread(
        _process_js_file, subdir, filename, st.st_mtime_ns, f"?v={version}"
    )

    # Cache-Control is owned by StaticCacheMiddleware (versioned => immutable).
    return Response(content=content, media_type="application/javascript")


# Serve JS files with cache-busted imports (must be before static mount)
@app.get("/static/js/{filename:path}")
async def serve_js_with_cache_bust(filename: str, v: str = None):
    """Serve JS files with cache-busting query params on imports.

    Uses LRU cache + thread pool to avoid blocking the event loop under concurrent load.
    """
    return await _serve_rewritten_js("js", filename, v)


@app.get("/static/dist/{filename:path}")
async def serve_bundled_js(filename: str, v: str = None):
    """Serve the prebuilt bundle through the same rewriting as loose modules.

    The bundle still contains absolute '/static/vendor/*' literals for the lazy
    codemirror/xterm loads; served straight off the StaticFiles mount they would
    go unversioned and be refetched on every page load.
    """
    if not filename.endswith(".js"):
        raise HTTPException(status_code=404, detail="File not found")
    return await _serve_rewritten_js("dist", filename, v)


# Mount static files directory (after JS route so it doesn't override)
static_dir = PACKAGE_DIR / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


def _missing_asset_page(title: str, detail: str = "") -> str:
    """HTML for missing-asset fallbacks. Matches the Tauri launcher's palette
    so a webview falling through to one of these doesn't flash a white screen
    in dark mode — bare `<html><body><h1>…` was unstyled white."""
    detail_html = f'<p class="detail">{detail}</p>' if detail else ""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=contain">
<meta name="color-scheme" content="dark light">
<title>{title}</title>
<style>
:root {{ --bg:#1a1612; --fg:#f3eee5; --muted:#8a8278; }}
@media (prefers-color-scheme: light) {{
  :root {{ --bg:#faf6ee; --fg:#1a1612; --muted:#6a6358; }}
}}
*{{box-sizing:border-box}}
html,body{{height:100%;margin:0}}
body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--fg);display:flex;align-items:center;justify-content:center;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}}
main{{width:100%;max-width:420px;padding:32px 24px;text-align:center}}
h1{{font-size:22px;margin:0 0 8px;letter-spacing:-0.02em;font-weight:600}}
.detail{{color:var(--muted);margin:0;font-size:14px;line-height:1.5}}
</style>
</head>
<body>
<main>
<h1>{title}</h1>
{detail_html}
</main>
</body>
</html>"""


@app.get("/")
async def root():
    """Redirect to main app."""
    return RedirectResponse(url="/app")


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "service": "painapple-code", "hot_reload": "v4"}


# ═══════════════════════════════════════════════════════════════════════
# Auth: login page + login/logout endpoints
# ═══════════════════════════════════════════════════════════════════════

@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    """Serve the standalone login form."""
    html_path = PACKAGE_DIR / "static" / "login.html"
    if not html_path.exists():
        return HTMLResponse(
            _missing_asset_page(
                "Login page missing",
                f"Expected at <code>{html_path}</code>. The painapple-code install is incomplete — reinstall the package.",
            ),
            status_code=500,
        )
    # Inject the detected environment + resolved auth-config path so the page
    # can show the right "reveal password" command (docker exec vs plain awk,
    # with the real path — covers local, Docker and the Codespaces Feature's
    # /workspaces/.painapple-code/auth.yaml alike). Mirrors the INSTANCE_CONFIG
    # injection on /app. Neither value is secret (path + env name only).
    login_config = {
        "environment": bridge_paths.detect_environment(),
        "configPath": getattr(
            request.app.state, "auth_config_file",
            "~/.config/painapple-code/config.yaml",
        ),
    }
    # A launcher (painapple-docker.sh, docker compose) can inject the exact
    # reveal command via PAINAPPLE_REVEAL_CMD — it knows the host-side container
    # name, storage flags and engine that this in-container page cannot. Shown
    # verbatim when set; the page otherwise falls back to a per-env guess.
    reveal_cmd = os.environ.get("PAINAPPLE_REVEAL_CMD", "").strip()
    if reveal_cmd:
        login_config["revealCmd"] = reveal_cmd
    # Written into the page's <script type="application/json"> data block —
    # not an executable inline script, so the CSP can keep script-src free of
    # 'unsafe-inline'. login.js reads it. Mirrors /app's instance-config.
    html = html_path.read_text(encoding="utf-8").replace(
        '<script type="application/json" id="login-config">null</script>',
        '<script type="application/json" id="login-config">'
        f"{_json_for_html(login_config)}</script>",
    )
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


# Per-IP login throttle (in-memory; single-process bridge). Counts only
# genuine wrong-password attempts; successes reset the client's counter.
_LOGIN_FAILS: dict = {}
_LOGIN_MAX_FAILS = 10
_LOGIN_WINDOW = 300  # seconds
_LOGIN_MAX_IPS = 2048  # hard cap so a spoofed-IP flood can't grow the map


def _login_client_ip(request: Request) -> str:
    return request.client.host if request.client else "?"


def _login_is_throttled(ip: str) -> bool:
    now = time.monotonic()
    hits = [t for t in _LOGIN_FAILS.get(ip, ()) if now - t < _LOGIN_WINDOW]
    _LOGIN_FAILS[ip] = hits
    return len(hits) >= _LOGIN_MAX_FAILS


def _login_record_failure(ip: str) -> None:
    # Evict expired entries when the map gets large, so a flood of distinct
    # (possibly spoofed) source IPs can't leak memory unbounded.
    if len(_LOGIN_FAILS) >= _LOGIN_MAX_IPS:
        now = time.monotonic()
        for k in [k for k, v in _LOGIN_FAILS.items()
                  if not any(now - t < _LOGIN_WINDOW for t in v)]:
            del _LOGIN_FAILS[k]
        # Still full of live entries → drop the oldest-touched to stay bounded.
        if len(_LOGIN_FAILS) >= _LOGIN_MAX_IPS:
            _LOGIN_FAILS.pop(next(iter(_LOGIN_FAILS)), None)
    _LOGIN_FAILS.setdefault(ip, []).append(time.monotonic())


def _login_reset(ip: str = None) -> None:
    if ip is None:
        _LOGIN_FAILS.clear()
    else:
        _LOGIN_FAILS.pop(ip, None)


@app.post("/api/login")
async def login_submit(request: Request):
    """Validate password, set cookie, return sanitized next path.

    Never trusts the client's interpretation of `next` — always runs it
    through safe_next on the server side, and returns the sanitized value
    in the response body. The client redirects only to that value.
    """
    ip = _login_client_ip(request)
    if _login_is_throttled(ip):
        return JSONResponse(
            {"error": "too_many_attempts"},
            status_code=429,
            headers={"Retry-After": str(_LOGIN_WINDOW)},
        )
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid_body"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "invalid_body"}, status_code=400)

    pw = body.get("password", "")
    raw_next = body.get("next")
    if raw_next is None:
        raw_next = ""
    if not isinstance(pw, str) or not isinstance(raw_next, str):
        return JSONResponse({"error": "invalid_body"}, status_code=400)

    expected = getattr(request.app.state, "auth_password", None)
    cookie_token = getattr(request.app.state, "auth_cookie_token", None)
    if expected is None or cookie_token is None:
        return JSONResponse({"error": "auth_not_configured"}, status_code=503)

    if not pw or not hmac.compare_digest(pw, expected):
        _login_record_failure(ip)
        return JSONResponse({"error": "invalid_password"}, status_code=401)

    _login_reset(ip)
    sanitized_next = safe_next(raw_next)
    forwarded = request.headers.get("x-forwarded-proto", request.url.scheme)
    secure = forwarded == "https"

    resp = JSONResponse({"ok": True, "next": sanitized_next})
    resp.set_cookie(
        "bridge_auth",
        cookie_token,
        httponly=True,
        samesite="lax",
        secure=secure,
        max_age=30 * 24 * 3600,
        path="/",
    )
    return resp


@app.post("/api/auth/download-token")
async def download_token_submit(request: Request):
    """Mint a short-lived token authorizing one local URL (e.g. /api/file-raw).

    Requires normal auth (goes through the middleware). Used by the iPad PWA
    "copy download link" flow so copied links work in Safari without embedding
    the password.
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid_body"}, status_code=400)
    url = body.get("url") if isinstance(body, dict) else None
    if (
        not isinstance(url, str)
        or not url.startswith("/")
        or url.startswith("//")
        or "\\" in url
    ):
        return JSONResponse({"error": "invalid_url"}, status_code=400)

    password = getattr(request.app.state, "auth_password", None)
    if password is None:
        return JSONResponse({"error": "auth_not_configured"}, status_code=503)

    token, expires_at = mint_download_token(password, url)
    sep = "&" if "?" in url else "?"
    return JSONResponse({
        "token": token,
        "expires_at": expires_at,
        "url": f"{url}{sep}dl={token}",
    })


@app.post("/api/logout")
async def logout_submit(request: Request):
    """Clear the auth cookie. Attributes must match the set-cookie call."""
    forwarded = request.headers.get("x-forwarded-proto", request.url.scheme)
    secure = forwarded == "https"
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(
        "bridge_auth",
        path="/",
        samesite="lax",
        secure=secure,
        httponly=True,
    )
    return resp


@app.get("/triage", response_class=HTMLResponse)
async def triage_page():
    """Serve the feature triage tool."""
    html_path = PACKAGE_DIR / "static" / "feature-triage.html"
    if html_path.exists():
        return html_path.read_text(encoding="utf-8")
    return _missing_asset_page(
        "Triage tool not found",
        f"Expected at <code>{html_path}</code>.",
    )


@app.get("/api/triage-state")
async def get_triage_state():
    """Read feature triage decisions from _index.yaml."""
    index_path = _FEATURES_DIR / "_index.yaml"
    if not index_path.exists():
        return JSONResponse({"decisions": {}, "notes": {}})
    with open(index_path, encoding="utf-8") as f:
        index = yaml.safe_load(f)
    decisions = {}
    notes = {}
    for feat in index.get('features', []):
        fid = feat['id']
        if feat.get('status') == 'cut':
            decisions[fid] = 'cut'
        elif feat.get('triage'):
            decisions[fid] = feat['triage']
        if feat.get('triage_note'):
            notes[fid] = feat['triage_note']
    return JSONResponse({"decisions": decisions, "notes": notes})


@app.post("/api/triage-state")
async def save_triage_state(request: Request):
    """Save feature triage decisions into _index.yaml (preserves comments)."""
    data = await request.json()
    new_decisions = data.get('decisions', {})
    new_notes = data.get('notes', {})
    index_path = _FEATURES_DIR / "_index.yaml"
    if not index_path.exists():
        return JSONResponse({"error": "index not found"}, status_code=404)

    lines = index_path.read_text(encoding="utf-8").splitlines()
    result = []
    i = 0
    while i < len(lines):
        line = lines[i]
        result.append(line)
        # Detect feature block start
        stripped = line.strip()
        if stripped.startswith('- id:'):
            fid = stripped.split(':', 1)[1].strip().strip('"').strip("'")
            if fid in new_decisions or fid in new_notes:
                # Collect remaining lines of this feature block
                indent = len(line) - len(line.lstrip())
                block_indent = ' ' * (indent + 2)
                i += 1
                had_triage = False
                had_note = False
                had_status = False
                while i < len(lines):
                    nline = lines[i]
                    nstripped = nline.strip()
                    # Next feature or group separator
                    if nstripped.startswith('- id:') or (nstripped.startswith('#') and '═' in nstripped):
                        break
                    # Update existing fields
                    if nstripped.startswith('triage:') and not nstripped.startswith('triage_note:'):
                        dec = new_decisions.get(fid, '')
                        if dec and dec != 'cut':
                            result.append(f'{block_indent}triage: {dec}')
                        # skip if cut (status handles it) or empty
                        had_triage = True
                        i += 1
                        continue
                    if nstripped.startswith('triage_note:'):
                        note = new_notes.get(fid, '')
                        if note:
                            result.append(f'{block_indent}triage_note: "{note}"')
                        had_note = True
                        i += 1
                        continue
                    if nstripped.startswith('status:'):
                        if new_decisions.get(fid) == 'cut':
                            result.append(f'{block_indent}status: cut')
                        else:
                            result.append(nline)
                        had_status = True
                        i += 1
                        continue
                    result.append(nline)
                    i += 1
                # Append missing fields before next block
                dec = new_decisions.get(fid, '')
                note = new_notes.get(fid, '')
                if not had_status and dec == 'cut':
                    result.append(f'{block_indent}status: cut')
                if not had_triage and dec and dec != 'cut':
                    result.append(f'{block_indent}triage: {dec}')
                if not had_note and note:
                    result.append(f'{block_indent}triage_note: "{note}"')
                continue  # don't increment, already at next block
        i += 1

    index_path.write_text('\n'.join(result) + '\n', encoding="utf-8")
    _features_cache["data"] = None  # invalidate
    return JSONResponse({"ok": True})


# ── Feature Portal API ──────────────────────────────────────────────

_FEATURES_DIR = REPO_ROOT / "docs" / "features"
_features_cache = {"data": None, "mtime": 0}


def _parse_spec(text):
    """Parse a feature spec markdown into structured sections."""
    sections = {}
    current = None
    lines_buf = []
    for line in text.split('\n'):
        if line.startswith('## '):
            if current:
                sections[current] = '\n'.join(lines_buf).strip()
            current = line[3:].strip()
            lines_buf = []
        elif current is not None:
            lines_buf.append(line)
    if current:
        sections[current] = '\n'.join(lines_buf).strip()

    # Sub-split "How It Works" into ### subsections
    how = sections.get('How It Works', '')
    subs = {}
    cur_sub = None
    sub_buf = []
    for line in how.split('\n'):
        if line.startswith('### '):
            if cur_sub:
                subs[cur_sub] = '\n'.join(sub_buf).strip()
            cur_sub = line[4:].strip()
            sub_buf = []
        else:
            sub_buf.append(line)
    if cur_sub:
        subs[cur_sub] = '\n'.join(sub_buf).strip()

    # Extract key behaviors as a list
    behaviors = []
    btext = subs.get('Key Behaviors', '')
    cur_b = []
    for line in btext.split('\n'):
        if re.match(r'^\d+\.', line.strip()):
            if cur_b:
                behaviors.append('\n'.join(cur_b).strip())
            cur_b = [line.strip()]
        elif cur_b and line.strip():
            cur_b.append(line)
    if cur_b:
        behaviors.append('\n'.join(cur_b).strip())

    # Extract file inventory table
    files = []
    fi_text = sections.get('File Inventory (v1)', '')
    for line in fi_text.split('\n'):
        line = line.strip()
        if not line or '---' in line or line.startswith('| File'):
            continue
        if line.startswith('|'):
            parts = [p.strip().strip('`') for p in line.split('|') if p.strip()]
            if len(parts) >= 3:
                files.append({'file': parts[0], 'lines': parts[1], 'role': parts[2]})

    # Journey footer
    journey_turns = 0
    parts = text.rsplit('---', 1)
    if len(parts) > 1:
        footer = parts[1]
        m = re.search(r'(\d+) DuckDB journey turns', footer)
        if m:
            journey_turns = int(m.group(1))

    return {
        'what_it_does': sections.get('What It Does', ''),
        'why_it_exists': sections.get('Why It Exists', ''),
        'architecture': subs.get('Architecture', ''),
        'key_behaviors': behaviors,
        'api_surface': subs.get('API Surface', ''),
        'state_management': subs.get('State Management', ''),
        'edge_cases': sections.get('Edge Cases & Constraints', ''),
        'decisions': sections.get('Decisions Made', ''),
        'dependencies': sections.get('Dependencies', ''),
        'file_inventory': files,
        'requirements': sections.get('Requirements for 2.0', ''),
        'journey_turns': journey_turns,
    }


@app.get("/api/features")
async def get_features():
    """Serve parsed feature index + spec content for the portal."""
    index_path = _FEATURES_DIR / "_index.yaml"
    if not index_path.exists():
        return JSONResponse({"groups": [], "features": []})

    mtime = int(index_path.stat().st_mtime)
    if _features_cache["data"] and _features_cache["mtime"] == mtime:
        return JSONResponse(_features_cache["data"])

    with open(index_path, encoding="utf-8") as f:
        index = yaml.safe_load(f)

    groups = index.get('groups', [])
    features = []
    for feat in index.get('features', []):
        spec_file = _FEATURES_DIR / feat.get('spec_file', '')
        spec = {}
        if spec_file.exists():
            try:
                spec = _parse_spec(spec_file.read_text(encoding="utf-8"))
            except Exception:
                spec = {}
        features.append({
            'id': feat['id'],
            'name': feat['name'],
            'group': feat['group'],
            'priority': feat.get('priority', 'medium'),
            'complexity': feat.get('complexity', 'medium'),
            'status': feat.get('status', 'draft'),
            'primary_files': feat.get('primary_files', []),
            'supporting_files': feat.get('supporting_files', []),
            'related_features': feat.get('related_features', []),
            'tags': feat.get('duckdb_query_tags', []),
            'ipados_workarounds': feat.get('ipados_workarounds', []),
            'triage': feat.get('triage', ''),
            'triage_note': feat.get('triage_note', ''),
            'spec': spec,
        })

    result = {"groups": groups, "features": features}
    _features_cache["data"] = result
    _features_cache["mtime"] = mtime
    return JSONResponse(result)


@app.get("/app", response_class=HTMLResponse)
async def web_client():
    """Serve the full web client with cache-busting for static assets."""
    html_path = PACKAGE_DIR / "static" / "web-client.html"
    if html_path.exists():
        html = html_path.read_text(encoding="utf-8")
        # Point the entry at the bundle before stamping, so it gets versioned
        # like everything else. Loose modules stay reachable either way.
        if _bundle_path():
            html = html.replace("/static/js/app.js", f"/static/{_BUNDLE_REL}")
        # Computed live (not cached) — this document is the sole source of the
        # version for the whole page load, and it must reflect an edit made a
        # moment ago or the immutable caching below would pin the stale build.
        cache_bust = f"?v={await asyncio.to_thread(_asset_version)}"
        # Add cache bust to /static/*.css and /static/*.js URLs
        html = re.sub(r'(/static/[^"]+\.css)"', rf'\1{cache_bust}"', html)
        html = re.sub(r'(/static/[^"]+\.js)"', rf'\1{cache_bust}"', html)

        # Inject instance identity config for the frontend, into the
        # <script type="application/json"> data block the page ships with.
        # A non-JS type is never executed, so CSP's script-src does not gate
        # it — which is what lets the CSP drop 'unsafe-inline' for scripts.
        # boot.js parses it into window.INSTANCE_CONFIG.
        if instance_config:
            html = html.replace(
                '<script type="application/json" id="instance-config">null</script>',
                '<script type="application/json" id="instance-config">'
                f'{_json_for_html(instance_config)}</script>')

        # Update HTML meta tags for instance
        if instance_config.get("name"):
            name = instance_config["name"]
            html = html.replace('<title>pAInapple Code</title>',
                                f'<title>{name} | pAInapple Code</title>')
            html = html.replace(
                '"apple-mobile-web-app-title" content="pAInapple Code"',
                f'"apple-mobile-web-app-title" content="pAInapple {name}"')
            html = html.replace(
                '"application-name" content="pAInapple Code"',
                f'"application-name" content="pAInapple {name}"')

        # Redirect icon links to instance icons
        if _instance_icons_dir:
            html = html.replace('/static/icons/apple-touch-icon.png',
                                '/instance-icons/apple-touch-icon.png')
            html = html.replace('/static/icons/icon-152.png',
                                '/instance-icons/icon-152.png')
            html = html.replace('/static/icons/icon-180.png',
                                '/instance-icons/icon-180.png')
            html = html.replace('/static/icons/favicon-32.png',
                                '/instance-icons/favicon-32.png')

        # The entry document must never be cached: it is what hands out the
        # version every immutable asset URL is keyed on.
        return HTMLResponse(
            html,
            headers={
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache",
                "Expires": "0",
            },
        )
    return _missing_asset_page(
        "Web client not found",
        f"Expected at <code>{html_path}</code>. The painapple-code install is missing its bundled static assets — try reinstalling the package.",
    )


@app.get("/sw.js")
async def service_worker():
    """Serve service worker from root with auto-versioned cache names."""
    sw_path = PACKAGE_DIR / "static" / "sw.js"
    if sw_path.exists():
        version = await asyncio.to_thread(_asset_version)
        # Precache the app shell at the SAME URLs the page requests, or
        # caches.match() (which keys on the full URL) never hits and the entries
        # are dead weight. One bundle when we ship one, else the core modules.
        shell = [_BUNDLE_REL] if _bundle_path() else [
            "js/app.js",
            "js/session.js",
            "js/config.js",
            "js/utils.js",
            "js/components.js",
            "js/controllers/thinking-controller.js",
            "js/widgets/file-explorer-widget.js",
            "js/widgets/file-preview-widget.js",
        ]
        precache = [
            "/app",
            f"/static/styles.css?v={version}",
            # boot.js is render-blocking on every load and is never part of the
            # module graph, so it is not covered by either arm of `shell`.
            f"/static/js/boot.js?v={version}",
            *[f"/static/{rel}?v={version}" for rel in shell],
            "/static/icons/icon-192.png",
            "/static/icons/icon-512.png",
        ]
        # Inject version into SW
        content = (
            sw_path.read_text(encoding="utf-8")
            .replace("__PRECACHE_ASSETS__", json.dumps(precache))
            .replace("__CACHE_VERSION__", version)
        )
        return Response(
            content=content,
            media_type="application/javascript",
            headers={
                "Service-Worker-Allowed": "/",
                "Cache-Control": "no-cache"
            }
        )
    return Response(content="// SW not found", media_type="application/javascript")


# This is the only public (unauthenticated) route that takes a filesystem
# name, so `filename` is the one attacker-controlled path component that
# never passes an authenticated caller. It must be a bare basename.
#
# `{filename}` compiles to `[^/]+`, which stops POSIX traversal — but a
# backslash is not a slash, and on Windows it IS a separator, so `%5C`
# survives routing and reaches pathlib. Worse, `base / "C:\\..."` DISCARDS
# the base entirely for any absolute right-hand side (same for a `\\host\share`
# UNC, which would additionally make .exists() authenticate outbound to an
# attacker's SMB server). That turned this handler into a pre-auth arbitrary
# file read on Windows — including the bridge password in
# ~/.config/painapple-code/config.yaml, which per SECURITY.md is equivalent
# to a shell. Hence: allowlist the shape, don't blocklist the payloads.
_ICON_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|ico|svg)$")


def _safe_icon_path(base: Path, filename: str) -> Path | None:
    """`base/filename` if it is a plain basename that stays inside `base`."""
    if not _ICON_NAME_RE.match(filename) or ".." in filename:
        return None
    candidate = (base / filename).resolve()
    # Belt and braces: even a name that passes the regex must resolve to
    # somewhere under base (catches a symlink planted in the icons dir).
    if not candidate.is_relative_to(base.resolve()):
        return None
    return candidate


@app.get("/instance-icons/{filename}")
async def serve_instance_icon(filename: str):
    """Serve dynamically generated instance-labeled icons."""
    media = {".svg": "image/svg+xml", ".ico": "image/x-icon"}.get(
        Path(filename).suffix, "image/png")
    for base in (_instance_icons_dir, PACKAGE_DIR / "static" / "icons"):
        if not base:
            continue
        icon_path = _safe_icon_path(Path(base), filename)
        if icon_path and icon_path.is_file():
            return FileResponse(icon_path, media_type=media)
    raise HTTPException(status_code=404, detail="Icon not found")


@app.get("/manifest.json")
async def manifest():
    """Serve PWA manifest, customized for instance identity if configured."""
    manifest_path = PACKAGE_DIR / "static" / "manifest.json"
    if not manifest_path.exists():
        return JSONResponse(content={}, status_code=404)

    data = json.loads(manifest_path.read_text(encoding="utf-8"))

    if instance_config.get("name"):
        name = instance_config["name"]
        data["name"] = f"pAInapple Code {name}"
        data["short_name"] = f"pAInapple {name}"

    if _instance_icons_dir:
        for icon in data.get("icons", []):
            size = icon["sizes"].split("x")[0]
            icon["src"] = f"/instance-icons/icon-{size}.png"

    return JSONResponse(content=data, headers={"Cache-Control": "no-cache"})


@app.get("/sessions")
async def sessions_page():
    """
    Redirect to main app - sessions are now browsed via widget (Ctrl+Shift+K).
    Kept for backwards compatibility with bookmarks/links.
    """
    return RedirectResponse(url="/app", status_code=307)



# ═══════════════════════════════════════════════════════════════════════
# Instance identity (per-deployment theming)
# ═══════════════════════════════════════════════════════════════════════

COLOR_PRESETS = {
    "blue":   {"accent": "#58a6ff", "hover": "#79b8ff", "muted": "#388bfd44"},
    "green":  {"accent": "#22c55e", "hover": "#4ade80", "muted": "#22c55e44"},
    "red":    {"accent": "#f87171", "hover": "#fca5a5", "muted": "#f8717144"},
    "orange": {"accent": "#fb923c", "hover": "#fdba74", "muted": "#fb923c44"},
    "purple": {"accent": "#c084fc", "hover": "#d8b4fe", "muted": "#c084fc44"},
    "cyan":   {"accent": "#06b6d4", "hover": "#22d3ee", "muted": "#06b6d444"},
    "gray":   {"accent": "#9ca3af", "hover": "#cbd5e1", "muted": "#9ca3af44"},
    "yellow": {"accent": "#facc15", "hover": "#fde047", "muted": "#facc1544"},
    "pink":   {"accent": "#f472b6", "hover": "#f9a8d4", "muted": "#f472b644"},
    "teal":   {"accent": "#14b8a6", "hover": "#2dd4bf", "muted": "#14b8a644"},
    "indigo": {"accent": "#818cf8", "hover": "#a5b4fc", "muted": "#818cf844"},
    "lime":   {"accent": "#a3e635", "hover": "#bef264", "muted": "#a3e63544"},
}

# Aliases for common spellings
COLOR_PRESETS["grey"] = COLOR_PRESETS["gray"]


def _generate_instance_icons(name: str, accent_hex: str):
    """Generate PWA icons with instance name label at startup."""
    global _instance_icons_dir
    import tempfile
    from PIL import Image, ImageDraw, ImageFont
    from painapple_code.utils.generate_icons import create_icon, SIZES

    # The data home first — the system temp dir is NOT dependable in a
    # container: under rootless podman's --userns=keep-id, /tmp is sticky
    # but files created there can't be unlinked again, so tempfile rejects
    # it outright ("No usable temporary directory") and takes the whole
    # boot down with it.
    try:
        icons_dir = bridge_paths.BRIDGE_HOME / "instance-icons"
        icons_dir.mkdir(parents=True, exist_ok=True)
        probe = icons_dir / ".probe"
        probe.write_bytes(b"")
        probe.unlink()
    except OSError:
        icons_dir = Path(tempfile.mkdtemp(prefix="painapple-code-icons-"))
    _instance_icons_dir = icons_dir
    # Probe common bold-sans TTF locations across Linux distros + macOS.
    font_candidates = [
        "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial Bold.ttf",
        # Windows: %WINDIR% rather than a hardcoded C:\, since Windows can
        # legitimately live on another drive. Cosmetic only — the
        # load_default() fallback below already keeps boot working.
        str(Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "arialbd.ttf"),
        str(Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "segoeuib.ttf"),
        str(Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "calibrib.ttf"),
    ]
    font_path = next((p for p in font_candidates if Path(p).exists()), None)
    hex_clean = accent_hex.lstrip('#')[:6]
    try:
        accent_rgb = tuple(int(hex_clean[i:i+2], 16) for i in (0, 2, 4))
    except (ValueError, IndexError):
        accent_rgb = (88, 166, 255)  # fallback to blue

    label = name.upper()

    def _load_font(px: int):
        if font_path:
            try:
                return ImageFont.truetype(font_path, px)
            except Exception:
                pass
        # PIL >= 10 supports load_default(size=N) which returns a scalable font
        try:
            return ImageFont.load_default(size=px)
        except TypeError:
            return ImageFont.load_default()

    for size in SIZES:
        img = create_icon(size).convert('RGBA')
        draw = ImageDraw.Draw(img)

        # Colored banner at bottom of icon
        banner_h = max(int(size * 0.28), 18)
        banner_y = size - banner_h
        draw.rectangle([(0, banner_y), (size, size)], fill=(*accent_rgb, 230))

        # Text on banner
        font_size = max(int(banner_h * 0.7), 11)
        font = _load_font(font_size)

        # Anchor "mm" = horizontal+vertical middle of the glyph bbox (proper centering)
        draw.text((size / 2, banner_y + banner_h / 2), label,
                  fill=(255, 255, 255), font=font, anchor="mm")

        # Composite back to RGB
        bg = Image.new('RGB', (size, size), (26, 26, 46))
        bg.paste(img, mask=img.split()[3])

        bg.save(_instance_icons_dir / f"icon-{size}.png", "PNG")
        if size == 180:
            bg.save(_instance_icons_dir / "apple-touch-icon.png", "PNG")

    # Favicon 32px (with tiny label)
    fav = create_icon(32).convert('RGBA')
    draw = ImageDraw.Draw(fav)
    fav_banner_h = 10
    fav_banner_y = 32 - fav_banner_h
    draw.rectangle([(0, fav_banner_y), (32, 32)], fill=(*accent_rgb, 230))
    fav_font = _load_font(8)
    draw.text((16, fav_banner_y + fav_banner_h / 2), label,
              fill=(255, 255, 255), font=fav_font, anchor="mm")
    fav_bg = Image.new('RGB', (32, 32), (26, 26, 46))
    fav_bg.paste(fav, mask=fav.split()[3])
    fav_bg.save(_instance_icons_dir / "favicon-32.png", "PNG")

    logger.info(f"Generated instance icons with label '{label}' in {_instance_icons_dir}")


def _preflight_port(host: str, port: int) -> None:
    """Fail loudly (and on the real stderr) when the bind address is taken.

    uvicorn's own bind error goes to stderr, which setup_logging() has
    redirected into crash.log — so without this the server would just print
    its banner and vanish with no visible reason.
    """
    from painapple_code.cli.netinfo import port_holder, port_taken
    reason = port_taken(host, port)
    if not reason:
        return

    holder = port_holder(port)
    port_flag = f"painapple --port {port + 1}"
    print(f"""
╔══════════════════════════════════════════════════════════════╗
║           pAInapple Code Server — cannot start
╠══════════════════════════════════════════════════════════════╣
║  Port {port} on {host} is already in use.
║  {reason}{(' — held by ' + holder) if holder else ''}
║
║  Try:  {port_flag:<24} (start on another port)
║        {'painapple list':<24} (see running instances)
║        {'painapple stop':<24} (stop a running instance)
╚══════════════════════════════════════════════════════════════╝
""", file=sys.__stderr__ or sys.stdout)
    logger.error(f"Port {port} on {host} already in use — not starting"
                 + (f" (held by {holder})" if holder else ""))
    sys.exit(1)


# Platforms pyca/cryptography no longer publishes wheels for, mapped to the
# pin that still resolves to one. Keep in sync with the `[tls]` extra in
# pyproject.toml and the cryptography block in requirements.txt.
_CRYPTOGRAPHY_GAP = {
    ("ARM64", "win32"): (
        'cryptography<=46.0.3',
        "Windows-on-ARM wheels were suspended upstream at 46.0.4 over CI "
        "instability; restoration is planned but not yet released.",
    ),
    ("x86_64", "darwin"): (
        'cryptography<49',
        "Intel-macOS support was removed upstream in 49.0.0 — macOS wheels "
        "are Apple-Silicon-only now.",
    ),
}


def _tls_unavailable(tls_mode: str, host: str) -> NoReturn:
    """Explain a missing `cryptography` instead of dying on an ImportError.

    On the platforms upstream abandoned we deliberately omit cryptography from
    the default install (see requirements.txt), so this is the expected — not
    exceptional — path for a Windows/ARM64 or Intel-macOS user who binds a
    non-loopback address and trips `--tls auto`.
    """
    import platform
    pin, why = _CRYPTOGRAPHY_GAP.get(
        (platform.machine(), sys.platform),
        # Not a platform we exclude — cryptography is a required dependency
        # here, so its absence means a broken/partial install rather than the
        # deliberate opt-out below.
        ('cryptography',
         "It is a required dependency on this platform, so the install looks "
         "incomplete — reinstalling painapple-code should restore it."),
    )
    trigger = (f"--tls auto turned TLS on because {host} is not loopback."
               if tls_mode == "auto" else "TLS was requested with --tls on.")
    print(f"""
╔══════════════════════════════════════════════════════════════╗
║           pAInapple Code Server — cannot start
╠══════════════════════════════════════════════════════════════╣
║  TLS needs the `cryptography` package, which is not installed.
║  {trigger}
║  {why}
║
║  Install it:  pipx inject painapple-code "{pin}"
║          or:  pip install "painapple-code[tls]"
║
║  Or start without TLS:  painapple --tls off
╚══════════════════════════════════════════════════════════════╝
""", file=sys.__stderr__ or sys.stdout)
    logger.error("TLS requested but `cryptography` is not installed "
                 f"({platform.machine()}/{sys.platform}) — not starting")
    sys.exit(1)


LOOPBACK_HOSTS = ("127.0.0.1", "::1", "localhost")


def credentials_visible(host: str, no_password: bool, show_password: bool) -> bool:
    """Decide whether startup output may include the password / ?tkn= URL.

    Loopback binds print credentials: the only reader is someone on the same
    machine, and the ?tkn= login URL is THE onboarding step. Non-loopback
    binds hide them by default — a LAN/public server's stdout tends to end up
    in journald, docker logs, or a supervisor console that outlives the
    terminal session — and print how to retrieve them instead.
    --no-password always hides; --show-password opts a non-loopback bind
    back in (the parser rejects combining the two).
    """
    if no_password:
        return False
    if show_password:
        return True
    return host in LOOPBACK_HOSTS


def main(argv=None):
    if sys.platform == "win32":  # idempotent; direct-entry safety (cli.main already did it)
        from painapple_code.utils.proc import force_utf8_stdio
        force_utf8_stdio()
    # Parser lives in cli/serve_args.py (import-light) so cli.main() can
    # fast-fail on bad flags / -v / --help without importing this module.
    # By the time we run, cli.main() has already gate-parsed argv — this
    # re-parse (~1ms) keeps main(argv)'s contract unchanged for direct
    # callers and keeps parser.error() available below.
    parser = build_parser()

    # Saved serve defaults (`painapple setup` → serve.yaml) layer between
    # the built-ins and explicit flags: set_defaults() only fills flags
    # absent from argv, so systemd units / docker-entrypoint invocations
    # that pass everything explicitly are unaffected.
    from painapple_code.cli.serve_config import active_config_path, apply_to_parser
    serve_defaults, serve_default_problems = apply_to_parser(parser)

    args = parser.parse_args(argv)

    # Configure logging now that arg parsing has succeeded — deferred from import
    # time so --help/-h and argparse errors stay side-effect-free (no log dir, no
    # open files, no stderr redirect). --log-dir overrides the default location.
    log_dir = Path(args.log_dir).expanduser() if args.log_dir else None
    setup_logging(log_dir=log_dir)
    if args.log_dir:
        logger.info(f"Logging redirected to {log_dir}")

    if serve_defaults:
        logger.info(f"Serve defaults from {active_config_path()}: "
                    f"{', '.join(serve_defaults)} (explicit flags override)")
    for problem in serve_default_problems:
        logger.warning(f"serve.yaml: {problem}")

    # Bail out on a taken port BEFORE any side effects (PID file, icons,
    # shadow DB) — a failed start must not disturb the instance already
    # holding that port.
    _preflight_port(args.host, args.port)

    # Instance identity setup
    global bridge, instance_config
    if args.instance_name or args.accent:
        accent_key = args.accent or "blue"
        if accent_key in COLOR_PRESETS:
            colors = COLOR_PRESETS[accent_key]
        else:
            hex_val = accent_key.lstrip('#')[:6]
            colors = {"accent": f"#{hex_val}", "hover": f"#{hex_val}", "muted": f"#{hex_val}44"}
        instance_config = {"name": args.instance_name or "", **colors}
        if instance_config.get("name"):
            # Labelled PWA icons are pure cosmetics — a missing font, an
            # unwritable dir or a PIL hiccup must never keep the server
            # from booting (it used to take the whole process down).
            try:
                _generate_instance_icons(instance_config["name"], colors["accent"])
            except Exception as e:
                logger.warning(f"Instance icons skipped ({type(e).__name__}: {e}) "
                               f"— serving the default icon set")

    # Server-side chart/excalidraw rendering is OFF by default: model-authored
    # specs auto-render through a Node subprocess whose Vega data loader will
    # fetch external/file: URLs (SSRF / local-file read). Opt in explicitly.
    renderers_enabled = bool(
        args.enable_renderers
        or os.environ.get("PAINAPPLE_ENABLE_RENDERERS", "").strip().lower()
        in ("1", "true", "yes", "on")
    )
    app.state.renderers_enabled = renderers_enabled
    instance_config["renderers_enabled"] = renderers_enabled

    # PTY terminal availability — client hides the terminal widget and
    # shortcut when no backend could be loaded (see PTY_UNAVAILABLE_REASON).
    instance_config["terminal_available"] = TERMINAL_AVAILABLE

    # Path flavor of THIS server's filesystem. The client manipulates
    # server paths (an iPad may be driving a Windows bridge), so it must
    # be told, not sniff navigator.platform — see static/js/path-utils.js.
    instance_config["path_style"] = "windows" if sys.platform == "win32" else "posix"

    # Resolve the trusted-origin set now that port/--public-origin are known.
    # The HTTP + WebSocket Origin checks read this.
    _configured_origins = bool(
        args.public_origin or os.environ.get("BRIDGE_ALLOWED_ORIGINS", "").strip()
    )
    app.state.allowed_origins = resolve_allowed_origins(
        public_origins=args.public_origin or (),
        port=args.port,
    )
    # Only worth a startup line when someone configured it — that's the case
    # where a wrong value locks out a real front-end and wants confirming. The
    # derived loopback default is not "the origins that work" (same-origin
    # traffic never consults this set), so announcing it at INFO just reads as
    # a promise the list isn't making.
    if _configured_origins:
        logger.info(
            "Trusted cross-origin exceptions (configured): %s",
            sorted(app.state.allowed_origins),
        )
    else:
        logger.debug(
            "Trusted cross-origin exceptions (derived loopback default): %s",
            sorted(app.state.allowed_origins),
        )

    # Per-tier UI-state isolation — must run before any state file is read or
    # written (tab-state, shortcuts, presets, favorites, global config).
    if args.state_suffix:
        bridge_paths.init_state_suffix(args.state_suffix)

    if args.shadow_db:
        from painapple_code.shadow_db import init_shadow_db
        init_shadow_db(Path(args.shadow_db).expanduser())

    # Write PID file for post-mortem crash analysis
    from painapple_code.server_logging import DEFAULT_LOG_DIR
    pid_log_dir = Path(args.log_dir).expanduser() if args.log_dir else DEFAULT_LOG_DIR
    pid_file = pid_log_dir / "server.pid"
    pid_file.write_text(str(os.getpid()), encoding="utf-8")
    atexit.register(lambda: pid_file.unlink(missing_ok=True))

    if args.default_provider:
        from painapple_code.providers import provider_names
        if args.default_provider not in provider_names():
            parser.error(
                f"unknown provider {args.default_provider!r} "
                f"(registered: {', '.join(provider_names())})"
            )

    bridge = AgentBridge(default_cwd=args.workspace,
                         default_provider=args.default_provider)

    # Stash on app.state so route modules can read it without the
    # `from server import bridge` trap — running as __main__ creates a
    # separate `server` module instance where bridge stays None.
    app.state.bridge = bridge
    app.state.workspace = args.workspace

    # --workspace IS the root: the dir that holds the project subdirs, not
    # one project. Sessions pick their own cwd from the welcome screen and
    # files/git/terminal follow THAT, so this only anchors discovery (the
    # welcome "Unvisited" chips, the file-explorer browse root) and supplies
    # a fallback cwd for sessions created without one. Stored as absolute
    # string (or None) for route modules to read.
    try:
        app.state.workspace_root = str(Path(args.workspace).expanduser().resolve())
    except (OSError, RuntimeError):
        app.state.workspace_root = None

    # Load config file and populate auth state (fails open if the directory
    # can't be written — intentional: we want a noisy permissions error).
    cfg_override = Path(args.auth_config_file).expanduser() if args.auth_config_file else None
    init_auth_state(app, config_file=cfg_override)

    # TLS: 'auto' enables when binding non-loopback. Clients accept the
    # self-signed cert without verification (no pinning, no OS trust install)
    # — TLS here guards against passive snooping only; MITM is accepted.
    loopback_hosts = LOOPBACK_HOSTS
    use_tls = args.tls == "on" or (args.tls == "auto" and args.host not in loopback_hosts)
    show_credentials = credentials_visible(
        args.host, args.no_password, getattr(args, "show_password", False))
    tls_cert_path: Optional[Path] = None
    tls_key_path: Optional[Path] = None
    config_dir = Path(app.state.auth_config_file).parent
    # Older builds wrote a cert-fingerprint sidecar for bootstrap-URL pinning;
    # pinning is gone, so clear any stale copy external tools might read.
    (config_dir / "fingerprint").unlink(missing_ok=True)
    if use_tls:
        try:
            from painapple_code.tls_cert import ensure_cert
        except ImportError as exc:
            # Only the optional-dependency case gets the friendly box; anything
            # else importing badly is a real bug and should keep its traceback.
            if not (exc.name or "").startswith("cryptography"):
                raise
            _tls_unavailable(args.tls, args.host)
        tls_cert_path = Path(args.tls_cert).expanduser() if args.tls_cert else config_dir / "cert.pem"
        tls_key_path = Path(args.tls_key).expanduser() if args.tls_key else config_dir / "key.pem"
        ensure_cert(tls_cert_path, tls_key_path)

    scheme = "https" if use_tls else "http"
    ws_scheme = "wss" if use_tls else "ws"

    # The bootstrap link carries the derived api_token, never the password —
    # a link is the most-shared, most-logged artifact we emit, and this one
    # can be revoked (bump bearer_epoch) without a password rotation.
    login_url = f"{scheme}://{args.host}:{args.port}/?tkn={app.state.auth_api_token}"
    if app.state.auth_newly_created:
        logger.warning(
            f"Auth config generated at {app.state.auth_config_file}. "
            + (f"Log in once via: {login_url}" if show_credentials
               else "Credentials hidden — run `painapple password` to reveal.")
        )
    # (the config path, the password and the login URL are all in the startup
    #  box below — no need to repeat them as INFO lines here)

    if args.host not in ("127.0.0.1", "::1", "localhost"):
        logger.warning(
            f"Binding to {args.host} (non-loopback). Auth is mandatory — "
            f"config at {app.state.auth_config_file}"
        )
        logger.warning(
            "X-Forwarded-* is trusted only from 127.0.0.1/::1 by default. If "
            "your reverse proxy is on another host, set FORWARDED_ALLOW_IPS to "
            "its address (and ensure it strips client-provided X-Forwarded-* "
            "and sets X-Forwarded-Proto). Set --public-origin/BRIDGE_ALLOWED_ORIGINS "
            "to your external origin so the CSRF/Origin checks accept it."
        )
        if not use_tls:
            logger.warning(
                "TLS is OFF on a non-loopback bind — every request, the "
                "auth token, and chat contents travel the LAN unencrypted. "
                "Use --tls=auto (default) unless you have a reason."
            )

    instance_line = ""
    if instance_config.get("name"):
        instance_line = f"\n║  Instance:       {instance_config['name']} (accent: {instance_config.get('accent', 'default')})"

    from painapple_code.shadow_db import DB_PATH as _default_db_path
    shadow_db_path = Path(args.shadow_db).expanduser() if args.shadow_db else _default_db_path
    shadow_db_line = f"\n║  Shadow DB:      {shadow_db_path}"
    log_dir_line = f"\n║  Log Dir:        {pid_log_dir}"
    state_suffix_line = ""
    if bridge_paths.STATE_SUFFIX:
        state_suffix_line = f"\n║  State:          suffix '{bridge_paths.STATE_SUFFIX}' (tab-state/shortcuts/presets/favorites/config)"
    tls_line = ""
    if use_tls:
        tls_line = f"\n║  TLS Cert:       {tls_cert_path} (self-signed, unverified by clients)"

    # The login URL is THE line users need — labelled with the product name
    # (it IS where the app lives, token included) and painted bold green so it
    # stands out from the rest of the box (TTY-only; cli.ui's constants
    # are empty strings when piped or NO_COLOR is set). When credentials
    # are hidden (--no-password, or any non-loopback bind without
    # --show-password) the box still shows WHERE to log in, but the
    # password and the ?tkn= query are withheld from stdout.
    # NOTE: every label in the box is padded to a 16-char field so the values
    # line up — "pAInapple Code:" is the longest and sets that width.
    from painapple_code.cli.ui import BOLD, DIM, GREEN, RESET as _ANSI_RESET
    if not show_credentials:
        why = ("--no-password" if args.no_password
               else "non-loopback bind; --show-password overrides")
        auth_lines = (
            f"\n║  Password:       {DIM}(hidden: {why} — run `painapple password` to reveal){_ANSI_RESET}"
            f"\n║  {BOLD}pAInapple Code:{_ANSI_RESET} {BOLD}{GREEN}{scheme}://{args.host}:{args.port}/{_ANSI_RESET}"
        )
    else:
        auth_lines = (
            f"\n║  Password:       {app.state.auth_password}"
            f"\n║  {BOLD}pAInapple Code:{_ANSI_RESET} {BOLD}{GREEN}{login_url}{_ANSI_RESET}"
        )

    print(f"""
╔══════════════════════════════════════════════════════════════╗
║           pAInapple Code Server                              ║
╠══════════════════════════════════════════════════════════════╣
║  WebSocket:      {ws_scheme}://{args.host}:{args.port}/chat
║  Files API:      {scheme}://{args.host}:{args.port}/api/files
║  Workspace:      {args.workspace}{instance_line}{shadow_db_line}{log_dir_line}{state_suffix_line}
║  Auth File:      {app.state.auth_config_file}{tls_line}{auth_lines}
╚══════════════════════════════════════════════════════════════╝
    """)

    # Trust X-Forwarded-* only from loopback by default (a reverse proxy on
    # the same host). A remote proxy sets FORWARDED_ALLOW_IPS explicitly. The
    # old "*" let ANY direct client spoof X-Forwarded-Proto and flip the
    # cookie Secure flag.
    forwarded_allow_ips = os.environ.get("FORWARDED_ALLOW_IPS", "").strip() or "127.0.0.1,::1"
    common_kwargs = dict(
        log_level="info",
        limit_concurrency=100,
        timeout_keep_alive=30,
        proxy_headers=True,
        forwarded_allow_ips=forwarded_allow_ips,
    )

    configs = []
    if use_tls:
        configs.append(uvicorn.Config(
            app, host=args.host, port=args.port,
            ssl_keyfile=str(tls_key_path), ssl_certfile=str(tls_cert_path),
            **common_kwargs,
        ))
        # Plain HTTP loopback companion — different bind addr, same port (OK
        # on Linux/macOS). Skip when the primary listener already covers
        # loopback (0.0.0.0/::), and skip when bind is itself loopback.
        if args.host not in ("0.0.0.0", "::", *loopback_hosts):
            configs.append(uvicorn.Config(
                app, host="127.0.0.1", port=args.port,
                # Both listeners serve the SAME app object, so the second
                # one must not run the lifespan again — it would start the
                # bridge twice and log every startup/shutdown line twice.
                lifespan="off",
                **common_kwargs,
            ))
    else:
        configs.append(uvicorn.Config(
            app, host=args.host, port=args.port,
            **common_kwargs,
        ))

    if len(configs) == 1:
        uvicorn.Server(configs[0]).run()
    else:
        async def serve_all():
            servers = [uvicorn.Server(c) for c in configs]
            await asyncio.gather(*[s.serve() for s in servers])
        asyncio.run(serve_all())


if __name__ == "__main__":
    main()
