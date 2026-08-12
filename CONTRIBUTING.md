# Contributing

pAInapple Code is a young, solo-maintained project. Formal contribution
guidelines — contribution licensing policy (DCO/CLA), code of conduct, PR
process — are still being worked out and will land here soon.

Until then, three things:

- **Open an issue before writing code** for anything bigger than a typo or
  an obvious small fix. A large PR that arrives without prior discussion may
  sit for a while or be declined if it doesn't fit the project's direction.
- **Security issues are never GitHub issues.** Use
  [private vulnerability reporting](https://github.com/wrotek/painapple-code/security/advisories/new)
  — see [SECURITY.md](SECURITY.md).
- Contributions are accepted under the project's license,
  [AGPL-3.0-or-later](LICENSE).

## Dev setup, if you want to poke around

Python ≥ 3.12 and git are all you need:

```bash
git clone https://github.com/wrotek/painapple-code.git
cd painapple-code
python3 -m venv venv && source venv/bin/activate
pip install -e '.[test]'
python -m painapple_code --port 8765 --workspace /path/to/some/project
```

The frontend has no build step in development — edit a file under
`src/painapple_code/static/`, refresh the browser, done.

Tests are in-process and quick (`python -m pytest tests/ -q`). One gotcha:
`tests/` is blanket-gitignored and the visible modules are force-added — if
you add a test file, `git add -f` it or CI won't see it.
