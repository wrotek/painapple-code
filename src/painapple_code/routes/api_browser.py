"""
Browser Widget API Routes

Serves local files (especially HTML) for the in-app Browser widget so users
can render reports, charts, and other HTML artifacts living anywhere under
their home directory — and proxies external URLs so they can be embedded
despite X-Frame-Options / CSP frame-ancestors restrictions.

Endpoints:
  - GET /api/browser/render?path=...      — local file entry, accepts ~ / file://
  - GET /api/browser/asset/{path:path}    — local sub-resource for relative refs
  - GET /api/browser/proxy?url=...        — external URL proxy with header strip

Both local endpoints share a serve helper. HTML files get a <base href>
injected so relative refs resolve back through the right route. The proxy
strips X-Frame-Options and CSP frame-ancestors so the iframe loads, and
injects a <base href> pointing at the original origin so sub-resources
(CSS/JS/images) load cross-origin from the origin.
"""

import asyncio
import ipaddress
import logging
import re
import socket
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, urljoin, quote

import httpcore
import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse, FileResponse, Response

from painapple_code.utils.file_paths import is_path_allowed_for_read
from painapple_code.routes.api_viewer import MIME_TYPES

logger = logging.getLogger(__name__)

router = APIRouter(tags=["browser"])


_HEAD_RE = re.compile(r'(<head[^>]*>)', re.IGNORECASE)
_PROXY_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
_PROXY_MAX_BYTES = 25 * 1024 * 1024  # 25 MiB — protects against memory exhaustion
_PROXY_TIMEOUT = 15.0
_PROXY_PATH = "/api/browser/proxy"

