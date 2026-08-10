"""Static gate: every text-mode file read/write names its encoding.

Python picks the *locale* codec when you omit `encoding=`. On Linux and
macOS that is UTF-8, so omitting it is invisible. On a stock Windows box
it is cp1252, and the first non-ASCII byte raises UnicodeDecodeError —
which, in the asset-serving paths, means the whole page load dies.

b303b93d fixed every occurrence once. Three subsequent merges from main
reintroduced it (the CSS concat and /app handler in the content-hashed
asset pass, then _process_js_file, /app and sw.js again in the frontend
bundling pass), because nothing running on Linux CI can notice. This test
is that missing signal.

Uses the AST rather than a regex: the calls nest (`write_text(json.dumps(
x, indent=2), encoding=...)`) and the same text appears in comments and
in docstrings, both of which a grep-style check trips over.
"""

import ast
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent / "src" / "painapple_code"

_TEXT_METHODS = {"read_text", "write_text"}


def _py_files():
    return sorted(PKG.rglob("*.py"))


# Positional index of `encoding` in each signature, for the callers that
# pass it that way (`path.read_text("utf-8")` is correct code).
_ENCODING_ARG = {"read_text": 0, "write_text": 1, "open": 3}


def _call_name(node):
    """'read_text' / 'open' / None for a Call node's callee.

    `open` counts only as the builtin or `io.open` — Image.open(BytesIO)
    and friends take no encoding and must not be flagged.
    """
    f = node.func
    if isinstance(f, ast.Attribute):
        if f.attr in _TEXT_METHODS:
            return f.attr
        if f.attr == "open" and isinstance(f.value, ast.Name) and f.value.id == "io":
            return "open"
        return None
    if isinstance(f, ast.Name):
        return f.id if f.id == "open" else None
    return None


def _has_encoding(node, name):
    if any(k.arg == "encoding" for k in node.keywords):
        return True
    idx = _ENCODING_ARG.get(name)
    return idx is not None and len(node.args) > idx


def _open_is_binary(node):
    """True when open()'s mode argument is a literal containing 'b'.

    A non-literal mode is treated as text: it could be either, and the
    encoding kwarg is harmless on a binary handle... but a missing one is
    not, so the conservative direction is to require it.
    """
    mode = None
    if len(node.args) >= 2 and isinstance(node.args[1], ast.Constant):
        mode = node.args[1].value
    for k in node.keywords:
        if k.arg == "mode" and isinstance(k.value, ast.Constant):
            mode = k.value.value
    return isinstance(mode, str) and "b" in mode


def _offenders():
    out = []
    for f in _py_files():
        tree = ast.parse(f.read_text(encoding="utf-8"), filename=str(f))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = _call_name(node)
            if name in _TEXT_METHODS:
                if not _has_encoding(node, name):
                    out.append((f, node.lineno, f"{name}()"))
            elif name == "open":
                if not _open_is_binary(node) and not _has_encoding(node, name):
                    out.append((f, node.lineno, "open() in text mode"))
    return [f"{p.relative_to(PKG)}:{ln}: {what}" for p, ln, what in out]


def test_text_io_always_names_an_encoding():
    offenders = _offenders()
    assert not offenders, (
        "Text-mode file I/O without encoding= uses the locale codec, which is "
        'cp1252 on Windows. Pass encoding="utf-8" (or open in binary mode if '
        "that is what you meant):\n  " + "\n  ".join(offenders)
    )
