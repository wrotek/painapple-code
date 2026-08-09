#!/usr/bin/env python3
"""check_licenses.py — fail the build if a dependency ships a license we can't redistribute under.

painapple-code is AGPL-3.0-or-later. That is compatible with permissive
licenses (MIT/BSD/Apache-2.0/MPL-2.0/PSF) but NOT with everything: a
dependency under SSPL, BUSL, or a proprietary "source available" license
would make the wheel undistributable, and one under plain GPL-2.0-only
would be incompatible in the other direction. Those problems arrive
transitively and silently — `requirements.txt` pins floors (`>=`), so the
resolved set drifts on every release without a single file changing.

This script is the gate. It reads installed distribution metadata (the
ground truth for what actually ships), resolves each license to an SPDX-ish
token, and exits non-zero on anything not explicitly allowed.

Usage:
    python tools/check_licenses.py            # verify; exit 1 on violation
    python tools/check_licenses.py --table    # emit the markdown table for
                                              # THIRD_PARTY_NOTICES.md

Run it against an environment that has the package installed, so that
`importlib.metadata` sees the real resolved dependency set:

    pip install dist/painapple_code-*.whl
    python tools/check_licenses.py

Metadata is messier than it looks, which is why this doesn't just read one
field:
  * PEP 639 `License-Expression` is the modern field (cryptography, fastapi).
  * Older dists put a free-form string in `License` ("MIT License", or
    occasionally an entire license text).
  * Some (duckdb, annotated-types, prompt_toolkit as of this writing) leave
    both empty and declare only a `License ::` trove classifier.
Precedence below is expression -> classifier -> free-form, because the
classifier is a controlled vocabulary and the free-form field is not.
"""

from __future__ import annotations

import argparse
import importlib.metadata as md
import re
import sys

# Licenses we can ship inside an AGPL-3.0-or-later distribution.
# Keep this list SHORT and deliberate — adding an entry is a licensing
# decision, not a build fix. If CI fails here, the right first question is
# "should we depend on this at all?", not "how do I widen the allowlist?".
ALLOWED = {
    "MIT",
    "MIT-0",  # MIT No Attribution — strictly more permissive than MIT (cffi)
    "MIT-CMU",  # Pillow's historical PIL/HPND-style license
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "Apache-2.0",
    "MPL-2.0",  # file-level copyleft; fine unmodified (certifi)
    "PSF-2.0",
    "Python-2.0",
    "Unlicense",
    "CC0-1.0",
    "0BSD",
    # The project's own license — painapple_code itself shows up in the scan.
    "AGPL-3.0-or-later",
}

# Distributions that are part of the build/venv plumbing rather than
# something we redistribute.
IGNORE = {"pip", "setuptools", "wheel", "pkg-resources", "distribute", "uv"}

# The project itself. Still license-checked (a bad `license` field in
# pyproject.toml should fail loudly), but omitted from --table, which
# documents THIRD-party components only.
SELF_DIST = "painapple-code"

# Free-form `License:` values and trove classifiers -> SPDX. Longest match
# wins, so "Apache Software License" doesn't get shadowed by a bare "Apache".
CLASSIFIER_MAP = {
    "MIT License": "MIT",
    "MIT No Attribution License": "MIT-0",
    "BSD License": "BSD-3-Clause",  # trove has no 2- vs 3-clause split
    "Apache Software License": "Apache-2.0",
    "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
    "Python Software Foundation License": "PSF-2.0",
    "ISC License (ISCL)": "ISC",
    "The Unlicense (Unlicense)": "Unlicense",
    "CC0 1.0 Universal (CC0 1.0) Public Domain Dedication": "CC0-1.0",
    "GNU General Public License v2 (GPLv2)": "GPL-2.0-only",
    "GNU General Public License v3 (GPLv3)": "GPL-3.0-only",
    "GNU Lesser General Public License v2 (LGPLv2)": "LGPL-2.0-only",
    "GNU Lesser General Public License v3 (LGPLv3)": "LGPL-3.0-only",
    "GNU Affero General Public License v3": "AGPL-3.0-only",
    "GNU Affero General Public License v3 or later (AGPLv3+)": "AGPL-3.0-or-later",
}

