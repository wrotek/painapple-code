"""The browser-proxy SSRF guard relies on httpx/httpcore internals.

`routes/api_browser._guarded_async_client()` pins outbound connections to a
DNS-validated IP by swapping httpx's private
`transport._pool._network_backend` for a custom `_SSRFGuardBackend`. That poke
is wrapped in a try/except. It used to degrade to pre-checks-only if the
internal shape ever changed — safe against a crash but SILENT against a
security regression: a bump that renamed the attribute would quietly drop the
TOCTOU-closing DNS pin and nobody would notice. As of 2026-08 it FAILS CLOSED
instead — `_guarded_async_client()` raises `SSRFGuardUnavailable` and the proxy
returns 503 rather than fetching without the IP pin.

httpx/httpcore are upper-capped in requirements.txt (`httpx<1.0`,
`httpcore<2.0`) precisely because of this coupling, but a bump *within* the
allowed range could still shift the internal. These tests assert both halves of
the contract: the backend really installs on the resolved httpx (so a shift
fails CI, not just runtime), AND that when it can't install the builder refuses
rather than returning a degraded client. If the first fails: re-fit the backend
to the new internal shape and, if it's a major bump, raise the requirements cap
deliberately.
"""

import asyncio

import httpx
import pytest

import painapple_code.routes.api_browser as api_browser
from painapple_code.routes.api_browser import (
    SSRFGuardUnavailable,
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


def test_builder_fails_closed_when_pool_attribute_is_gone(monkeypatch):
    """Rename/removal case: `_pool` (or its `_network_backend`) no longer
    accepts the assignment → AttributeError → refuse, not degrade."""

    class _NoPoolTransport:
        # __slots__ = () → setting any attribute raises AttributeError, which
        # is the shape of "httpx renamed the private internal".
        __slots__ = ()

    def _fake_transport(*args, **kwargs):
        return _NoPoolTransport()

    monkeypatch.setattr(api_browser.httpx, "AsyncHTTPTransport", _fake_transport)
    with pytest.raises(SSRFGuardUnavailable):
        _guarded_async_client()


def test_builder_fails_closed_when_set_is_silently_ignored(monkeypatch):
    """Subtler case: the set 'succeeds' but doesn't stick (read-only property /
    reshaped pool). The read-back isinstance check must still refuse — a
    swallowed set is exactly how IP-pinning would vanish without an error."""

    class _IgnoringPool:
        @property
        def _network_backend(self):
            return None

        @_network_backend.setter
        def _network_backend(self, value):
            pass  # silently drop it

    class _IgnoringTransport:
        def __init__(self, *args, **kwargs):
            self._pool = _IgnoringPool()

    monkeypatch.setattr(api_browser.httpx, "AsyncHTTPTransport", _IgnoringTransport)
    with pytest.raises(SSRFGuardUnavailable):
        _guarded_async_client()