# Injected at the very top of every proxied page's <head>. Iframe `sandbox`
# is supposed to block window.open and target=_blank, but WKWebView in
# iPad-PWA / standalone mode honours iframe sandbox flags inconsistently —
# proxied pages have been observed popping Safari tabs from sandboxed
# iframes. Worse: on the iPadOS Tauri build, sub-iframes inside the proxied
# page (e.g. wyborcza's globalCookieIframe injected by a CMP script) escape
# to Safari because wry 0.55 only exposes the navigation URL — no
# WKNavigationAction.targetFrame — so on_navigation can't tell a sub-iframe
# load from a top-frame click and routes everything external to opener.
#
# Defenses this script applies (in order):
#   1. window.open → no-op (defineProperty non-writable).
#   2. HTMLIFrameElement/HTMLFrameElement `src` setter override — external
#      http(s) URLs are rewritten to /api/browser/proxy?url=… on the loopback
#      origin so the nav stays internal.
#   3. Element.prototype.setAttribute interception — same rewrite for
#      iframe/frame `src` set via setAttribute.
#   4. MutationObserver backstop for iframes built by the HTML parser
#      (document.write, innerHTML) that didn't pass through #2/#3.
#   5. Capture-phase click/submit listeners that rewrite target=_blank/_top
#      /_parent on anchors and forms before the browser acts on them.
_IFRAME_GUARD_SCRIPT = '''<script>(function(){
try{Object.defineProperty(window,"open",{value:function(){return null},writable:false,configurable:false});}catch(e){}
var ORIGIN=window.location.origin,PROXY=ORIGIN+"/api/browser/proxy?url=";
var rewrite=function(v){
if(typeof v!=="string"||!v)return v;
var s=v.trim();
if(!s||/^(?:#|data:|javascript:|mailto:|tel:|blob:|about:)/i.test(s))return v;
try{
var abs=new URL(s,document.baseURI).href;
if(abs.toLowerCase().indexOf(ORIGIN.toLowerCase())===0)return v;
if(/^https?:/i.test(abs))return PROXY+encodeURIComponent(abs);
}catch(e){}
return v;
};
try{["HTMLIFrameElement","HTMLFrameElement"].forEach(function(n){
var P=window[n]&&window[n].prototype;if(!P)return;
var d=Object.getOwnPropertyDescriptor(P,"src");
if(d&&d.set&&d.configurable!==false){
var orig=d.set;
Object.defineProperty(P,"src",{get:d.get,set:function(v){orig.call(this,rewrite(v));},configurable:true,enumerable:d.enumerable});
}});}catch(e){}
try{var origSA=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(name,value){
if(name&&typeof name==="string"&&name.toLowerCase()==="src"){
var t=(this.tagName||"").toLowerCase();
if(t==="iframe"||t==="frame")value=rewrite(value);
}
return origSA.call(this,name,value);};}catch(e){}
try{var fixFrame=function(el){
var t=(el.tagName||"").toLowerCase();
if((t!=="iframe"&&t!=="frame")||!el.hasAttribute("src"))return;
var s=el.getAttribute("src"),r=rewrite(s);
if(r!==s)el.setAttribute("src",r);
};
new MutationObserver(function(ms){
ms.forEach(function(m){m.addedNodes&&m.addedNodes.forEach(function(n){
if(!n||n.nodeType!==1)return;
fixFrame(n);
n.querySelectorAll&&n.querySelectorAll("iframe,frame").forEach(fixFrame);
});});
}).observe(document.documentElement||document,{childList:true,subtree:true});}catch(e){}
var fixTarget=function(el){if(!el||el.nodeType!==1)return;
var t=(el.getAttribute&&el.getAttribute("target")||"").toLowerCase();
if(t==="_blank"||t==="_top"||t==="_parent")el.setAttribute("target","_self");};
document.addEventListener("click",function(e){var n=e.target;while(n&&n.nodeType===1&&n.tagName!=="A")n=n.parentNode;fixTarget(n);},true);
document.addEventListener("submit",function(e){fixTarget(e.target);},true);
})();</script>'''
# Reports the document's scrollHeight back to the parent so the parent can
# size the iframe to its content. With the iframe sized to its content, it
# has no internal overflow — wheel/touch events fall through to the parent
# wrap (which is `overflow: auto`), making the wrap the actual scroll
# surface. Without this, scroll only works over <table> cells on desktop
# (WebKit's hit-test resolves a different scroll target there) and is
# inconsistent on iPad PWA. Null origin / sandboxed iframes can still
# postMessage to parent, so this works under the existing CSP sandbox.
# Cap at 50_000 px to defuse runaway loops on pages that size with `100vh`.
_IFRAME_AUTORESIZE_SCRIPT = '''<script>(function(){
try{
var last=-1;
var post=function(){
try{
var h=Math.max(
document.documentElement.scrollHeight,
document.body?document.body.scrollHeight:0
);
if(h>50000)h=50000;
if(h===last||h<=0)return;
last=h;
parent.postMessage({type:"painapple-html-height",height:h},"*");
}catch(e){}
};
if(document.readyState!=="loading")post();
window.addEventListener("DOMContentLoaded",post);
window.addEventListener("load",post);
window.addEventListener("resize",post);
if(window.ResizeObserver){
try{
var ro=new ResizeObserver(post);
ro.observe(document.documentElement);
if(document.body)ro.observe(document.body);
}catch(e){}
}
if(window.MutationObserver){
try{
new MutationObserver(post).observe(document.documentElement,
{childList:true,subtree:true,attributes:true,characterData:true});
}catch(e){}
}
// Forward Escape keydowns to the parent. Once focus lands inside the
// iframe (click on text, scroll, etc.), the iframe's document owns
// the keydown — the parent's global Escape handler never sees it, so
// `Esc` stops closing the preview widget. Posting a message lets the
// parent dispatch a synthetic Escape on its own document and run the
// full handleEscape priority chain. Cross-origin postMessage is fine
// under the existing `allow-scripts` sandbox.
document.addEventListener("keydown",function(e){
if(e.key==="Escape"){
try{parent.postMessage({type:"painapple-html-key",key:"Escape"},"*");}catch(_){}
}
},true);
}catch(e){}
})();</script>'''
# Iframe-attribute sandbox flags WKWebView PWA mode has been flaky with.
# Sent as a response-level CSP so the sandbox is enforced at document load
# instead of relying on the parent iframe's attribute being honoured.
_CSP_SANDBOX = "sandbox allow-scripts allow-forms"

# ── URL rewriters ────────────────────────────────────────────────
# Transform every URL reference inside a proxied response so that the
# browser fetches sub-resources through us too. Without this, CSS / JS /
# images load directly from the original origin and frequently break on
# hot-link protection, missing referer-cookies, or CORS for fonts.

