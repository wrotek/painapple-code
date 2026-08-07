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
