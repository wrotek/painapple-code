"""The self-signed cert must name the address the server is bound to.

A SAN that omits the bind address is not a cosmetic wart. WebKit rejects the
connection outright, and in a PWA / WKWebView there is no interstitial to
click through, so every `fetch()` dies with an opaque `TypeError: Load failed`
while the request never reaches the server — the access log stays empty and
the whole thing presents as a dead network rather than a cert problem.

The original implementation hardcoded the SAN to localhost/127.0.0.1/::1 with
a comment reasoning that "SAN content doesn't gate trust (clients don't verify
the cert)". True of the Tauri loopback proxy, false of every browser, so
`--tls auto` + a LAN bind (the default the setup wizard steers to) was never
reachable from another machine.

Two failure modes are locked in here: the SAN must cover the bind at issue
time, and a cert that PREDATES a bind change must be reissued rather than
reused — the address is usually a DHCP lease, so it moves.
"""

import ipaddress

import pytest

pytest.importorskip("cryptography")

from cryptography import x509  # noqa: E402

from painapple_code.tls_cert import ensure_cert  # noqa: E402


def _san(cert_path):
    cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
    san = cert.extensions.get_extension_for_class(
        x509.SubjectAlternativeName).value
    return (set(san.get_values_for_type(x509.DNSName)),
            {str(v) for v in san.get_values_for_type(x509.IPAddress)})


def test_lan_bind_is_in_the_san(tmp_path):
    ensure_cert(tmp_path / "cert.pem", tmp_path / "key.pem",
                host="192.168.1.209")
    dns, ips = _san(tmp_path / "cert.pem")
    assert "192.168.1.209" in ips
    # loopback must survive — the Tauri proxy and `curl https://localhost`
    # both keep using it while the server is bound to the LAN.
    assert "127.0.0.1" in ips and "::1" in ips
    assert "localhost" in dns


def test_hostname_bind_lands_in_dns_not_ip(tmp_path):
    ensure_cert(tmp_path / "cert.pem", tmp_path / "key.pem",
                host="macwrotek.local")
    dns, _ips = _san(tmp_path / "cert.pem")
    assert "macwrotek.local" in dns


def test_cert_is_reissued_when_the_bind_address_moves(tmp_path):
    """A DHCP lease change must not leave a cert naming the old address."""
    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    ensure_cert(cert, key, host="192.168.1.209")
    first = cert.read_bytes()

    ensure_cert(cert, key, host="192.168.1.77")
    assert cert.read_bytes() != first, "stale cert was reused after rebind"
    _dns, ips = _san(cert)
    assert "192.168.1.77" in ips


def test_repeat_start_on_the_same_bind_does_not_churn(tmp_path):
    """Reissuing every boot would invalidate the exception users accepted."""
    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    ensure_cert(cert, key, host="192.168.1.209")
    stable = cert.read_bytes()
    ensure_cert(cert, key, host="192.168.1.209")
    assert cert.read_bytes() == stable


def test_operator_supplied_cert_is_never_overwritten(tmp_path):
    """--tls-cert/--tls-key means the cert is theirs; warn, don't clobber."""
    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    ensure_cert(cert, key, host="192.168.1.209")
    theirs = cert.read_bytes()
    ensure_cert(cert, key, host="10.0.0.5", managed=False)
    assert cert.read_bytes() == theirs


def test_wildcard_bind_covers_a_real_interface(tmp_path):
    """0.0.0.0 must enumerate interfaces — the placeholder is not dialable."""
    from painapple_code.cli.netinfo import detect_local_ips
    local = {ip for ip, _ in detect_local_ips()}
    ensure_cert(tmp_path / "cert.pem", tmp_path / "key.pem", host="0.0.0.0")
    _dns, ips = _san(tmp_path / "cert.pem")
    assert "0.0.0.0" not in ips
    if local:
        assert local & ips, "wildcard bind named no real interface"


def test_generated_key_matches_the_generated_cert(tmp_path):
    """Cert and key are written separately — a mismatch is an opaque
    SSL error at boot, so prove they pair."""
    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    ensure_cert(cert, key, host="192.168.1.209")
    from cryptography.hazmat.primitives import serialization
    pub_from_cert = x509.load_pem_x509_certificate(
        cert.read_bytes()).public_key()
    priv = serialization.load_pem_private_key(key.read_bytes(), password=None)
    enc = serialization.Encoding.PEM
    fmt = serialization.PublicFormat.SubjectPublicKeyInfo
    assert (pub_from_cert.public_bytes(enc, fmt)
            == priv.public_key().public_bytes(enc, fmt))