_URL_ATTR_RE = re.compile(
    r'(\s(?:href|src|action|formaction|cite|data|poster|background)\s*=\s*)'
    r'(["\'])([^"\']*)\2',
    re.IGNORECASE,
)
_SRCSET_RE = re.compile(
    r'(\ssrcset\s*=\s*)(["\'])([^"\']*)\2',
    re.IGNORECASE,
)
_STYLE_BLOCK_RE = re.compile(
    r'(<style[^>]*>)(.*?)(</style>)',
    re.IGNORECASE | re.DOTALL,
)
# Inline style needs two patterns because the value commonly contains
# the opposite quote type (e.g. style="background:url('/x.png')").
_INLINE_STYLE_DQ_RE = re.compile(r'(\sstyle\s*=\s*)"([^"]*)"', re.IGNORECASE)
_INLINE_STYLE_SQ_RE = re.compile(r"(\sstyle\s*=\s*)'([^']*)'", re.IGNORECASE)
_CSS_URL_RE = re.compile(
    r'url\(\s*(["\']?)([^"\')\s]+)\1\s*\)',
    re.IGNORECASE,
)
_CSS_IMPORT_RE = re.compile(
    r'@import\s+(?:url\(\s*)?(["\'])([^"\']*)\1\s*\)?',
    re.IGNORECASE,
)
_SKIP_PREFIXES = (
    '#', 'data:', 'javascript:', 'mailto:', 'tel:', 'blob:',
    'about:', 'chrome:', 'ws:', 'wss:',
)

# Neutralise target="_blank" / _top / _parent on links and form actions so
# pages can't escape the sandbox via the parent browser. Sandbox would block
# them anyway, but stripping at the proxy layer also keeps the user from
# clicking dead links that "should" have popped a tab.
_BREAKOUT_TARGET_RE = re.compile(
    r'(\s)target\s*=\s*(["\'])(?:_blank|_top|_parent)\2',
    re.IGNORECASE,
)
# <meta http-equiv="refresh" content="0; url=https://..."> redirects the
# iframe to an arbitrary URL. Without rewriting, the iframe navigates direct
# to the external origin — which then leaks to Tauri's on_navigation and
# can be escaped to Safari. The content attribute mixes a delay with the
# target URL, so the rewrite preserves the delay and only swaps the URL.
_META_REFRESH_RE = re.compile(
    r'(<meta[^>]*\shttp-equiv\s*=\s*["\']refresh["\'][^>]*\scontent\s*=\s*)'
    r'(["\'])([^"\']*)\2',
    re.IGNORECASE,
)
_META_REFRESH_URL_RE = re.compile(
    r'^(\s*\d+\s*[;,]\s*(?:url\s*=\s*)?)(.+?)\s*$',
    re.IGNORECASE,
)


def _proxy_wrap(absolute_url: str) -> str:
    """Wrap an http(s) URL in our proxy endpoint."""
    return f'{_PROXY_PATH}?url={quote(absolute_url, safe="")}'


def _maybe_rewrite(url: str, base_url: str) -> str:
    """Rewrite a URL to go through proxy if it's http(s); otherwise pass through."""
    if not url:
        return url
    s = url.strip()
    if not s or s.startswith(_SKIP_PREFIXES):
        return url
    try:
        abs_url = urljoin(base_url, s)
    except ValueError:
        return url
    if abs_url.startswith(('http://', 'https://')):
        return _proxy_wrap(abs_url)
    return url


def _rewrite_css(css: str, base_url: str) -> str:
    """Rewrite url(...) and @import URLs in a CSS string."""
    def url_sub(m):
        q, ref = m.group(1), m.group(2)
        return f'url({q}{_maybe_rewrite(ref, base_url)}{q})'

    def import_sub(m):
        q, ref = m.group(1), m.group(2)
        return f'@import {q}{_maybe_rewrite(ref, base_url)}{q}'

    # @import runs first so its url() form is normalised to a string and
    # the standalone url() rewriter doesn't re-wrap it.
    css = _CSS_IMPORT_RE.sub(import_sub, css)
    css = _CSS_URL_RE.sub(url_sub, css)
    return css


