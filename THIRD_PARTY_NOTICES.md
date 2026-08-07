# Third-Party Notices

painapple-code redistributes the third-party components listed below. Each is
the property of its respective copyright holders and is provided under the
license noted. Full texts of the common licenses are reproduced in the
[License texts](#license-texts) appendix; longer licenses (Apache-2.0,
MPL-2.0, PSF) are referenced by their canonical URL.

This file is generated/maintained as part of the release process and shipped
inside the wheel and sdist.

---

## Bundled front-end assets

Self-hosted under `src/painapple_code/static/vendor/` and served same-origin
(no CDN). Versions are pinned in `static/vendor/README.md`.

| Component | Version | License | Copyright |
|-----------|---------|---------|-----------|
| CodeMirror 6 (`@codemirror/*`, 20 packages) | 6.x | MIT | Marijn Haverbeke and CodeMirror contributors |
| xterm.js | 5.x | MIT | The xterm.js authors |
| xterm-addon-fit | 0.8.x | MIT | The xterm.js authors |
| marked | 4.3.0 | MIT | Christopher Jeffrey and marked contributors |
| DOMPurify | 3.4.11 | Apache-2.0 OR MPL-2.0 | Dr.-Ing. Mario Heiderich, Cure53 |
| highlight.js (+ language packs, github-dark theme) | 11.9.0 | BSD-3-Clause | Ivan Sagalaev and highlight.js contributors |
| github-markdown-css | 5.x | MIT | Sindre Sorhus |

## Python runtime dependencies

Declared in `requirements.txt` (direct) plus notable transitive dependencies.

| Package | Version (tested) | License |
|---------|------------------|---------|
| fastapi | 0.122.0 | MIT |
| starlette | 0.50.0 | BSD-3-Clause |
| uvicorn | 0.38.0 | BSD-3-Clause |
| websockets | 15.0.1 | BSD-3-Clause |
| duckdb | 1.4.4 | MIT |
| pytz | 2025.2 | MIT |
| PyYAML | 6.0.3 | MIT |
| Pillow | 12.3.0 | MIT-CMU (HPND) |
| python-multipart | 0.0.32 | Apache-2.0 |
| cryptography | 48.0.0 | Apache-2.0 OR BSD-3-Clause |
| httpx | 0.28.1 | BSD-3-Clause |
| httpcore | 1.0.9 | BSD-3-Clause |
| questionary | 2.1.1 | MIT |
| claude-agent-sdk | 0.2.111 | MIT |
| anyio | 4.11.0 | MIT |
| sniffio | 1.3.1 | MIT OR Apache-2.0 |
| certifi | 2026.4.22 | MPL-2.0 |
| idna | 3.11 | BSD-3-Clause |
| h11 | 0.16.0 | MIT |
| click | 8.3.1 | BSD-3-Clause |
| pydantic | 2.12.5 | MIT |
| typing_extensions | 4.15.0 | PSF-2.0 |

> Claude Code itself and any other CLI agent the bridge drives are **not**
> redistributed by this project — they are installed separately by the user or
> pulled at container build time under their own vendor terms. See `SECURITY.md`
> and the docs for the distribution/authentication model.

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
