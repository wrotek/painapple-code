# Third-Party Notices

painapple-code redistributes the third-party components listed below. Each is
the property of its respective copyright holders and is provided under the
license noted. Full texts of the common licenses are reproduced in the
[License texts](#license-texts) appendix; longer licenses (Apache-2.0,
MPL-2.0, PSF) are referenced by their canonical URL.

This file is generated/maintained as part of the release process and shipped
inside the wheel and sdist.

The Python table is verified on every release: `.github/workflows/pypi-publish.yml`
installs the built wheel into a clean environment and runs
[`tools/check_licenses.py`](tools/check_licenses.py), which fails the build if
any resolved dependency carries a license outside the allowlist. Regenerate the
table with `python tools/check_licenses.py --table` from that same clean
environment — not from a dev virtualenv, which also contains test and docs
tooling that is never shipped.

---

## Bundled front-end assets

Self-hosted under `src/painapple_code/static/vendor/` and served same-origin
(no CDN). Versions are pinned in `static/vendor/README.md`.

| Component | Version | License | Copyright |
|-----------|---------|---------|-----------|
| CodeMirror 6 (39 packages — `@codemirror/*`, `@lezer/*`, `style-mod`, `crelt`, `w3c-keyname`, `@marijn/find-cluster-break`) | 6.x | MIT | Marijn Haverbeke and CodeMirror contributors |
| xterm.js | 5.x | MIT | The xterm.js authors |
| xterm-addon-fit | 0.8.x | MIT | The xterm.js authors |
| marked | 4.3.0 | MIT | Christopher Jeffrey and marked contributors |
| DOMPurify | 3.4.11 | Apache-2.0 OR MPL-2.0 | Dr.-Ing. Mario Heiderich, Cure53 |
| highlight.js (+ language packs, github-dark theme) | 11.9.0 | BSD-3-Clause | Ivan Sagalaev and highlight.js contributors |
| github-markdown-css | 5.x | MIT | Sindre Sorhus |

`codemirror.js` is a bundle, and bundling discards each package's `LICENSE`
file. Its per-package copyright notices are therefore reproduced verbatim in
[`src/painapple_code/static/vendor/codemirror.js.LEGAL.txt`](src/painapple_code/static/vendor/codemirror.js.LEGAL.txt),
generated at build time by `tools/gen-vendor-legal.mjs` from esbuild's
`--metafile` (the set of inputs actually bundled, which is why it lists 39
packages rather than the 20 direct `@codemirror/*` dependencies). The other
vendored files are shipped unmodified and keep whatever notices upstream
included.

## Node.js render helpers (optional, not redistributed)

`src/painapple_code/tools/vegalite-to-svg.js` and `excalidraw-to-svg.js` are
shipped in the wheel and shell out to Node for chart and diagram rendering.
The packages they import are **not** bundled or redistributed — they are
installed separately by the user, and the features degrade gracefully when
absent. Listed here because the shipped scripts require them.

| Package | Version | License |
|---------|---------|---------|
| vega | 6.2.0 | BSD-3-Clause |
| vega-lite | 6.4.2 | BSD-3-Clause |
| @excalidraw/utils | 0.1.3-test32 | MIT |
| canvas | 3.2.1 | MIT |
| jsdom | 28.0.0 | MIT |
| lz-string | 1.5.0 | MIT |

## Python runtime dependencies

The full dependency set resolved by a clean install of the wheel — direct
dependencies from `requirements.txt` plus every transitive dependency. Because
`requirements.txt` pins lower bounds (`>=`), the exact versions below are a
snapshot (resolved 2026-08-09); the licenses are what the release gate
enforces.

| Package | Version | License |
|---------|---------|---------|
| annotated-doc | 0.0.5 | MIT |
| annotated-types | 0.8.0 | MIT |
| anyio | 4.14.2 | MIT |
| attrs | 26.1.0 | MIT |
| certifi | 2026.7.22 | MPL-2.0 |
| cffi | 2.1.1 | MIT-0 |
| claude-agent-sdk | 0.2.134 | MIT |
| click | 8.4.2 | BSD-3-Clause |
| cryptography | 50.0.0 | Apache-2.0 OR BSD-3-Clause |
| duckdb | 1.5.5 | MIT |
| fastapi | 0.141.1 | MIT |
| h11 | 0.16.0 | MIT |
| httpcore | 1.0.9 | BSD-3-Clause |
| httptools | 0.8.0 | MIT |
| httpx | 0.28.1 | BSD-3-Clause |
| httpx-sse | 0.4.3 | MIT |
| idna | 3.18 | BSD-3-Clause |
| jsonschema | 4.26.0 | MIT |
| jsonschema-specifications | 2025.9.1 | MIT |
| mcp | 1.29.0 | MIT |
| pillow | 12.3.0 | MIT-CMU |
| prompt_toolkit | 3.0.53 | BSD-3-Clause |
| pycparser | 3.0 | BSD-3-Clause |
| pydantic | 2.13.4 | MIT |
| pydantic-settings | 2.15.0 | MIT |
| pydantic_core | 2.46.4 | MIT |
| PyJWT | 2.13.0 | MIT |
| python-dotenv | 1.2.2 | BSD-3-Clause |
| python-multipart | 0.0.32 | Apache-2.0 |
| pytz | 2026.3.post1 | MIT |
| PyYAML | 6.0.3 | MIT |
| questionary | 2.1.1 | MIT |
| referencing | 0.37.0 | MIT |
| rpds-py | 2026.6.3 | MIT |
| sniffio | 1.3.1 | MIT |
| sse-starlette | 3.4.8 | BSD-3-Clause |
| starlette | 1.6.0 | BSD-3-Clause |
| typing-inspection | 0.4.2 | MIT |
| typing_extensions | 4.16.0 | PSF-2.0 |
| uvicorn | 0.52.1 | BSD-3-Clause |
| uvloop | 0.22.1 | Apache-2.0 |
| watchfiles | 1.2.0 | MIT |
| wcwidth | 0.8.2 | MIT |
| websockets | 17.0.1 | BSD-3-Clause |

