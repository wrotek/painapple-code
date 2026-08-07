"""
Viewer HTML Templates - Full-screen file viewer pages

Provides HTML template functions for the /view endpoint:
- error_page: Generic error display
- usage_page: /view without a path
- access_denied_page: Path not allowed
- not_found_page: File doesn't exist
- image_viewer: Image display with download
- markdown_viewer: Markdown rendering with marked.js
- code_viewer: Code display with highlight.js + font controls
- excalidraw_viewer: Excalidraw diagram with pan/zoom (via _svg_viewer)
- chart_viewer: Vega-Lite chart with pan/zoom (via _svg_viewer)

To add a new SVG-based viewer, call _svg_viewer() with loading/error text.
"""

import base64
import html
from urllib.parse import quote


def _page(title: str, body: str) -> str:
    """Minimal error/info page."""
    return f"""<!DOCTYPE html>
<html><head><title>{title}</title></head>
<body style="background:#1a1a2e;color:#e0e0e0;font-family:system-ui;padding:2rem;">
<h1>{title}</h1>
{body}
</body></html>"""


def usage_page() -> str:
    return _page("File Viewer", "<p>Usage: /view?path=/path/to/file</p>")


def access_denied_page(path: str) -> str:
    return _page("Access Denied", f"<p>Path not allowed: {html.escape(path)}</p>")


def not_found_page(path: str) -> str:
    return _page("File Not Found", f"<p>{html.escape(path)}</p>")


def error_page(message: str) -> str:
    return _page("Error", f"<p>{html.escape(str(message))}</p>")


def image_viewer(filename: str, file_path: str, url_path: str) -> str:
    """Full-screen image viewer with download link."""
    safe_name = html.escape(filename)
    safe_path = html.escape(file_path)
    encoded_path = quote(file_path, safe='/:@')

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
    <title>{safe_name}</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            background: #0a0a0a;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
        }}
        .header {{
            background: #1a1a2e;
            padding: 0.75rem 1rem;
            display: flex;
            align-items: center;
            gap: 1rem;
            border-bottom: 1px solid #333;
        }}
        .header h1 {{
            font-size: 1rem;
            color: #e0e0e0;
            font-weight: 500;
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }}
        .header a {{
            color: #3b82f6;
            text-decoration: none;
            font-size: 0.875rem;
        }}
        .image-container {{
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 1rem;
            overflow: auto;
        }}
        img {{
            max-width: 100%;
            max-height: calc(100vh - 60px);
            object-fit: contain;
            border-radius: 4px;
        }}
        .path {{
            font-family: monospace;
            font-size: 0.75rem;
            color: #666;
            padding: 0.5rem 1rem;
            background: #111;
            border-top: 1px solid #333;
        }}
    </style>
</head>
<body>
    <div class="header">
        <h1>{safe_name}</h1>
        <a href="/api/file-raw?path={encoded_path}" download>Download</a>
    </div>
    <div class="image-container">
        <img src="/api/file-raw?path={encoded_path}" alt="{safe_name}">
    </div>
    <div class="path">{safe_path}</div>
</body>
</html>"""


def markdown_viewer(filename: str, file_path: str, content: str) -> str:
    """Markdown viewer with marked.js rendering."""
    safe_name = html.escape(filename)
    encoded_path = quote(file_path, safe='/:@')
    # Pass the (untrusted) file content as base64 in a data attribute rather than
    # inlining it in a JS template literal — a raw `</script>` in the file would
    # otherwise break out of the inline <script> at HTML-parse time, before
    # marked/DOMPurify ever run. base64 is inert until decoded.
    content_b64 = base64.b64encode(content.encode('utf-8')).decode('ascii')

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{safe_name}</title>
    <script src="/static/vendor/marked.min.js"></script>
    <script src="/static/vendor/purify.min.js"></script>
    <link rel="stylesheet" href="/static/vendor/github-markdown-dark.min.css">
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            background: #0d1117;
            min-height: 100vh;
        }}
        .header {{
            background: #161b22;
            padding: 0.75rem 1rem;
            display: flex;
            align-items: center;
            gap: 1rem;
            border-bottom: 1px solid #30363d;
            position: sticky;
            top: 0;
            z-index: 100;
        }}
        .header h1 {{
            font-size: 1rem;
            color: #e6edf3;
            font-weight: 500;
            flex: 1;
        }}
        .header a {{
            color: #58a6ff;
            text-decoration: none;
            font-size: 0.875rem;
        }}
        .markdown-body {{
            padding: 2rem;
            max-width: 980px;
            margin: 0 auto;
        }}
        .markdown-body pre {{
            background: #161b22;
        }}
    </style>
</head>
<body>
    <div class="header">
        <h1>{safe_name}</h1>
        <a href="/api/file-raw?path={encoded_path}" download>Raw</a>
    </div>
    <article class="markdown-body" id="content" data-md="{content_b64}"></article>
    <script>
        // Decode the base64 file content, then sanitize marked's output — the file
        // content is untrusted (any readable file can be viewed here), so raw
        // HTML/script in a .md must neither break out of this script nor execute.
        const el = document.getElementById('content');
        const content = decodeURIComponent(escape(atob(el.dataset.md)));
        el.innerHTML = DOMPurify.sanitize(marked.parse(content));
    </script>
</body>
</html>"""