def _rewrite_html(html: str, base_url: str) -> str:
    """Rewrite all URL references in HTML to route through the proxy."""
    def attr_sub(m):
        prefix, q, ref = m.group(1), m.group(2), m.group(3)
        return f'{prefix}{q}{_maybe_rewrite(ref, base_url)}{q}'

    def srcset_sub(m):
        prefix, q, val = m.group(1), m.group(2), m.group(3)
        parts = []
        for raw_item in val.split(','):
            item = raw_item.strip()
            if not item:
                continue
            bits = item.split(None, 1)
            url_part = _maybe_rewrite(bits[0], base_url)
            rest = (' ' + bits[1]) if len(bits) > 1 else ''
            parts.append(url_part + rest)
        return f'{prefix}{q}{", ".join(parts)}{q}'

    def style_block_sub(m):
        return m.group(1) + _rewrite_css(m.group(2), base_url) + m.group(3)

    def inline_style_dq_sub(m):
        prefix, val = m.group(1), m.group(2)
        return f'{prefix}"{_rewrite_css(val, base_url)}"'

    def inline_style_sq_sub(m):
        prefix, val = m.group(1), m.group(2)
        return f"{prefix}'{_rewrite_css(val, base_url)}'"

    def meta_refresh_sub(m):
        prefix, q, val = m.group(1), m.group(2), m.group(3)
        url_match = _META_REFRESH_URL_RE.match(val)
        if not url_match:
            return m.group(0)
        head, url_part = url_match.group(1), url_match.group(2)
        return f'{prefix}{q}{head}{_maybe_rewrite(url_part, base_url)}{q}'

    html = _URL_ATTR_RE.sub(attr_sub, html)
    html = _SRCSET_RE.sub(srcset_sub, html)
    html = _STYLE_BLOCK_RE.sub(style_block_sub, html)
    html = _INLINE_STYLE_DQ_RE.sub(inline_style_dq_sub, html)
    html = _INLINE_STYLE_SQ_RE.sub(inline_style_sq_sub, html)
    html = _BREAKOUT_TARGET_RE.sub(r'\1target=\2_self\2', html)
    html = _META_REFRESH_RE.sub(meta_refresh_sub, html)
    return html


def _inject_head(html: str, *fragments: str) -> str:
    """Insert HTML fragments at the start of <head> (or before content if no head).

    Fragments are concatenated in the given order, so the first fragment runs
    earliest. The iframe-guard script goes first so it neuters window.open
    before any page script can call it.
    """
    inject = ''.join(fragments)
    if not inject:
        return html
    if _HEAD_RE.search(html):
        return _HEAD_RE.sub(lambda m: m.group(1) + inject, html, count=1)
    return inject + html


def _serve_local_file(p: Path) -> Response:
    """Shared serve path for both /render and /asset."""
    if not is_path_allowed_for_read(p):
        raise HTTPException(status_code=403, detail="Path not allowed")
    if not p.exists():
        raise HTTPException(status_code=404, detail="File not found")
    if not p.is_file():
        raise HTTPException(status_code=400, detail="Not a file")

    suffix = p.suffix.lower()

    if suffix in {'.html', '.htm'}:
        try:
            content = p.read_text(encoding="utf-8", errors='replace')
        except PermissionError:
            raise HTTPException(status_code=403, detail="Permission denied")
        base_url = f"/api/browser/asset{p.parent}/"
        # Guard script first so it neuters window.open before any inline
        # script in the file can run. Even user-owned HTML shouldn't pop
        # Safari tabs from inside the browser-widget viewer on iOS.
        # Autoresize after the guard — it just posts a number outward,
        # ordering vs. inline scripts doesn't matter.
        content = _inject_head(
            content,
            _IFRAME_GUARD_SCRIPT,
            _IFRAME_AUTORESIZE_SCRIPT,
            f'<base href="{base_url}">',
        )
        return HTMLResponse(
            content,
            headers={'Content-Security-Policy': _CSP_SANDBOX},
        )

    mime = MIME_TYPES.get(suffix, 'application/octet-stream')
    return FileResponse(
        str(p),
        media_type=mime,
        headers={
            'Cache-Control': 'no-cache',
            # Same opaque-origin sandbox as the HTML branch. SVG is a
            # scriptable format — opened top-level (outside the widget's
            # sandboxed iframe) it must not run with the bridge origin
            # and auth cookie, from which every API is reachable.
            'Content-Security-Policy': _CSP_SANDBOX,
        },
    )