## Agent CLIs the bridge drives

painapple-code drives an agent CLI as a subprocess; it does not link against
one. Whether that CLI is redistributed depends on **which artifact** you took,
and the two differ:

| Artifact | Contains an agent CLI? |
|----------|------------------------|
| PyPI wheel / sdist (`pip install painapple-code`) | **No.** The user installs Claude Code, Codex, or another CLI separately, under that vendor's own terms. |
| Container image (`wrotek/painapple-code`) | **No.** `docker-entrypoint.sh` installs them from npm on first boot, into the user's own `/data` volume. |

Neither artifact redistributes an agent CLI. The image did bundle
`@anthropic-ai/claude-code` up to and including `v1.0.0-rc16`; it no longer
does, because that would have been redistribution of proprietary software
without a written grant (see below). The first container start now runs
`npm install -g` for `@anthropic-ai/claude-code@2` and `@openai/codex@latest`,
which makes the download the user's own — the same act as `npm i -g` on a
host, under the same terms. `PAINAPPLE_SKIP_AGENT_CLI=1` disables it, and
`PAINAPPLE_AGENT_CLIS` overrides the set.

`@openai/codex` is **Apache-2.0** ([openai/codex](https://github.com/openai/codex)),
so bundling it would have been permitted. It goes through the same first-run
install anyway, to keep one mechanism rather than two.

`@anthropic-ai/claude-code` is **proprietary software, not open source**: its
`LICENSE.md` reads "© Anthropic PBC. All rights reserved," and use is governed
by Anthropic's [Commercial Terms](https://www.anthropic.com/legal/commercial-terms)
or [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms)
depending on the plan, plus the [Usage Policy](https://www.anthropic.com/legal/aup).
It is **not** licensed under this project's AGPL, and this project claims no
rights in it — running it requires the user's own Anthropic account and their
own acceptance of those terms.

Note that Anthropic's terms distinguish ordinary personal use from operating a
service for others: OAuth/subscription credentials are intended for the
plan-holder's own use, while developers offering a product to third parties are
directed to API-key authentication. painapple-code is self-hosted and
single-tenant by design — you run it against your own account — but if you
expose an instance to other people, that distinction is yours to honour. See
[`SECURITY.md`](SECURITY.md) for the single-user threat model.

## Container image

The published container image is a separate distribution artifact from the
Python package, and carries considerably more third-party software than the
wheel does. It is built `FROM
docker.io/library/python:3.13-slim-bookworm` and installs Node.js 20 plus a set
of Debian packages for the in-container terminal (editors, `ripgrep`, `fd`,
`jq`, `git`, `tmux`, and similar). Those components remain under their own
upstream licenses — predominantly GPL, LGPL, MIT, and BSD as shipped by Debian
and NodeSource — and are neither modified nor relicensed by this project. Run
`dpkg-query -W -f='${Package} ${Version}\n'` inside the image for the exact
manifest of a given tag.

The image's `org.opencontainers.image.licenses` label (`AGPL-3.0-or-later`)
describes painapple-code's own source, not the aggregate of everything the
image contains.

---

## License texts

### MIT License

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### MIT No Attribution (MIT-0)

Used by cffi. Identical to the MIT license above minus the requirement to
reproduce the copyright notice — strictly more permissive. Full text:
<https://spdx.org/licenses/MIT-0.html>.

### BSD 3-Clause License

```
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### MIT-CMU / HPND (Pillow)

Pillow is released under the historical PIL Software License (an
HPND/MIT-CMU-style permissive license). Full text:
<https://github.com/python-pillow/Pillow/blob/main/LICENSE>.

### Apache License 2.0

Used by python-multipart, DOMPurify (dual with MPL-2.0), and cryptography
(dual with BSD-3-Clause). Full text: <https://www.apache.org/licenses/LICENSE-2.0>.
Per §4(d), any NOTICE files shipped by these projects are preserved in their
respective vendored/installed distributions.

### Mozilla Public License 2.0

Used by certifi and available as one option for DOMPurify. Full text:
<https://www.mozilla.org/en-US/MPL/2.0/>.

### Python Software Foundation License 2.0

Used by typing_extensions. Full text:
<https://docs.python.org/3/license.html>.
