"""
File Viewer API Routes - Raw file serving and full-screen file viewer

These endpoints provide:
- Raw file serving with correct MIME types (for images, etc.)
- Full-screen file viewer page (images, markdown, code, excalidraw, charts)
- Excalidraw JSON → SVG rendering via Node.js subprocess
- Vega-Lite chart JSON → SVG rendering via Node.js subprocess
"""

import logging
from typing import NoReturn

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, FileResponse, Response

from painapple_code.utils.file_paths import is_path_allowed_for_read, safe_resolve
from painapple_code.utils.excalidraw import render_excalidraw, render_excalidraw_file, is_excalidraw_file
from painapple_code.utils.chart import render_chart, render_chart_file, is_chart_file
from painapple_code.viewer_templates import (
    usage_page, access_denied_page, not_found_page, error_page,
    image_viewer, markdown_viewer, code_viewer, get_language,
    excalidraw_viewer, chart_viewer,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["viewer"])


# MIME types for common file extensions
MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.pdf': 'application/pdf',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.py': 'text/x-python',
    '.js': 'text/javascript',
    '.ts': 'text/typescript',
    '.html': 'text/html',
    '.css': 'text/css',
    '.sh': 'text/x-shellscript',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.toml': 'text/toml',
}

IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'}

# SVG is a scriptable format. These endpoints render SVG from model- or
# repo-authored specs and serve it same-origin, so a top-level navigation to
# one of them would otherwise run its script in the server origin. Forcing an
# opaque origin (sandbox with no allow-same-origin) removes that: the document
# can neither read the auth cookie nor issue credentialed same-origin calls.
# Mirrors the policy api_browser.py applies to proxied/local HTML and SVG.
# Harmless for the normal consumption paths — browsers ignore CSP on image
# subresources (<img src>), and fetch()+innerHTML never applies it as a policy.
_SVG_SECURITY_HEADERS = {
    'Content-Security-Policy': "sandbox allow-scripts allow-forms",
    'X-Content-Type-Options': 'nosniff',
}


def _renderers_enabled(request: Request) -> bool:
    """Server-side chart/excalidraw rendering gate. Defaults to False (secure)
    when unset — e.g. under a bare TestClient that never ran server.main()."""
    return bool(getattr(request.app.state, "renderers_enabled", False))


def _reject_renderer_disabled() -> NoReturn:
    """Refuse when rendering is off. Never spawns the Node subprocess, so the
    model-authored-spec SSRF/file-read vector cannot fire. Always raises."""
    raise HTTPException(status_code=503, detail="Server-side rendering is disabled")


@router.get("/api/file-raw")
async def get_file_raw(request: Request, path: str, dark: bool = False):
    """Serve a raw file with correct MIME type (for images, etc.)."""
    try:
        p = safe_resolve(path)

        if not is_path_allowed_for_read(p):
            raise HTTPException(status_code=403, detail="Path not allowed")
        if not p.exists():
            raise HTTPException(status_code=404, detail="File not found")
        if not p.is_file():
            raise HTTPException(status_code=400, detail="Not a file")

        suffix = p.suffix.lower()

        # Server-side rendering is gated: when disabled, fall through to raw
        # serving so the Node renderer is never invoked (SSRF/file-read guard).
        renderers_on = _renderers_enabled(request)

        # Excalidraw files: render to SVG on-the-fly (.excalidraw or .excalidraw.md)
        if renderers_on and is_excalidraw_file(p):
            try:
                svg_content = await render_excalidraw_file(p, dark_mode=dark)
                return Response(
                    content=svg_content,
                    media_type='image/svg+xml',
                    headers={'Cache-Control': 'no-cache', **_SVG_SECURITY_HEADERS},
                )
            except Exception as e:
                logger.error("Excalidraw render failed for %s: %s", p, e)
                raise HTTPException(status_code=500, detail=f"Render failed: {e}")

        # Vega-Lite chart files: render to SVG on-the-fly (.vl.json)
        if renderers_on and is_chart_file(p):
            try:
                svg_content = await render_chart_file(p, dark_mode=dark)
                return Response(
                    content=svg_content,
                    media_type='image/svg+xml',
                    headers={'Cache-Control': 'no-cache', **_SVG_SECURITY_HEADERS},
                )
            except Exception as e:
                logger.error("Chart render failed for %s: %s", p, e)
                raise HTTPException(status_code=500, detail=f"Render failed: {e}")

        mime_type = MIME_TYPES.get(suffix, 'application/octet-stream')

        return FileResponse(
            path=str(p),
            media_type=mime_type,
            filename=p.name,
            headers={'Cache-Control': 'no-cache'},
        )
    except HTTPException:
        raise
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/view", response_class=HTMLResponse)
async def file_viewer(path: str = None):
    """Full-screen file viewer page (images, markdown, code)."""
    if not path:
        return usage_page()

    try:
        p = safe_resolve(path)

        if not is_path_allowed_for_read(p):
            return access_denied_page(path)

        if not p.exists():
            return not_found_page(path)

        suffix = p.suffix.lower()

        # Excalidraw viewer (.excalidraw or .excalidraw.md — must check before .md)
        if is_excalidraw_file(p):
            return excalidraw_viewer(p.name, str(p))

        # Vega-Lite chart viewer (.vl.json — must check before generic .json)
        if is_chart_file(p):
            return chart_viewer(p.name, str(p))

        # Image viewer
        if suffix in IMAGE_SUFFIXES:
            return image_viewer(p.name, str(p), str(p))

        # Markdown viewer
        if suffix == '.md':
            content = p.read_text(encoding="utf-8", errors='replace')
            return markdown_viewer(p.name, str(p), content)

        # Code/text viewer
        content = p.read_text(encoding="utf-8", errors='replace')
        lang = get_language(suffix)
        return code_viewer(p.name, str(p), content, lang)

    except Exception as e:
        return error_page(str(e))


@router.post("/api/excalidraw/render")
async def render_excalidraw_json(request: Request, dark: bool = False):
    """Render excalidraw JSON body to SVG. Used for inline chat rendering."""
    if not _renderers_enabled(request):
        _reject_renderer_disabled()
    try:
        body = await request.body()
        if not body:
            raise HTTPException(status_code=400, detail="Empty body")
        svg_content = await render_excalidraw(body, dark_mode=dark)
        return Response(
            content=svg_content,
            media_type='image/svg+xml',
            headers=_SVG_SECURITY_HEADERS,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        logger.error("Excalidraw render failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/chart/render")
async def render_chart_json(request: Request, dark: bool = False):
    """Render Vega-Lite JSON body to SVG. Used for inline chat rendering."""
    if not _renderers_enabled(request):
        _reject_renderer_disabled()
    try:
        body = await request.body()
        if not body:
            raise HTTPException(status_code=400, detail="Empty body")
        svg_content = await render_chart(body, dark_mode=dark)
        return Response(
            content=svg_content,
            media_type='image/svg+xml',
            headers=_SVG_SECURITY_HEADERS,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        logger.error("Chart render failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
