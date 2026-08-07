"""WP-04 B0 — baseline security response headers + CSP stage 1."""


def test_baseline_security_headers_present(client):
    r = client.get("/health")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["referrer-policy"] == "no-referrer"
    assert "camera=()" in r.headers["permissions-policy"]


def test_csp_locks_down_object_and_framing(client):
    csp = client.get("/health").headers["content-security-policy"]
    assert "default-src 'self'" in csp
    assert "object-src 'none'" in csp
    assert "frame-ancestors 'none'" in csp
    assert "base-uri 'self'" in csp
    assert "script-src" in csp


def test_csp_allows_remote_images_and_https_frames(client):
    # M2/M3: remote images (badges, model output) and browser-widget direct
    # mode need https: in img-src/frame-src; scripts must stay locked.
    csp = client.get("/health").headers["content-security-policy"]
    assert "img-src 'self' data: blob: https:" in csp
    assert "frame-src 'self' https:" in csp
    # script-src must NOT have opened up to https:
    script_directive = next(d for d in csp.split(";") if d.strip().startswith("script-src"))
    assert "https:" not in script_directive