def code_viewer(filename: str, file_path: str, content: str, lang: str) -> str:
    """Code viewer with highlight.js and font size controls."""
    safe_name = html.escape(filename)
    safe_path = html.escape(file_path)
    encoded_path = quote(file_path, safe='/:@')
    content_html = (content
        .replace('&', '&amp;')
        .replace('<', '&lt;')
        .replace('>', '&gt;'))

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>{safe_name}</title>
    <script src="/static/vendor/highlight.min.js"></script>
    <script src="/static/vendor/highlight-lang-dockerfile.min.js"></script>
    <script src="/static/vendor/highlight-lang-scala.min.js"></script>
    <script src="/static/vendor/highlight-lang-nginx.min.js"></script>
    <script src="/static/vendor/highlight-lang-properties.min.js"></script>
    <link rel="stylesheet" href="/static/vendor/highlight-github-dark.min.css">
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        html, body {{
            background: #0d1117;
            -webkit-overflow-scrolling: touch;
        }}
        .header {{
            background: #161b22;
            padding: 0.75rem 1rem;
            display: flex;
            align-items: center;
            gap: 0.75rem;
            border-bottom: 1px solid #30363d;
            position: sticky;
            top: 0;
            z-index: 100;
        }}
        .header h1 {{
            font-size: 1rem;
            color: #e6edf3;
            font-weight: 500;
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }}
        .header-controls {{
            display: flex;
            align-items: center;
            gap: 0.5rem;
            flex-shrink: 0;
        }}
        .font-controls {{
            display: flex;
            align-items: center;
            gap: 0.25rem;
            background: #21262d;
            border-radius: 6px;
            padding: 0.25rem;
        }}
        .font-btn {{
            background: transparent;
            border: none;
            color: #8b949e;
            width: 28px;
            height: 28px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.875rem;
            font-weight: 600;
            display: flex;
            align-items: center;
            justify-content: center;
        }}
        .font-btn:hover, .font-btn:active {{
            background: #30363d;
            color: #e6edf3;
        }}
        .font-size-label {{
            color: #8b949e;
            font-size: 0.75rem;
            min-width: 32px;
            text-align: center;
        }}
        .header a {{
            color: #58a6ff;
            text-decoration: none;
            font-size: 0.875rem;
        }}
        pre {{
            margin: 0;
            padding: 1rem;
            font-size: var(--code-font-size, 14px);
            line-height: 1.5;
            background: #0d1117;
            color: #c9d1d9;
            overflow-x: auto;
            -webkit-overflow-scrolling: touch;
        }}
        code {{
            font-family: 'SF Mono', Consolas, monospace;
            color: inherit;
            display: block;
            width: fit-content;
            min-width: 100%;
        }}
        .hljs {{
            background: #0d1117;
            padding: 0;
        }}
        .path {{
            font-family: monospace;
            font-size: 0.75rem;
            color: #8b949e;
            padding: 0.75rem 1rem;
            background: #161b22;
            border-top: 1px solid #30363d;
        }}
    </style>
</head>
<body>
    <header class="header">
        <h1>{safe_name}</h1>
        <div class="header-controls">
            <div class="font-controls">
                <button class="font-btn" id="font-decrease" title="Decrease font size">A-</button>
                <span class="font-size-label" id="font-size-label">14</span>
                <button class="font-btn" id="font-increase" title="Increase font size">A+</button>
            </div>
            <a href="/api/file-raw?path={encoded_path}" download>Download</a>
        </div>
    </header>
    <pre><code class="language-{lang}">{content_html}</code></pre>
    <footer class="path">{safe_path}</footer>
    <script>
        document.addEventListener('DOMContentLoaded', function() {{
            hljs.highlightAll();

            const MIN_SIZE = 10;
            const MAX_SIZE = 24;
            const STORAGE_KEY = 'view-font-size';

            let fontSize = parseInt(localStorage.getItem(STORAGE_KEY)) || 14;

            function updateFontSize(size) {{
                fontSize = Math.max(MIN_SIZE, Math.min(MAX_SIZE, size));
                document.documentElement.style.setProperty('--code-font-size', fontSize + 'px');
                document.getElementById('font-size-label').textContent = fontSize;
                localStorage.setItem(STORAGE_KEY, fontSize);
            }}

            updateFontSize(fontSize);

            document.getElementById('font-decrease').addEventListener('click', () => updateFontSize(fontSize - 2));
            document.getElementById('font-increase').addEventListener('click', () => updateFontSize(fontSize + 2));
        }});
    </script>
