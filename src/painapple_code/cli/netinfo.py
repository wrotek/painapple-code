"""Host network introspection shared by the setup wizards and the
container launch path. Import-cheap: stdlib plus psutil, both imported
inside the functions so importing this module stays nearly free."""

import sys


def detect_local_ips():
    """[(ip, interface)] for every non-loopback IPv4 the host has.

    psutil rather than parsing `ip`/`ifconfig`: neither exists on Windows,
    and ipconfig's output is localized (and OEM-encoded), so scraping it
    would break on any non-English install. psutil is a hard dependency
    (requirements.txt, no environment marker), so there is no fallback to
    keep — the old scrape sat behind an ImportError that cannot fire.
    """
    import socket

    import psutil

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
        pass  # exotic/unsupported interface table — report what we got
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

    # psutil: works on all three platforms and needs no ss/lsof. (On
    # Windows neither exists, so the holder was always reported as unknown
    # — the user got "port in use" with no way to tell what by.) The ss/
    # lsof scrape that used to follow this was unreachable-by-design
    # fallback: psutil is a hard dependency, so it only ever ran when
    # psutil ALSO failed, in which case ss wouldn't have known better.
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
        pass  # AccessDenied for other users' sockets — decoration only
    return ""
