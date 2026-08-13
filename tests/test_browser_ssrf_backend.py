"""The browser-proxy SSRF guard relies on httpx/httpcore internals.

`routes/api_browser._guarded_async_client()` pins outbound connections to a
DNS-validated IP by swapping httpx's private
`transport._pool._network_backend` for a custom `_SSRFGuardBackend`. That poke
is wrapped in a try/except that degrades to pre-checks-only if the internal
shape ever changes — which is safe against a crash but SILENT against a
security regression: a bump that renamed the attribute would quietly drop the
TOCTOU-closing DNS pin and nobody would notice.

httpx/httpcore are upper-capped in requirements.txt (`httpx<1.0`,
`httpcore<2.0`) precisely because of this coupling, but a bump *within* the
allowed range could still shift the internal. This test asserts the backend is
actually installed on the resolved httpx, so such a change fails CI instead of
silently weakening SSRF protection. If it ever fails: the fallback is working
(pre-checks still apply) but the IP-pinning is gone — re-fit the backend to the
new internal shape and, if it's a major bump, raise the requirements cap
deliberately.
"""

import asyncio

from painapple_code.routes.api_browser import (
    _guarded_async_client,
    _SSRFGuardBackend,
)


def test_ssrf_guard_backend_is_installed_on_current_httpx():
    async def _build_and_inspect():
        client = _guarded_async_client()
        try:
            backend = client._transport._pool._network_backend
        finally:
            await client.aclose()
        return backend

    backend = asyncio.run(_build_and_inspect())
    assert isinstance(backend, _SSRFGuardBackend), (
        "httpx internal shape changed within the allowed version range — the "
        "SSRF IP-pinning backend is no longer installed and the proxy has "
        "degraded to pre-checks only. Re-fit _guarded_async_client() to the "
        "new httpx internals (see requirements.txt httpx/httpcore caps)."
    )
