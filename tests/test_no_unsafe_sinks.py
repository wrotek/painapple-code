"""WP-04 B5 — static gate against reintroducing the XSS antipatterns we fixed,
plus a DOMPurify integrity pin.

These are cheap grep-style checks over the shipped JS. They are intentionally
PRECISE (they match the exact breakout shapes, not every inline handler) so
they stay green on the current tree and only fire on a regression.
"""

import hashlib
import re
from pathlib import Path

import pytest

JS_ROOT = Path(__file__).resolve().parent.parent / "src" / "painapple_code" / "static" / "js"
VENDOR = Path(__file__).resolve().parent.parent / "src" / "painapple_code" / "static" / "vendor"

# Model/tool-controlled value interpolated with escapeHtml INSIDE an inline-JS
# string arg — escapeHtml doesn't escape quotes, so a `'` breaks out. The fix
# is data-* + this.dataset.* (never interpolate the value into the handler).
_ESCAPEHTML_IN_ONCLICK = re.compile(r"""on\w+="[^"]*\('\$\{escapeHtml\(""")
# href built with escapeHtml (leaves quotes) instead of escapeAttr+sanitizeHref.
_HREF_FROM_ESCAPEHTML = re.compile(r'href="\$\{escapeHtml\(')
# Any `href="${EXPR}"`; EXPR has no braces/quotes of its own at our call sites.
_HREF_INTERP = re.compile(r'href="\$\{([^}"]+)\}"')
_IDENT = re.compile(r"[A-Za-z_$][\w$]*")


def _js_files():
    return sorted(JS_ROOT.rglob("*.js"))


def test_no_escapehtml_in_inline_handler_arg():
    offenders = []
    for f in _js_files():
        for i, line in enumerate(f.read_text(errors="replace").splitlines(), 1):
            if _ESCAPEHTML_IN_ONCLICK.search(line):
                offenders.append(f"{f.relative_to(JS_ROOT)}:{i}")
    assert not offenders, (
        "escapeHtml interpolated into an inline handler arg (quote-breakout). "
        "Use data-* + this.dataset.*:\n  " + "\n  ".join(offenders)
    )


def test_no_href_built_from_escapehtml():
    offenders = []
    for f in _js_files():
        for i, line in enumerate(f.read_text(errors="replace").splitlines(), 1):
            if _HREF_FROM_ESCAPEHTML.search(line):
                offenders.append(f"{f.relative_to(JS_ROOT)}:{i}")
    assert not offenders, (
        "href built with escapeHtml (not quote-safe / no scheme check). "
        "Use escapeAttr(MarkdownRenderer.sanitizeHref(url)):\n  " + "\n  ".join(offenders)
    )


def test_every_href_interpolation_uses_escape_attr():
    """Every `href="${...}"` must be quote-escaped, directly or via its variable.

    The escapeHtml check above only catches the inline shape. The same bug
    hides behind one level of indirection — `const u = escapeHtml(x)` on one
    line, `href="${u}"` on the next — which is exactly how the linkify path
    evaded the gate. So resolve bare identifiers to their assignment before
    judging them.
    """
    offenders = []
    for f in _js_files():
        src = f.read_text(errors="replace")
        for i, line in enumerate(src.splitlines(), 1):
            for expr in _HREF_INTERP.findall(line):
                if "escapeAttr" in expr:
                    continue
                # Bare identifier — resolve `const <name> = ...` in this file.
                if _IDENT.fullmatch(expr.strip()):
                    assign = re.search(
                        r"\b(?:const|let|var)\s+%s\s*=\s*(.+)" % re.escape(expr.strip()), src
                    )
                    if assign and "escapeAttr" in assign.group(1):
                        continue
                offenders.append(f"{f.relative_to(JS_ROOT)}:{i} -> ${{{expr}}}")
    assert not offenders, (
        "href interpolation not quote-escaped. Use "
        "escapeAttr(MarkdownRenderer.sanitizeHref(url)):\n  " + "\n  ".join(offenders)
    )


def test_sanitize_href_returns_raw_url():
    """sanitizeHref must return the RAW cleaned url, never a pre-escaped one.

    Callers wrap it in escapeAttr. If this returned escapeHtml(cleaned) the
    two escapes would stack and `?a=1&b=2` would reach the DOM as
    `?a=1&amp;b=2` — a link that silently points somewhere else. Pre-escaping
    here also can't replace escapeAttr, since escapeHtml leaves quotes intact.
    """
    src = (JS_ROOT / "components.js").read_text()
    body = src.split("static sanitizeHref(", 1)[1].split("\n    }", 1)[0]
    assert "return escapeHtml(" not in body, (
        "sanitizeHref pre-escapes its return value; callers already apply "
        "escapeAttr, so this double-escapes & in query strings"
    )
    assert "return cleaned;" in body


def test_sanitize_html_fails_closed():
    src = (JS_ROOT / "components.js").read_text()
    # The DOMPurify-missing branch must NOT return the raw html.
    assert "rendered UNSANITIZED" not in src
    assert "return escapeHtml(html);" in src


def test_dompurify_integrity_pinned():
    """DOMPurify is the sanitizer gate — pin its hash so a silent swap is caught."""
    expected = "dbabb5b205a333ec49c8c09e7fca30ef66df0523bb8bc0fa9ea843841f111dbd"
    digest = hashlib.sha256((VENDOR / "purify.min.js").read_bytes()).hexdigest()
    assert digest == expected, (
        f"purify.min.js hash changed ({digest}). If this was an intentional "
        "DOMPurify bump, update the pin here and in vendor/README.md."
    )
