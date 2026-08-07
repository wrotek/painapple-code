#!/usr/bin/env python3
"""CSS token codemod — rewrite hardcoded px values onto the design tokens.

The regeneration half of the "creator": gen_density_css.py owns the token
DEFINITIONS; this script retrofits widget CSS onto them, so a token redesign
actually reaches every widget.

    padding: 8px 12px;        ->  padding: var(--sp-8) var(--sp-12);
    gap: 6px;                 ->  gap: var(--sp-6);
    border-radius: 6px;       ->  border-radius: var(--radius-md);   (5px nearest)
    border-radius: 999px;     ->  border-radius: var(--radius-sm);   (de-pill)

Usage:
    tools/tokenize_css.py                     # dry-run report (all files)
    tools/tokenize_css.py 62-skills-widget.css 65-snippets-widget.css
    tools/tokenize_css.py --apply             # rewrite files in place
    tools/tokenize_css.py --fuzzy --apply     # also snap off-scale values to
                                              # the nearest token (8px 10px ->
                                              # sp-8 sp-10; 7px -> sp-6) — review
                                              # the diff, this changes rendering!

Guardrails:
  * only `padding*`, `gap`, `row-gap`, `column-gap`, `border-radius` are
    touched (margins are often positioning — left alone by default)
  * exact on-scale values only, unless --fuzzy
  * exempt files/blocks per docs-ai/layout-density-guide.md (keyboard bar,
    thinking spacing, login.css, vendor) are skipped
  * declarations already using var(), calc(), %, em, auto are skipped
  * 0 / 1px are left alone (hairlines, not density)

Always run with git clean state and review `git diff` after --apply.
"""

import argparse
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CSS_DIR = REPO / "src/painapple_code/static/css"

SP = [2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 24, 32, 48]
RADIUS = {2: "xs", 3: "sm", 5: "md", 8: "lg"}
FONT = {11: "xs", 12: "sm", 13: "base", 14: "md", 15: "content", 16: "lg", 20: "xl"}

# Deliberate exemptions (layout-density-guide.md)
EXEMPT_FILES = {"login.css", "46-keyboard-bar.css", "47-keyboard-longpress.css",
                # token DEFINITIONS — rewriting e.g. compact's
                # `--layout-tool-padding: 5px 8px` to var(--sp-*) would
                # self-reference the mode's own scale (3px 5px!). Owned by
                # tools/gen_density_css.py instead.
                "00-variables.css"}
SPACING_EXEMPT_FILES = {"23-thinking.css"}  # radius still allowed there

SPACING_PROPS = r"padding(?:-top|-right|-bottom|-left)?|gap|row-gap|column-gap"
# (?<![-\w]) anchors the property name: without it `--layout-tool-padding:`
# and `scroll-padding-top:` match as `padding`.
DECL_RE = re.compile(
    rf"(?<![-\w])(?P<prop>{SPACING_PROPS}|border-radius|font-size)(?P<colon>\s*:\s*)(?P<val>[^;{{}}]+);")
PX_RE = re.compile(r"^(\d+(?:\.\d+)?)px$")


def sp_var(px, fuzzy):
    if px in (0, 1):
        return None
    if px in SP:
        return f"var(--sp-{int(px)})"
    if fuzzy:
        nearest = min(SP, key=lambda t: (abs(t - px), -t))
        return f"var(--sp-{nearest})"
    return None


def radius_var(px, fuzzy):
    if px == 0:
        return None
    if px in RADIUS:
        return f"var(--radius-{RADIUS[px]})"
    if px >= 99:  # pill — de-round per design system
        return "var(--radius-sm)"
    if fuzzy:
        nearest = min(RADIUS, key=lambda t: abs(t - px))
        return f"var(--radius-{RADIUS[nearest]})"
    return None


def font_var(px, fuzzy):
    # exact matches only — resizing text is never a "snap"; fuzzy is ignored
    if px in FONT:
        return f"var(--font-size-{FONT[int(px)]})"
    return None


def convert_value(prop, val, fuzzy):
    """Return converted value or None if untouchable/unchanged."""
    if "var(" in val or "calc(" in val or "env(" in val:
        return None
    parts = val.split()
    out = []
    changed = False
    for p in parts:
        m = PX_RE.match(p)
        if not m:
            if p in ("0", "!important"):
                out.append(p)
                continue
            return None  # %, em, auto, 50% ... leave whole decl alone
        px = float(m.group(1))
        if px != int(px):
            return None
        px = int(px)
        var = (radius_var(px, fuzzy) if prop == "border-radius"
               else font_var(px, fuzzy) if prop == "font-size"
               else sp_var(px, fuzzy))
        if var:
            out.append(var)
            changed = True
        else:
            out.append(p)
    return " ".join(out) if changed else None


def process(text, fname, fuzzy):
    changes = []

    def repl(m):
        prop = m.group("prop")
        if prop != "border-radius" and fname in SPACING_EXEMPT_FILES:
            return m.group(0)
        # `padding-left: 28px; /* fixed: ... */` marks a reviewed, deliberate
        # literal (icon geometry, border compensation) — leave it alone.
        line_end = text.find("\n", m.end())
        if "/* fixed:" in text[m.end():line_end if line_end != -1 else None]:
            return m.group(0)
        new = convert_value(prop, m.group("val").strip(), fuzzy)
        if new is None:
            return m.group(0)
        changes.append((prop, m.group("val").strip(), new))
        return f"{prop}{m.group('colon')}{new};"

    return DECL_RE.sub(repl, text), changes


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("files", nargs="*", help="specific css files (default: all)")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--fuzzy", action="store_true",
                    help="snap off-scale values to nearest token (changes rendering)")
    args = ap.parse_args()

    files = ([CSS_DIR / f for f in args.files] if args.files
             else sorted(CSS_DIR.glob("*.css")))
    total = 0
    for f in files:
        if f.name in EXEMPT_FILES:
            continue
        text = f.read_text()
        new, changes = process(text, f.name, args.fuzzy)
        if not changes:
            continue
        total += len(changes)
        print(f"\n{f.name} — {len(changes)} declarations")
        for prop, old, newv in changes:
            print(f"    {prop}: {old}  ->  {newv}")
        if args.apply:
            f.write_text(new)
    verb = "rewrote" if args.apply else "would rewrite (dry-run, use --apply)"
    print(f"\n{verb}: {total} declarations across "
          f"{sum(1 for _ in files)} files scanned")


if __name__ == "__main__":
    main()
