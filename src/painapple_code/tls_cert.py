"""Self-signed TLS cert for the server.

Stored alongside the auth config at ~/.config/painapple-code/{cert.pem,key.pem}.
Clients (the Tauri app's loopback proxy in particular) accept the cert without
verification — no pinning, no OS-level trust install. TLS here guards against
passive snooping only; the design explicitly accepts the MITM risk in exchange
for zero cert ceremony.

The cert is intentionally long-lived (~10 years). Nothing validates the chain
or NotAfter, so a longer validity just means we re-issue less often.
"""

import ipaddress
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from painapple_code.paths import lock_mode


VALIDITY_DAYS = 365 * 10


def ensure_cert(cert_path: Path, key_path: Path) -> None:
    """Generate a self-signed ECDSA P-256 cert at the given paths if absent."""
    cert_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    key_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # lock_mode, not os.chmod: this directory is bind-mounted from the
    # host in container mode, and chmod on a directory you don't OWN
    # fails with EPERM however writable it is — which would take TLS
    # startup down the same way it took auth startup down.
    lock_mode(cert_path.parent, 0o700)

    if not (cert_path.exists() and key_path.exists()):
        _generate(cert_path, key_path)

    lock_mode(cert_path, 0o600)
    lock_mode(key_path, 0o600)


def _generate(cert_path: Path, key_path: Path) -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "pAInapple Code"),
    ])
    # SAN content doesn't gate trust (clients don't verify the cert) but some
    # TLS libs still parse it. Cover the common local names so curl etc. work
    # when a user opts into chain-validation with their own trust anchor.
    san = x509.SubjectAlternativeName([
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
        x509.IPAddress(ipaddress.IPv6Address("::1")),
    ])
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
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ))
