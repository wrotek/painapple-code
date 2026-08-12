# Contributing to pAInapple Code

Thanks for your interest! This is a solo-maintained project, so a few ground
rules keep contributions manageable for everyone.

**Before writing code for a significant change, open an issue first.** A
feature or refactor PR that lands without prior discussion may sit for a
while or be declined if it doesn't fit the project's direction. Small fixes
(typos, obvious bugs, doc corrections) can go straight to a PR.

**Security issues are never GitHub issues.** Use
[private vulnerability reporting](https://github.com/wrotek/painapple-code/security/advisories/new)
— see [SECURITY.md](SECURITY.md).

## Development setup

Python ≥ 3.12 and git are all you need. Node is only required if you touch
the vendored frontend bundles (most contributions won't).

```bash
git clone https://github.com/wrotek/painapple-code.git
cd painapple-code
python3 -m venv venv
source venv/bin/activate
pip install -e '.[test]'
python -m painapple_code --port 8765 --workspace /path/to/some/project
```

Open `http://127.0.0.1:8765/` and log in with the URL printed at startup.

The frontend has **no build step in development**: the ES modules and CSS in
`src/painapple_code/static/` are served individually and rewritten on the
fly, so edit → refresh is the whole loop. (`./build-frontend.sh` produces the
optional production bundle; you don't need it while developing.)

A few project conventions to know before editing:

- **User-facing strings live in `src/painapple_code/data/strings.yaml`**, not
  hardcoded in JS/HTML.
- **New UI panels use the widget system** (`static/js/widget-system/`), not
  standalone modals.
- **`README.md` is generated** — don't edit it directly (the sources aren't in
  the public tree; maintainer regenerates it).
- Spacing uses the `--sp-N` density tokens and `--radius-*` radii; z-indexes
  come from the variables in `00-variables.css`, never magic numbers.

## Tests

```bash
python -m pytest tests/ -q
```

The suite is in-process (FastAPI `TestClient`, everything writes to
`tmp_path`) — no live server, no port, no credentials needed. It's largely
security regression tests and runs in a few seconds. CI runs it on every
push and PR (`.github/workflows/tests.yml`).

Two gotchas:

- **`tests/` is blanket-gitignored**; the test modules you see are
  force-added individually. If you add a test file, `git add -f` it —
  otherwise CI silently won't see it.
- `tests/test_cli_compat.py` is not a pytest module — it's a standalone,
  paid CLI-upgrade harness (`python tests/test_cli_compat.py`) and is
  excluded from collection.

Please add or extend a test when your change is security-relevant or fixes a
bug that could regress.

## Commit style

One logical change per commit, message format `type: short summary` in the
imperative, matching the existing history:

```
fix: return focus to selection origin widget when the comment bar closes
add: run the security regression suite in CI
security: hide credentials from stdout on non-loopback binds
docs: drop the AGPL §13 footnote from the README license section
```

Common types: `fix`, `add`, `tweak`, `security`, `docs`, `test`, `expose`.

## Developer Certificate of Origin (DCO)

By contributing, you certify the
[Developer Certificate of Origin](https://developercertificate.org/) — in
short, that you wrote the change (or otherwise have the right to submit it)
and that you're okay with it being distributed under this project's license.

Sign off each commit with `git commit -s`, which appends:

```
Signed-off-by: Your Name <your@email.example>
```

Use your real name and a reachable email address.

## License

pAInapple Code is licensed under
[AGPL-3.0-or-later](LICENSE). By submitting a contribution, you agree that it
will be distributed under the same license.
