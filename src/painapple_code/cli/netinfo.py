"""Host network introspection shared by the setup wizards and the
container launch path. Import-cheap (stdlib only)."""

import re
import shutil
import subprocess
import sys


def detect_local_ips():
    """[(ip, interface)] for every non-loopback IPv4 the host has.

    psutil rather than parsing `ip`/`ifconfig`: neither exists on Windows,
    and ipconfig's output is localized (and OEM-encoded), so scraping it
    would break on any non-English install. Falls back to the old command
    scrape only if psutil is somehow unavailable.
    """
    import socket
    try:
        import psutil
    except ImportError:
        return _detect_local_ips_legacy()

    results = []
    try:
        stats = psutil.net_if_stats()
        for iface, addrs in psutil.net_if_addrs().items():
            st = stats.get(iface)
            if st is not None and not st.isup:
                continue
            for addr in addrs:
                if addr.family != socket.AF_INET:
                    continue
                ip = addr.address
                if ip.startswith("127.") or iface in ("lo", "lo0"):
                    continue
                results.append((ip, iface))
    except Exception:
        return _detect_local_ips_legacy()
    return results


def _detect_local_ips_legacy():
    """The pre-psutil iproute2/ifconfig scrape, kept as a safety net."""
    results = []
    if shutil.which("ip"):
        out = subprocess.run(["ip", "-4", "-o", "addr", "show"],
                             capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 4 and parts[1] != "lo":
                results.append((parts[3].split("/")[0], parts[1]))
    elif shutil.which("ifconfig"):
        out = subprocess.run(["ifconfig"], capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
        iface = ""
        for line in out.splitlines():
            if line and not line[0].isspace():
                iface = line.split()[0].rstrip(":")
            m = re.search(r"inet (?:addr:)?([0-9.]+)", line)
            if m and iface not in ("lo", "lo0") and not m.group(1).startswith("127."):
                results.append((m.group(1), iface))
    return results


def port_taken(host, port):
    """Reason string when `host:port` can't be bound, '' when it's free.

    A plain bind test — catches ANY holder, unlike a scan of painapple's
    own process table. Used by the server's own pre-flight and by
    `painapple start` so the failure is reported before a detached child
    inherits it. Unresolvable host counts as taken (with the reason)."""
    import socket
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        return f"cannot resolve host {host!r} ({e})"
    family, socktype, proto, _canon, sockaddr = infos[0]
    with socket.socket(family, socktype, proto) as sock:
        # SO_REUSEADDR means opposite things on the two platforms. On POSIX
        # it only skips the TIME_WAIT guard, which is what we want here. On
        # Windows it permits binding a port another socket is ACTIVELY
        # listening on (Microsoft's documented port-hijacking behavior) —
        # so this probe would report "free" while a server was running, and
        # every caller (boot pre-flight, `painapple start`, the container
        # launcher) would happily start a second instance on the same port,
        # after which Windows routes new connections to whichever bound
        # last. Setting nothing on win32 gives the strict bind we need.
        if sys.platform != "win32":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(sockaddr)
        except OSError as e:
            return e.strerror or str(e)
    return ""


def port_holder(port):
    """Best-effort description of what already listens on `port` — the
    painapple instance if it's one of ours, else whatever ss/lsof names.
    '' when nothing can be determined. Never raises (decoration only)."""
    try:
        from painapple_code.cli.list_cmd import local_servers
        row = next((r for r in local_servers()
                    if str(r["port"]) == str(port)), None)
        if row:
            label = row.get("name") or "unnamed instance"
            return (f"painapple '{label}' (pid {row['pid']}, "
                    f"workspace {row.get('workspace') or '?'})")
    except Exception:
        pass

    # psutil first: works on all three platforms and needs no ss/lsof.
    # (On Windows neither exists, so the holder was always reported as
    # unknown — the user got "port in use" with no way to tell what by.)
    try:
        import psutil
        for conn in psutil.net_connections(kind="inet"):
            if (conn.status == psutil.CONN_LISTEN and conn.laddr
                    and conn.laddr.port == int(port) and conn.pid):
                try:
                    return f"{psutil.Process(conn.pid).name()} (pid {conn.pid})"
                except psutil.Error:
                    return f"pid {conn.pid}"
    except Exception:
        pass  # AccessDenied for other users' sockets — fall through

    probes = []
    if shutil.which("ss"):
        probes.append(["ss", "-ltnp", f"sport = :{port}"])
    if shutil.which("lsof"):
        probes.append(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"])
    for cmd in probes:
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                                 timeout=3).stdout
        except Exception:
            continue
        # ss: users:(("python",pid=123,fd=7))
        m = re.search(r'\("?([\w.-]+)"?,pid=(\d+)', out)
        if m:
            return f"{m.group(1)} (pid {m.group(2)})"
        lines = [ln for ln in out.splitlines()[1:] if ln.strip()]
        if lines:
            parts = lines[0].split()
            if len(parts) >= 2:
                return f"{parts[0]} (pid {parts[1]})"
    return ""