@router.get("/api/browser/render")
async def browser_render(path: str):
    """Render a local file by user-supplied path (handles ~ and file://)."""
    raw = path[7:] if path.startswith('file://') else path
    try:
        p = Path(raw).expanduser().resolve()
    except (OSError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=f"Bad path: {e}")
    return _serve_local_file(p)


@router.get("/api/browser/asset/{path:path}")
async def browser_asset(path: str):
    """Serve a relative resource referenced from a rendered HTML file.

    `{path:path}` captures the URL tail minus the leading slash; we add
    it back to recover the original absolute filesystem path.
    """
    try:
        p = Path('/' + path).resolve()
    except (OSError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=f"Bad path: {e}")
    return _serve_local_file(p)


# ══════════════════════════════════════════════════════════════════
# External URL proxy — strips X-Frame-Options / CSP so the iframe loads
# ══════════════════════════════════════════════════════════════════


def _is_private_host(hostname: str) -> bool:
    """Block loopback / private / link-local targets to prevent SSRF."""
    if not hostname:
        return True
    host = hostname.strip('[]')
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return True
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr.split('%', 1)[0])
        except ValueError:
            continue
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_multicast or ip.is_reserved or ip.is_unspecified):
            return True
    return False


def _ip_is_blocked(addr: str) -> bool:
    """True if a resolved address string is private/loopback/link-local/etc."""
    try:
        ip = ipaddress.ip_address(addr.split('%', 1)[0])
    except ValueError:
        return False
    return (ip.is_private or ip.is_loopback or ip.is_link_local
            or ip.is_multicast or ip.is_reserved or ip.is_unspecified)


class _SSRFGuardBackend(httpcore.AsyncNetworkBackend):
    """httpcore backend that resolves, validates, and connects in one step.

    The `_is_private_host` pre-checks run before the fetch and on every redirect
    hop, but they resolve the name separately from httpx's own connect — a DNS
    rebind with a sub-TTL flip could return a public IP to the pre-check and a
    private one to the connect (TOCTOU). Doing the resolve+validate here, then
    connecting to the *exact* IP we validated, closes that window. TLS SNI/cert
    validation still use the original hostname (only the TCP target is pinned).
    """

    def __init__(self):
        self._inner = httpcore.AnyIOBackend()

    async def connect_tcp(self, host, port, timeout=None, local_address=None,
                          socket_options=None):
        loop = asyncio.get_running_loop()
        try:
            infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except socket.gaierror as e:
            raise httpcore.ConnectError(f"DNS resolution failed for {host}") from e
        pinned = None
        for info in infos:
            addr = info[4][0]
            if _ip_is_blocked(addr):
                raise httpcore.ConnectError(
                    f"Blocked SSRF: {host} resolved to non-public address {addr}")
            if pinned is None:
                pinned = addr
        if pinned is None:
            raise httpcore.ConnectError(f"No usable address for {host}")
        return await self._inner.connect_tcp(
            pinned, port, timeout=timeout, local_address=local_address,
            socket_options=socket_options)


def _guarded_async_client(**kwargs) -> httpx.AsyncClient:
    """Build an AsyncClient whose connections go through the SSRF-guard backend.

    Falls back to a plain client (pre-checks only) if httpx's internals ever
    stop exposing the pool backend — the _is_private_host checks still apply.
    """
    transport = httpx.AsyncHTTPTransport()
    try:
        transport._pool._network_backend = _SSRFGuardBackend()
    except AttributeError:  # pragma: no cover - httpx internal shape changed
        logger.warning("SSRF-guard backend not installed; relying on pre-checks only")
    return httpx.AsyncClient(transport=transport, **kwargs)


def _proxy_origin_base(final_url: str) -> str:
    """`https://a.b/path/x?y` → `https://a.b/path/`."""
    parts = urlsplit(final_url)
    path = parts.path or '/'
    if not path.endswith('/'):
        path = path.rsplit('/', 1)[0] + '/'
    return urlunsplit((parts.scheme, parts.netloc, path, '', ''))


