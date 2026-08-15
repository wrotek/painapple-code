# Changelog

Notable changes are documented here per release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/), and the git tag is the single source of truth for the version (the PyPI wheel, the Docker image tag, and `__version__` all derive from it).

## 1.0.0 — unreleased

First public release.

### Security

- **Stored cross-site scripting in the tool renderers.** Fixed in `1.0.0rc36`; affects the published pre-releases `1.0.0rc30` through `1.0.0rc35`. Six sites interpolated untrusted text into inline `onclick` handlers using escaping that does not hold in an HTML attribute context: `JSON.stringify(value).replace(/"/g, '&quot;')` maps both the JSON string's own delimiters *and* any literal `&quot;` already in the payload onto the same sequence, and the HTML parser decodes it back to `"` before the JavaScript is compiled — so a payload containing `&quot;` closed the string early and the remainder ran as code. Two of those sites carry tool **output** (`Bash` stdout/stderr, `WebFetch`/`WebSearch` page content), so reading an attacker-controlled file or fetching a hostile page was enough to execute script in the application origin — which holds the session cookie and a WebSocket whose protocol executes shell commands. Two further sites escaped file paths for apostrophes only, so a filename containing a double quote could terminate the attribute and inject sibling attributes. Untrusted values are now base64-encoded into `data-` attributes and read back via `dataset`, keeping them out of inline JavaScript entirely; base64's alphabet contains no quote, `&` or `<`, so no payload can terminate the attribute or the script.
- **Content-Security-Policy: `script-src` is now `'self'`.** `'unsafe-inline'` has been removed. Every inline `<script>` was externalized and all 87 inline `on*` handlers replaced by a delegated dispatcher, so the bug class above is no longer exploitable even if an individual sink regresses. A regression test asserts `'unsafe-inline'` and `'unsafe-eval'` cannot reappear in `script-src`.
- **Removed the Eruda mobile-devtools quick action**, which loaded a third-party script from a CDN.
- **Pinned `httpx <1.0` / `httpcore <2.0`.** The browser-proxy SSRF guard reaches into private internals of both to pin outbound connections to a DNS-validated IP; a new test asserts that backend is actually installed, so an in-range upgrade that reshapes those internals fails CI instead of silently degrading to pre-checks only.

### Fixed

- **`pip install` failed outright on ARM64 Windows and Intel macOS.** `cryptography` publishes no wheel for either platform (Windows/ARM after 46.0.3, Intel macOS after 48.0.1), and pip ranks candidates by version before wheel-vs-sdist — so it selected a newer source distribution and attempted a Rust build that fails on a stock machine. It is needed by exactly one lazily imported module (self-signed certificate generation for `--tls`), so it is now platform-conditional: omitted from the default install on those platforms, with an opt-in `[tls]` extra that pins the last wheel-shipping version for each. Requesting TLS without it now prints an actionable message naming the right package for the platform, instead of an unhandled import error.