</body>
</html>"""


def _svg_viewer(filename: str, file_path: str, *,
                 loading_text: str = "Loading...",
                 error_text: str = "Failed to load") -> str:
    """Shared full-page SVG viewer with pan/zoom + dark mode toggle.

    Used by excalidraw_viewer() and chart_viewer(). To add a new SVG-based
    viewer, just call this with appropriate loading/error text.
    """
    safe_name = html.escape(filename)
    safe_path = html.escape(file_path)
    encoded_path = quote(file_path, safe='/:@')

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes">
    <title>{safe_name}</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            background: #0d1117;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }}
        .header {{
            background: #161b22;
            padding: 0.75rem 1rem;
            display: flex;
            align-items: center;
            gap: 0.75rem;
            border-bottom: 1px solid #30363d;
            z-index: 10;
            flex-shrink: 0;
        }}
        .header h1 {{
            font-size: 1rem;
            color: #e6edf3;
            font-weight: 500;
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }}
        .header-controls {{
            display: flex;
            align-items: center;
            gap: 0.5rem;
            flex-shrink: 0;
        }}
        .ctrl-btn {{
            background: #21262d;
            border: 1px solid #30363d;
            color: #8b949e;
            padding: 0.35rem 0.75rem;
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.8rem;
            transition: all 0.15s;
        }}
        .ctrl-btn:hover, .ctrl-btn:active, .ctrl-btn.active {{
            background: #30363d;
            color: #e6edf3;
        }}
        .header a {{
            color: #58a6ff;
            text-decoration: none;
            font-size: 0.875rem;
        }}
        .canvas {{
            flex: 1;
            position: relative;
            overflow: hidden;
            cursor: grab;
            touch-action: none;
        }}
        .canvas:active {{ cursor: grabbing; }}
        .canvas img {{
            position: absolute;
            top: 0;
            left: 0;
            transform-origin: 0 0;
            transition: transform 0.05s linear;
            max-width: none;
            max-height: none;
        }}
        .path {{
            font-family: monospace;
            font-size: 0.75rem;
            color: #8b949e;
            padding: 0.5rem 1rem;
            background: #161b22;
            border-top: 1px solid #30363d;
            flex-shrink: 0;
        }}
        .loading {{
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: #8b949e;
            font-family: system-ui;
            font-size: 0.9rem;
        }}
    </style>
</head>
<body>
    <div class="header">
        <h1>{safe_name}</h1>
        <div class="header-controls">
            <button class="ctrl-btn" id="fit-btn">Fit</button>
            <button class="ctrl-btn" id="zoom100-btn">1:1</button>
            <button class="ctrl-btn" id="dark-btn">Dark</button>
            <a href="/api/file-raw?path={encoded_path}" download="{safe_name}.svg">SVG</a>
        </div>
    </div>
    <div class="canvas" id="canvas">
        <span class="loading">{loading_text}</span>
    </div>
    <div class="path">{safe_path}</div>
    <script>
    (function() {{
        const canvas = document.getElementById('canvas');
        const encodedPath = '{encoded_path}';
        let img, scale = 1, tx = 0, ty = 0;
        let isDark = false;

        function loadSvg(dark) {{
            const url = '/api/file-raw?path=' + encodedPath + (dark ? '&dark=1' : '');
            const newImg = new Image();
            newImg.onload = function() {{
                canvas.innerHTML = '';
                canvas.appendChild(newImg);
                img = newImg;
                fitToView();
            }};
            newImg.onerror = function() {{
                canvas.innerHTML = '<span class="loading">{error_text}</span>';
            }};
            newImg.src = url;
        }}

        function applyTransform() {{
            if (!img) return;
            img.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + scale + ')';
        }}

        function fitToView() {{
            if (!img) return;
            const cr = canvas.getBoundingClientRect();
            const sx = cr.width / img.naturalWidth;
            const sy = cr.height / img.naturalHeight;
            scale = Math.min(sx, sy) * 0.99;
            tx = (cr.width - img.naturalWidth * scale) / 2;
            ty = (cr.height - img.naturalHeight * scale) / 2;
            applyTransform();
        }}

        let dragging = false, lastX, lastY;
        canvas.addEventListener('pointerdown', function(e) {{
            dragging = true; lastX = e.clientX; lastY = e.clientY;
            canvas.setPointerCapture(e.pointerId);
        }});
        canvas.addEventListener('pointermove', function(e) {{
            if (!dragging) return;
            tx += e.clientX - lastX;
            ty += e.clientY - lastY;
            lastX = e.clientX; lastY = e.clientY;
            applyTransform();
        }});
        canvas.addEventListener('pointerup', function() {{ dragging = false; }});
        canvas.addEventListener('pointercancel', function() {{ dragging = false; }});

        canvas.addEventListener('wheel', function(e) {{
            e.preventDefault();
            if (e.ctrlKey) {{
                const rect = canvas.getBoundingClientRect();
                const mx = e.clientX - rect.left;
                const my = e.clientY - rect.top;
                const factor = e.deltaY > 0 ? 0.9 : 1.1;
                const newScale = Math.max(0.05, Math.min(20, scale * factor));
                tx = mx - (mx - tx) * (newScale / scale);
                ty = my - (my - ty) * (newScale / scale);
                scale = newScale;
            }} else {{
                tx -= e.deltaX;
                ty -= e.deltaY;
            }}
            applyTransform();
        }}, {{ passive: false }});

        let gestureStartScale = 1;
        canvas.addEventListener('gesturestart', function(e) {{
            e.preventDefault();
            gestureStartScale = scale;
        }});
        canvas.addEventListener('gesturechange', function(e) {{
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const newScale = Math.max(0.05, Math.min(20, gestureStartScale * e.scale));
            tx = mx - (mx - tx) * (newScale / scale);
            ty = my - (my - ty) * (newScale / scale);
            scale = newScale;
            applyTransform();
        }});
        canvas.addEventListener('gestureend', function(e) {{ e.preventDefault(); }});

        let lastDist = 0;
        canvas.addEventListener('touchstart', function(e) {{
            if (e.touches.length === 2) {{
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                lastDist = Math.hypot(dx, dy);
            }}
        }});
        canvas.addEventListener('touchmove', function(e) {{
            if (e.touches.length === 2) {{
                e.preventDefault();
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                const dist = Math.hypot(dx, dy);
                if (lastDist > 0) {{
                    const factor = dist / lastDist;
                    const rect = canvas.getBoundingClientRect();
                    const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
                    const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
                    const newScale = Math.max(0.05, Math.min(20, scale * factor));
                    tx = mx - (mx - tx) * (newScale / scale);
                    ty = my - (my - ty) * (newScale / scale);
                    scale = newScale;
                    applyTransform();
                }}
                lastDist = dist;
            }}
        }}, {{ passive: false }});

        document.getElementById('fit-btn').addEventListener('click', fitToView);
        document.getElementById('zoom100-btn').addEventListener('click', function() {{
            if (!img) return;
            const cr = canvas.getBoundingClientRect();
            scale = 1;
            tx = (cr.width - img.naturalWidth) / 2;
            ty = (cr.height - img.naturalHeight) / 2;
            applyTransform();
        }});
        document.getElementById('dark-btn').addEventListener('click', function() {{
            isDark = !isDark;
            this.classList.toggle('active', isDark);
            loadSvg(isDark);
        }});

        window.addEventListener('resize', fitToView);
        isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.getElementById('dark-btn').classList.toggle('active', isDark);
        loadSvg(isDark);
    }})();
    </script>
</body>
</html>"""


def excalidraw_viewer(filename: str, file_path: str) -> str:
    """Excalidraw diagram viewer with pan/zoom. SVG rendered server-side."""
    return _svg_viewer(filename, file_path,
                       loading_text="Loading diagram...",
                       error_text="Failed to load diagram")


def chart_viewer(filename: str, file_path: str) -> str:
    """Vega-Lite chart viewer with pan/zoom. SVG rendered server-side."""
    return _svg_viewer(filename, file_path,
                       loading_text="Rendering chart...",
                       error_text="Failed to render chart")


# Language detection for code viewer
LANG_MAP = {
    '.py': 'python', '.js': 'javascript', '.ts': 'typescript',
    '.json': 'json', '.html': 'html', '.css': 'css',
    '.sh': 'bash', '.yaml': 'yaml', '.yml': 'yaml',
    '.toml': 'toml', '.xml': 'xml', '.sql': 'sql',
    '.go': 'go', '.rs': 'rust', '.rb': 'ruby',
}


def get_language(suffix: str) -> str:
    """Get highlight.js language name for a file extension."""
    return LANG_MAP.get(suffix, 'plaintext')