@router.get("/api/browser/proxy")
async def browser_proxy(url: str):
    """Fetch an external URL and re-serve it with frame-blocking headers stripped.

    For HTML responses, injects `<base href>` pointing at the original origin
    so relative sub-resources (CSS/JS/images) load directly from there.
    Non-HTML bodies are passed through with their Content-Type.

    Only `http`/`https` is allowed; private/loopback hosts are rejected.
    """
    if not isinstance(url, str) or not url.strip():
        raise HTTPException(400, "Missing url")
    if not url.lower().startswith(('http://', 'https://')):
        raise HTTPException(400, "Only http(s) URLs are supported")

    parts = urlsplit(url)
    if _is_private_host(parts.hostname or ''):
        raise HTTPException(400, "Private/loopback hosts are not allowed")

    safe_path = quote(parts.path, safe="/%:@!$&'()*+,;=")
    safe_url = urlunsplit((parts.scheme, parts.netloc, safe_path, parts.query, ''))

    # Follow redirects manually so every hop is re-validated against the SSRF
    # blocklist — httpx's follow_redirects=True would chase a 302 straight to
    # 169.254.169.254 / 127.0.0.1 without re-checking the target host.
    _MAX_REDIRECTS = 5
    current_url = safe_url
    try:
        async with _guarded_async_client(
            follow_redirects=False,
            timeout=_PROXY_TIMEOUT,
            headers={
                'User-Agent': _PROXY_USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/*;q=0.8,*/*;q=0.5',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        ) as client:
            for _ in range(_MAX_REDIRECTS + 1):
                r = await client.get(current_url)
                if not r.is_redirect or r.next_request is None:
                    break
                next_url = str(r.next_request.url)
                next_parts = urlsplit(next_url)
                if next_parts.scheme not in ('http', 'https'):
                    raise HTTPException(400, "Only http(s) redirects are supported")
                if _is_private_host(next_parts.hostname or ''):
                    raise HTTPException(400, "Redirect to a private/loopback host is not allowed")
                current_url = next_url
            else:
                raise HTTPException(502, "Too many redirects")
    except httpx.HTTPError as e:
        logger.warning("Browser proxy fetch failed: %s — %s", safe_url, e)
        raise HTTPException(502, f"Upstream fetch failed: {e.__class__.__name__}")

    body = r.content
    if len(body) > _PROXY_MAX_BYTES:
        raise HTTPException(502, "Upstream response exceeds size limit")

    content_type = r.headers.get('content-type', 'application/octet-stream')
    ct_lower = content_type.lower()
    is_html = 'text/html' in ct_lower or 'application/xhtml' in ct_lower
    is_css = 'text/css' in ct_lower
    final_url = str(r.url)

    if is_html:
        try:
            text = body.decode(r.encoding or 'utf-8', errors='replace')
        except (LookupError, UnicodeDecodeError):
            text = body.decode('utf-8', errors='replace')
        text = _rewrite_html(text, final_url)
        # Guard script first so it neuters window.open before any inline
        # script can run; <base href> as a safety net for any URL we missed
        # (e.g. JS-built ones) — points at the original origin so missed
        # relative refs at least try the real site directly.
        base_href = _proxy_origin_base(final_url)
        text = _inject_head(
            text,
            _IFRAME_GUARD_SCRIPT,
            f'<base href="{base_href}" target="_self">',
        )
        body = text.encode('utf-8')
        content_type = 'text/html; charset=utf-8'
    elif is_css:
        try:
            text = body.decode(r.encoding or 'utf-8', errors='replace')
        except (LookupError, UnicodeDecodeError):
            text = body.decode('utf-8', errors='replace')
        body = _rewrite_css(text, final_url).encode('utf-8')
        content_type = 'text/css; charset=utf-8'

    out_headers = {
        'Cache-Control': 'no-cache',
        'X-Painapple-Proxy': '1',
    }
    if is_html:
        # CSP sandbox forces the document into a sandbox regardless of how
        # WKWebView treats the iframe-attribute sandbox in PWA mode. Same
        # flags as the iframe attribute — kept in sync intentionally.
        out_headers['Content-Security-Policy'] = _CSP_SANDBOX
    return Response(content=body, media_type=content_type, headers=out_headers, status_code=r.status_code)
