"""
Chart rendering utilities — converts Vega-Lite .vl.json to SVG.

Uses vega + vega-lite via Node.js subprocess (tools/vegalite-to-svg.js).
Includes in-memory cache keyed by file content hash.
No DOM or canvas polyfills needed — Vega renders SVG natively in headless mode.
"""

import asyncio
import hashlib
import logging
from pathlib import Path

from painapple_code import PACKAGE_DIR

logger = logging.getLogger(__name__)

# Path to the Node renderer script (shipped in package)
_SCRIPT = PACKAGE_DIR / "tools" / "vegalite-to-svg.js"

# Simple in-memory cache: content_hash -> svg_string
_cache: dict[str, str] = {}
_MAX_CACHE = 50  # max cached renderings


async def render_chart(source: str | bytes, dark_mode: bool = False) -> str:
    """Render Vega-Lite JSON to SVG string.

    Args:
        source: Vega-Lite JSON string or bytes
        dark_mode: If True, render with dark mode theme
    Returns:
        SVG string
    Raises:
        RuntimeError: If rendering fails
    """
    if isinstance(source, str):
        source = source.encode('utf-8')

    # Check cache
    content_hash = hashlib.md5(source + (b'dark' if dark_mode else b'')).hexdigest()
    if content_hash in _cache:
        return _cache[content_hash]

    if not _SCRIPT.exists():
        raise RuntimeError(f"Chart renderer not found: {_SCRIPT}")

    cmd = ["node", str(_SCRIPT)]
    if dark_mode:
        cmd.append("--dark")

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(input=source), timeout=15.0
        )
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError("Chart render timed out (15s)")

    if proc.returncode != 0:
        error_msg = stderr.decode('utf-8', errors='replace').strip()
        raise RuntimeError(f"Chart render failed: {error_msg}")

    svg = stdout.decode('utf-8')

    # Cache result (evict oldest if full)
    if len(_cache) >= _MAX_CACHE:
        oldest = next(iter(_cache))
        del _cache[oldest]
    _cache[content_hash] = svg

    # Log non-fatal warnings from stderr
    if stderr:
        for line in stderr.decode('utf-8', errors='replace').strip().split('\n'):
            if line:
                logger.debug("vegalite-to-svg: %s", line)

    return svg


def is_chart_file(path: str | Path) -> bool:
    """Check if a file is a Vega-Lite chart (.vl.json)."""
    return str(path).lower().endswith('.vl.json')


async def render_chart_file(path: Path, dark_mode: bool = False) -> str:
    """Render a .vl.json file to SVG string.

    Args:
        path: Path to .vl.json file
        dark_mode: If True, render with dark mode theme
    Returns:
        SVG string
    """
    content = path.read_bytes()
    return await render_chart(content, dark_mode=dark_mode)
