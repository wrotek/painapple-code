"""Self-signed TLS cert for the server.

Stored alongside the auth config at ~/.config/painapple-code/{cert.pem,key.pem}.
No pinning, no OS-level trust install — TLS here guards against passive
snooping only; the design explicitly accepts the MITM risk in exchange for
zero cert ceremony.

The cert is intentionally long-lived (~10 years). Nothing validates the chain
or NotAfter, so a longer validity just means we re-issue less often.

The SAN, however, is NOT decorative. The Tauri app's loopback proxy skips
verification, but a plain browser pointed at the LAN bind does not: WebKit
rejects a cert whose SAN omits the address that was dialed, and in a PWA /
WKWebView context there is no interstitial to click through — every fetch
fails with `TypeError: Load failed` and nothing reaches the server, so the
access log stays empty and the failure looks like a dead network. So the SAN
has to cover whatever address the server is actually bound to, and a cert
that predates a bind change has to be reissued rather than reused.
"""

import ipaddress
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from painapple_code.paths import lock_mode


logger = logging.getLogger("painapple-code")

VALIDITY_DAYS = 365 * 10

# Always present, whatever the bind: the loopback proxy and `curl
# https://localhost:PORT` must keep working even when the server is bound
# to a LAN address.
_BASE_DNS = {"localhost"}
_BASE_IPS = {"127.0.0.1", "::1"}

# Binding one of these means "every interface", so the cert has to name every
# address the machine currently answers on, not the placeholder itself.
_WILDCARD_HOSTS = {"0.0.0.0", "::", ""}


def _required_sans(host):
    """(dns_names, ip_strings) the cert must cover for this bind address."""
    dns = set(_BASE_DNS)
    ips = set(_BASE_IPS)
    if not host:
        return dns, ips

    if host in _WILDCARD_HOSTS:
        # Wildcard bind: enumerate the real interfaces. Best-effort — an
        # address we miss just means a browser warning on that path, which
        # is where we already were.
        try:
            from painapple_code.cli.netinfo import detect_local_ips
            for ip, _iface in detect_local_ips():
                ips.add(ip)
        except Exception:
            pass
        return dns, ips

    try:
        ipaddress.ip_address(host)
    except ValueError:
        dns.add(host)          # a hostname, not an address
    else:
        ips.add(host)
    return dns, ips


def _covers(cert_path: Path, dns: set, ips: set) -> bool:
    """True when the cert on disk already names everything in dns/ips."""
    try:
        cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
        san = cert.extensions.get_extension_for_class(
            x509.SubjectAlternativeName).value
        have_dns = set(san.get_values_for_type(x509.DNSName))
        have_ips = {str(v) for v in san.get_values_for_type(x509.IPAddress)}
    except Exception:
        return False           # unparseable / no SAN → reissue
    return dns <= have_dns and ips <= have_ips


def ensure_cert(cert_path: Path, key_path: Path, host: str = None,
                managed: bool = True) -> None:
    """Generate a self-signed ECDSA P-256 cert covering `host` if needed.

    `managed` is False when the operator supplied --tls-cert/--tls-key: their
    cert is theirs, so a SAN that doesn't cover the bind is reported and left
    alone rather than silently overwritten.
    """
    cert_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    key_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # lock_mode, not os.chmod: this directory is bind-mounted from the
    # host in container mode, and chmod on a directory you don't OWN
    # fails with EPERM however writable it is — which would take TLS
    # startup down the same way it took auth startup down.
    lock_mode(cert_path.parent, 0o700)

    dns, ips = _required_sans(host)

    if not (cert_path.exists() and key_path.exists()):
        _generate(cert_path, key_path, dns, ips)
    elif not _covers(cert_path, dns, ips):
        if managed:
            logger.info(
                "TLS cert at %s does not cover the bind address %s — "
                "reissuing (browsers reject a SAN mismatch outright)",
                cert_path, host)
            _generate(cert_path, key_path, dns, ips)
        else:
            logger.warning(
                "TLS cert at %s has no SAN entry for the bind address %s. "
                "Browsers will refuse to connect. Reissue it, or drop "
                "--tls-cert/--tls-key to let painapple manage the cert.",
                cert_path, host)

    lock_mode(cert_path, 0o600)
    lock_mode(key_path, 0o600)


def _generate(cert_path: Path, key_path: Path, dns: set, ips: set) -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "pAInapple Code"),
    ])
    entries = [x509.DNSName(n) for n in sorted(dns)]
    for raw in sorted(ips):
        try:
            entries.append(x509.IPAddress(ipaddress.ip_address(raw)))
        except ValueError:
            continue
    san = x509.SubjectAlternativeName(entries)
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + timedelta(days=VALIDITY_DAYS))
        .add_extension(san, critical=False)
        .add_extension(
            x509.BasicConstraints(ca=False, path_length=None), critical=True
        )
        .sign(key, hashes.SHA256())
    )
    # Write the key first and the cert second, each via temp+rename: a crash
    # between the two would otherwise leave a cert that doesn't match the key,
    # and the server would fail to start with an opaque SSL error.
    _atomic_write(key_path, key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ))
    _atomic_write(cert_path, cert.public_bytes(serialization.Encoding.PEM))


def _atomic_write(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    os.replace(str(tmp), str(path))
