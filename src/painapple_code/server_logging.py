"""
Server Logging Configuration

Provides structured, file-based logging with rotation.

Log files:
    logs/
    ├── server.log       # All INFO+ messages (rotates at 10MB, keeps 5)
    ├── error.log        # ERROR+ only (rotates at 5MB, keeps 10)
    └── access.log       # HTTP/WebSocket access log (rotates at 10MB, keeps 3)
"""

import logging
import re
import sys
import traceback
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path

from painapple_code import paths

# Redact ?tkn=<password> and ?dl=<download-token> from logged query strings.
# Matches the whole value up to the next `&` or end-of-string, including
# URL-encoded password bytes.
_TKN_REDACT_RE = re.compile(r"(?:^|(?<=[?&]))(tkn|dl)=[^&]*")


def redact_query(query: str) -> str:
    """Replace tkn=/dl= values with REDACTED anywhere in a query string."""
    if not query:
        return query
    lowered = query.lower()
    if "tkn=" not in lowered and "dl=" not in lowered:
        return query
    return _TKN_REDACT_RE.sub(r"\1=REDACTED", query)

# Default log directory - centralized under DATA_HOME (~/.painapple-code/logs/
# by default, or $PAINAPPLE_CODE_HOME/logs/ when the env var is set).
DEFAULT_LOG_DIR = paths.DATA_HOME / "logs"