FREEFORM_MAP = {
    "mit": "MIT",
    "mit license": "MIT",
    "bsd": "BSD-3-Clause",
    "bsd license": "BSD-3-Clause",
    "bsd-3-clause": "BSD-3-Clause",
    "3-clause bsd": "BSD-3-Clause",
    "apache 2.0": "Apache-2.0",
    "apache-2.0": "Apache-2.0",
    "apache software license": "Apache-2.0",
    "psf-2.0": "PSF-2.0",
    "psf": "PSF-2.0",
    "mit-cmu": "MIT-CMU",
    "mpl-2.0": "MPL-2.0",
    "isc": "ISC",
}


def normalize(raw: str) -> str:
    """Best-effort free-form license string -> SPDX token."""
    s = " ".join(raw.split()).strip().strip(".")
    if not s:
        return ""
    # A few dists paste the whole license text into the field. Anything that
    # long is unusable as an identifier; fall through to the classifier.
    if len(s) > 64 or "\n" in raw:
        return ""
    return FREEFORM_MAP.get(s.lower(), s)


def resolve(dist: md.Distribution) -> tuple[str, str]:
    """Return (spdx_expression, source_field) for a distribution."""
    meta = dist.metadata

    expr = (meta.get("License-Expression") or "").strip()
    if expr:
        return expr, "License-Expression"

    classifiers = [
        c.split("::")[-1].strip()
        for c in (meta.get_all("Classifier") or [])
        if c.startswith("License ::")
    ]
    for c in classifiers:
        if c in CLASSIFIER_MAP:
            return CLASSIFIER_MAP[c], "Classifier"
    if classifiers:
        return classifiers[0], "Classifier"

    free = normalize(meta.get("License") or "")
    if free:
        return free, "License"

    return "", "none"


def evaluate(expr: str) -> bool:
    """Is this SPDX expression acceptable?

    Handles the disjunctions that show up in practice ("MIT OR Apache-2.0",
    "Apache-2.0 OR BSD-3-Clause"): OR passes if ANY branch is allowed, since
    we get to pick the branch. AND requires every term. Parentheses and
    exotic expressions aren't parsed — an unparseable expression fails
    closed and gets a human look.
    """
    if not expr:
        return False
    if "(" in expr or ")" in expr:
        return False

    if re.search(r"\bOR\b", expr):
        return any(evaluate(p.strip()) for p in re.split(r"\bOR\b", expr))
    if re.search(r"\bAND\b", expr):
        return all(evaluate(p.strip()) for p in re.split(r"\bAND\b", expr))

    return expr.strip().rstrip("+") in ALLOWED or expr.strip() in ALLOWED


def collect() -> list[tuple[str, str, str, str, bool]]:
    """-> sorted [(name, version, license, source_field, ok)]"""
    rows = []
    seen = set()
    for dist in md.distributions():
        name = dist.metadata.get("Name") or ""
        if not name or name.lower() in IGNORE:
            continue
        key = name.lower()
        if key in seen:  # duplicate dist-info dirs on the path
            continue
        seen.add(key)
        expr, source = resolve(dist)
        rows.append((name, dist.version or "?", expr, source, evaluate(expr)))
    return sorted(rows, key=lambda r: r[0].lower())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--table",
        action="store_true",
        help="print a markdown table for THIRD_PARTY_NOTICES.md instead of a report",
    )
    args = ap.parse_args()

    rows = collect()
    if not rows:
        print("error: no distributions found — is the package installed?", file=sys.stderr)
        return 1

    if args.table:
        print("| Package | Version | License |")
        print("|---------|---------|---------|")
        for name, version, expr, _, _ in rows:
            if name.lower() == SELF_DIST:
                continue
            print(f"| {name} | {version} | {expr or 'UNKNOWN'} |")
        return 0

    width = max(len(r[0]) for r in rows)
    bad = []
    for name, version, expr, source, ok in rows:
        mark = "ok  " if ok else "FAIL"
        print(f"{mark} {name:<{width}}  {version:<12} {expr or '(no license metadata)'}  [{source}]")
        if not ok:
            bad.append((name, version, expr))

    print(f"\n{len(rows)} distributions checked, {len(bad)} problem(s).")

    if bad:
        print("\nNot in the allowlist:", file=sys.stderr)
        for name, version, expr in bad:
            print(f"  - {name} {version}: {expr or 'no license metadata'}", file=sys.stderr)
        print(
            "\nEach of these is a licensing decision. Either drop the dependency, or\n"
            "-- if the license really is compatible with AGPL-3.0-or-later --\n"
            "add it to ALLOWED in tools/check_licenses.py and record it in\n"
            "THIRD_PARTY_NOTICES.md in the same commit.",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
