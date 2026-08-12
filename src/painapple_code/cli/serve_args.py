"""Argument parser for ``painapple serve`` — the single source of truth.

IMPORT-LIGHT ZONE: this module is the fast path for ``-v`` /
``serve --help`` / argparse errors, which ``cli.main()`` resolves
*before* paying the ~300ms ``painapple_code.server`` import. It may
import ``argparse``, ``os``, ``sys``, and ``painapple_code.__version__``
— NOTHING else. No server, no fastapi, no routes, no yaml.
``tests/test_cli_startup.py`` asserts fastapi stays unimported.

Both callers build from here, so help/error output and parsing are
byte-identical by construction:

- ``cli.main()`` — the fast gate (parse, then discard)
- ``server.main()`` — the real boot (re-parse, ~1ms, keeps its
  signature and late ``parser.error()`` calls unchanged)
"""

import argparse
import os
import sys

from painapple_code import __version__

#: Default bind port. Shared with ``server.resolve_allowed_origins()``, which
#: derives its no-config trusted-origin fallback from it — keep it a constant so
#: the two can't drift (they did: a hardcoded origin list outlived a port
#: renumber and shipped a stale port as a trusted default for months).
DEFAULT_PORT = 8765


def _subcommands_epilog():
    """Epilog for `serve --help` pointing back at the command overview
    and the other subcommands (the curated front door is `painapple
    help`; this page is deliberately just the full serve-flag dump).

    argparse colorizes its own generated help (usage, option strings,
    section headings) on Python 3.14+, but passes this free-form epilog
    through verbatim — so it renders plain while everything above it is
    colored. Match argparse's own decision: colorize the block only when
    argparse would (3.14+, a TTY, and NO_COLOR unset), otherwise emit
    plain text. ANSI codes have zero display width, so column alignment
    is unaffected.
    """
    color = (
        sys.version_info >= (3, 14)
        and sys.stdout.isatty()
        and not os.environ.get("NO_COLOR")
    )
    b = "\033[1m" if color else ""   # bold heading
    g = "\033[32m" if color else ""  # green subcommand
    d = "\033[2m" if color else ""   # dim description
    r = "\033[0m" if color else ""
    return "\n".join((
        f"{b}profiles{r}:",
        f"  painapple {g}--profile NAME{r}   {d}run a named deployment in the foreground (own port/data/sessions){r}",
        f"  painapple {g}setup NAME{r}       {d}create/edit that profile (host or docker mode){r}",
        "",
        f"{b}more{r}:",
        f"  painapple {g}help{r}          {d}command overview (setup · list · start/stop/restart · status · …){r}",
        f"  painapple {g}setup{r}         {d}save global defaults for these flags (~/.painapple-code/serve.yaml){r}",
        f"  painapple {g}list{r}          {d}every instance on this machine (profiles + running processes){r}",
    ))