def setup_logging(
    log_dir: Path = None,
    console_level: int = logging.INFO,
    file_level: int = logging.DEBUG,
) -> logging.Logger:
    """
    Configure logging for the server.

    Args:
        log_dir: Directory for log files (created if doesn't exist)
        console_level: Minimum level for console output
        file_level: Minimum level for file output

    Returns:
        The root logger for 'painapple-code'
    """
    log_dir = Path(log_dir) if log_dir else DEFAULT_LOG_DIR
    log_dir.mkdir(parents=True, exist_ok=True)

    # Create formatters
    console_formatter = logging.Formatter(
        '%(asctime)s %(levelname)-8s %(message)s',
        datefmt='%H:%M:%S'
    )

    file_formatter = logging.Formatter(
        '%(asctime)s | %(levelname)-8s | %(name)-20s | %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )

    detailed_formatter = logging.Formatter(
        '%(asctime)s | %(levelname)-8s | %(name)s | %(filename)s:%(lineno)d | %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )

    # Get root logger for our app
    logger = logging.getLogger("painapple-code")
    logger.setLevel(logging.DEBUG)  # Capture everything, handlers filter

    # Clear any existing handlers
    logger.handlers.clear()

    # ─────────────────────────────────────────────────────────────────
    # Console Handler (INFO+)
    # ─────────────────────────────────────────────────────────────────
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(console_level)
    console_handler.setFormatter(console_formatter)
    logger.addHandler(console_handler)

    # ─────────────────────────────────────────────────────────────────
    # Main Server Log (INFO+, 10MB rotation, keep 5)
    # ─────────────────────────────────────────────────────────────────
    server_log = log_dir / "server.log"
    server_handler = RotatingFileHandler(
        server_log,
        maxBytes=10 * 1024 * 1024,  # 10MB
        backupCount=5,
        encoding='utf-8'
    )
    server_handler.setLevel(file_level)
    server_handler.setFormatter(file_formatter)
    logger.addHandler(server_handler)

    # ─────────────────────────────────────────────────────────────────
    # Error Log (ERROR+, 5MB rotation, keep 10)
    # ─────────────────────────────────────────────────────────────────
    error_log = log_dir / "error.log"
    error_handler = RotatingFileHandler(
        error_log,
        maxBytes=5 * 1024 * 1024,  # 5MB
        backupCount=10,
        encoding='utf-8'
    )
    error_handler.setLevel(logging.ERROR)
    error_handler.setFormatter(detailed_formatter)
    logger.addHandler(error_handler)

    # Redirect stderr to crash.log — captures uvicorn errors, unhandled
    # exceptions, and signal info that otherwise vanish
    crash_log = log_dir / "crash.log"
    crash_file = open(crash_log, 'a', buffering=1, encoding="utf-8")  # line-buffered
    sys.stderr = crash_file

    # …but never at the cost of the console. With stderr pointed at a
    # file, a crash during startup exits silently: in a container all the
    # operator sees is the process going away, and the traceback is
    # sitting inside a volume they now have to go spelunking in (which is
    # exactly how a boot-time PermissionError went undiagnosed).
    # Uncaught exceptions therefore go to BOTH.
    console = sys.__stderr__

    def _hook(exc_type, exc, tb, _console=console, _crash=crash_file):
        for stream in (_crash, _console):
            if stream is None or stream.closed:
                continue
            try:
                traceback.print_exception(exc_type, exc, tb, file=stream)
                stream.flush()
            except (OSError, ValueError):
                pass  # a closed/broken console must not mask the crash

    sys.excepthook = _hook

    # Reconfigure the access logger to honour the same log_dir. Its handler
    # is normally created lazily on first use of get_access_logger() at module
    # import time (before --log-dir is parsed), so without this it would keep
    # writing to DEFAULT_LOG_DIR.
    access_logger = logging.getLogger("painapple-code.access")
    for h in list(access_logger.handlers):
        access_logger.removeHandler(h)
        h.close()
    get_access_logger(log_dir)

    # Log startup
    logger.info(f"Logging initialized: {log_dir}")
    logger.info(f"  server.log: INFO+ (10MB rotation, 5 backups)")
    logger.info(f"  error.log:  ERROR+ (5MB rotation, 10 backups)")
    logger.info(f"  access.log: INFO  (10MB rotation, 3 backups)")
    logger.info(f"  crash.log:  stderr redirect (append)")

    return logger


def get_access_logger(log_dir: Path = None) -> logging.Logger:
    """
    Get a dedicated access logger for HTTP/WebSocket requests.

    Format: timestamp | method | path | status | duration | client_ip
    """
    log_dir = Path(log_dir) if log_dir else DEFAULT_LOG_DIR
    log_dir.mkdir(parents=True, exist_ok=True)

    logger = logging.getLogger("painapple-code.access")
    logger.setLevel(logging.INFO)

    # Only add handler if not already present
    if not logger.handlers:
        access_log = log_dir / "access.log"
        handler = RotatingFileHandler(
            access_log,
            maxBytes=10 * 1024 * 1024,  # 10MB
            backupCount=3,
            encoding='utf-8'
        )
        handler.setLevel(logging.INFO)
        handler.setFormatter(logging.Formatter('%(message)s'))
        logger.addHandler(handler)

        # Don't propagate to root logger (avoid duplicate console output)
        logger.propagate = False

    return logger


class AccessLogMiddleware:
    """
    ASGI middleware for logging HTTP requests.

    Logs: timestamp | method | path | status | duration_ms | client_ip
    """

    def __init__(self, app, logger: logging.Logger = None):
        self.app = app
        self.logger = logger or get_access_logger()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        start_time = datetime.now(timezone.utc)
        status_code = 0

        async def send_wrapper(message):
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            # Calculate duration
            duration_ms = (datetime.now(timezone.utc) - start_time).total_seconds() * 1000

            # Extract request info
            method = scope.get("method", "?")
            path = scope.get("path", "/")
            query = scope.get("query_string", b"").decode()
            if query:
                path = f"{path}?{redact_query(query)}"

            # Get client IP
            client = scope.get("client", ("?", 0))
            client_ip = client[0] if client else "?"

            # Log the request
            self.logger.info(
                f"{start_time.strftime('%Y-%m-%d %H:%M:%S')} | "
                f"{method:7} | {path:50} | {status_code:3} | "
                f"{duration_ms:7.1f}ms | {client_ip}"
            )


def log_websocket_event(
    logger: logging.Logger,
    event: str,
    session_id: str = None,
    client_ip: str = None,
    details: str = None
):
    """Log a WebSocket event to the access log."""
    timestamp = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
    session_str = session_id[:11] if session_id else "no-session"
    client_str = client_ip or "?"
    details_str = f" | {details}" if details else ""

    logger.info(
        f"{timestamp} | WS {event:10} | session={session_str:11} | {client_str}{details_str}"
    )