def build_parser():
    """The full ``painapple serve`` flag parser."""
    parser = argparse.ArgumentParser(
        prog="painapple", description="pAInapple Code Server",
        usage="painapple [serve] [--port N] [--workspace PATH] [flags…]",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=_subcommands_epilog())
    parser.add_argument("-v", "--version", action="version",
                        version=f"painapple {__version__}")

    core = parser.add_argument_group(
        "server", "where it listens and what it works on")
    core.add_argument("--host", default="127.0.0.1",
                      help="Host interface to bind (default 127.0.0.1 — this machine "
                           "only; 0.0.0.0 = every interface, reachable on your LAN)")
    core.add_argument("--port", type=int, default=DEFAULT_PORT, help="Port to bind to")
    core.add_argument("--workspace", "--cwd", dest="workspace", default=".",
                      help="Workspace root — the directory holding your projects. "
                           "You pick the actual project in-app from the welcome "
                           "screen, and each session's files/git/terminal follow "
                           "its own directory. This anchors the file explorer and "
                           "the welcome screen's project suggestions. Mapped to "
                           "/workspace inside Docker. (--cwd is an alias)")
    core.add_argument("--instance-name", default=None,
                      help="Instance label for PWA icon and UI (e.g., DEV, STABLE)")
    core.add_argument("--accent", default=None,
                      help="Accent color: preset (blue/green/red/orange/purple/cyan/gray/yellow/pink/teal/indigo/lime) or hex (#f87171)")
    core.add_argument("--in-docker", action="store_true",
                      help="Run this same invocation inside a container instead "
                           "(Docker/Podman): the workspace (default: current dir) is "
                           "mounted into the prebuilt image, foreground, Ctrl-C stops "
                           "it. Runtime/image defaults come from `painapple setup`; "
                           "fetch the image once with `painapple pull`.")

    net = parser.add_argument_group(
        "network security", "TLS for non-loopback binds")
    net.add_argument("--tls", choices=("auto", "on", "off"), default="auto",
                     help="TLS mode. 'auto' (default) enables TLS when binding to a non-loopback "
                          "host. 'on' forces TLS. 'off' disables it. Self-signed cert is "
                          "auto-generated; clients accept it without verification (TLS here "
                          "guards against passive snooping only).")
    pw = net.add_mutually_exclusive_group()
    pw.add_argument("--no-password", "--no-passwd", dest="no_password",
                    action="store_true",
                    help="Never print credentials to stdout: the startup box hides "
                         "the password and strips the ?tkn= from the login URL. "
                         "Retrieve them later with `painapple password` or from the "
                         "auth config file. Useful when the console is visible to "
                         "others (screen shares, recorded demos, shared logs). "
                         "This is already the default on non-loopback binds.")
    pw.add_argument("--show-password", dest="show_password",
                    action="store_true",
                    help="Print credentials even on a non-loopback bind. By default "
                         "only loopback binds (127.0.0.1/::1/localhost) show the "
                         "password and ?tkn= login URL — a LAN/public server's "
                         "stdout tends to outlive the terminal (journald, docker "
                         "logs), so there they're hidden unless you opt in.")
    net.add_argument("--tls-cert", default=None, metavar="PATH",
                     help="TLS cert path (default: <config-dir>/cert.pem, auto-generated)")
    net.add_argument("--tls-key", default=None, metavar="PATH",
                     help="TLS key path (default: <config-dir>/key.pem, auto-generated)")

    adv = parser.add_argument_group(
        "advanced", "provider choice and opt-in extras")
    adv.add_argument("--default-provider", default=None, metavar="NAME",
                     help="Provider for NEW sessions (existing sessions keep their "
                          "recorded provider). Overrides the `default_provider` "
                          "global-config key. E.g. 'claude-sdk' (Agent SDK driver — "
                          "interactive permission cards, live mode/model switching; "
                          "default) or 'claude' (line protocol).")
    adv.add_argument("--enable-eruda", action="store_true",
                     help="Enable the Eruda mobile devtools quick action (loads from CDN; off by default)")
    adv.add_argument("--public-origin", action="append", default=None, metavar="ORIGIN",
                     help="Trusted browser origin for a proxied deployment, e.g. "
                          "https://claude.example.com. Repeatable. Adds to the "
                          "HTTP/WebSocket Origin allowlist (and replaces the default, "
                          "which trusts only loopback on the bound port). Also "
                          "honoured via BRIDGE_ALLOWED_ORIGINS.")
    adv.add_argument("--enable-renderers", action="store_true",
                     help="Enable server-side Vega-Lite/Excalidraw rendering (off by "
                          "default: model-authored specs are rendered via a Node "
                          "subprocess whose data loader can fetch external/file URLs — "
                          "an SSRF/local-file-read vector. Also honoured via the "
                          "PAINAPPLE_ENABLE_RENDERERS env var).")

    tiers = parser.add_argument_group(
        "multi-instance", "isolate state when several servers share one user "
        "(each instance needs its own shadow DB — DuckDB is single-writer)")
    tiers.add_argument("--shadow-db", default=None, metavar="PATH",
                       help="DuckDB path for shadow DB (default: ~/.painapple-code/shadow.duckdb)")
    tiers.add_argument("--log-dir", default=None, metavar="PATH",
                       help="Log directory (default: ~/.painapple-code/logs/)")
    tiers.add_argument("--state-suffix", default=None, metavar="SUFFIX",
                       help="Per-tier suffix for UI-state files (tab-state, shortcuts, "
                            "presets, favorites, global config) so co-located tiers don't "
                            "share them, e.g. 'dev' gives tab-state-dev.json (a leading "
                            "'-' is added automatically). Project and session history "
                            "stays shared. Default: none (stable tier).")
    tiers.add_argument("--auth-config-file", default=None, metavar="PATH",
                       help="Config file path (default: ~/.config/painapple-code/config.yaml)")
    return parser
