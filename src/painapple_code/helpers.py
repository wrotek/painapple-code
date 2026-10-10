"""
Helpers - Track install state of bundled CLI/agent helpers.

Two kinds of helper:

* **Scripts** (`shadow-git`, `shadow-query`) → ``~/.local/bin``. Mirrors the
  FILES array in `tools/install-helpers.sh`.
* **Agents** (`shadow-git-helper`, `shadow-db-helper`) — one markdown source
  each under `tools/agents/`, installed for EVERY provider that is enabled
  and available on this box, into that provider's personal agent root and in
  that root's own format (``agent_roots()`` → ``fmt``: Claude's markdown
  `<name>.md`, Codex's `<name>.toml`). Registry-driven — no provider is named
  here, so a drop-in provider that self-describes a personal agent root gets
  the agents too. Before this, only `~/.claude/agents` was ever written, so a
  Codex user had no way to summon a journal-searching subagent at all.

Surfaces install/freshness state via `helpers_status()`, used by the
GET /api/app/helpers/status endpoint to drive the install-prompt UI.
"""

import hashlib
import json
import logging
import os
import re
import shutil
import stat as stat_mod
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from painapple_code import PACKAGE_DIR

logger = logging.getLogger(__name__)

# Script sources (relative to PACKAGE_DIR) → install target.
# Must mirror tools/install-helpers.sh:FILES.
SCRIPT_FILES = [
    ("tools/shadow-git", Path.home() / ".local" / "bin" / "shadow-git"),
    ("tools/shadow-query", Path.home() / ".local" / "bin" / "shadow-query"),
]

# Agent sources — markdown with YAML frontmatter (name/description/model).
AGENT_SOURCES = [
    "tools/agents/shadow-git-helper.md",
    "tools/agents/shadow-db-helper.md",
]

# NOTE: no per-agent sandbox overrides in the Codex rendering. A role file
# CAN carry `[sandbox_workspace_write] network_access = true`, but Codex
# subagents inherit the PARENT thread's sandbox (verified on 0.159: the child
# turn_context still says network_access=false), so it would be dead config.
# shadow-db-helper documents the fallback instead (shadow-git commit bodies
# carry the same journal) for sandboxed Codex sessions.

# Back-compat name: the original single-provider list. Scripts + the Claude
# agent paths that `install-helpers.sh` writes.
HELPER_FILES = SCRIPT_FILES + [
    (src, Path.home() / ".claude" / "agents" / Path(src).name)
    for src in AGENT_SOURCES
]


@dataclass(frozen=True)
class HelperTarget:
    src: str                      # source path relative to PACKAGE_DIR
    target: Path                  # absolute install path
    kind: str                     # "script" | "agent"
    fmt: str = ""                 # agents: "markdown" | "toml"
    provider: str = ""            # agents: provider name owning the root
    provider_label: str = ""      # agents: provider display name


def _agent_providers(enabled: Optional[dict], *, include_all: bool = False):
    """Providers whose personal agent root gets the helper agents.

    Enabled (Settings → Providers; `enabled` is
    ``dependencies.provider_enabled_map``, else each provider's
    `default_enabled`) AND available (its CLI resolves). Availability matters:
    both shipped providers default to enabled, and writing `~/.codex/agents`
    on a box that has never seen Codex would be litter.
    `include_all` → every registered provider (uninstall cleans up after a
    provider that has since been disabled or removed).
    """
    try:
        from painapple_code.providers import all_providers
        provs = all_providers()
    except Exception:
        logger.exception("helpers: provider registry unavailable")
        return []
    if include_all:
        return provs
    out = []
    for p in provs:
        on = enabled.get(p.name) if enabled is not None else p.default_enabled
        if not on:
            continue
        try:
            ok, _ = p.is_available()
        except Exception:
            ok = False
        if ok:
            out.append(p)
    return out


def _personal_agent_roots(providers) -> list[tuple]:
    """``(provider, dir, fmt)`` per distinct personal agent root, in registry
    order. Providers of one family share a root (e.g. two Claude drivers both
    → ~/.claude/agents); the first one claims it."""
    seen = set()
    roots = []
    for p in providers:
        try:
            entries = p.agent_roots(str(Path.home()))
        except Exception:
            logger.exception(f"helpers: agent_roots failed for {p.name}")
            continue
        for e in entries:
            if e.get("scope") != "personal" or not e.get("dir"):
                continue
            fmt = e.get("fmt") or "markdown"
            if fmt not in ("markdown", "toml"):
                continue
            d = Path(e["dir"])
            if d in seen:
                break
            seen.add(d)
            roots.append((p, d, fmt))
            break  # first personal root = where a new personal agent goes
    return roots


def helper_targets(enabled: Optional[dict] = None, *,
                   include_all: bool = False) -> list[HelperTarget]:
    """Every file the helper install manages on this box."""
    out = [HelperTarget(src, tgt, "script") for src, tgt in SCRIPT_FILES]
    for prov, d, fmt in _personal_agent_roots(
            _agent_providers(enabled, include_all=include_all)):
        ext = ".md" if fmt == "markdown" else ".toml"
        for src in AGENT_SOURCES:
            out.append(HelperTarget(
                src, d / (Path(src).stem + ext), "agent", fmt,
                prov.name, getattr(prov, "display_name", prov.name)))
    return out


def _split_frontmatter(text: str) -> tuple[dict, str]:
    """(frontmatter dict, body) of a markdown agent source."""
    import yaml
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    try:
        meta = yaml.safe_load(m.group(2)) or {}
    except Exception:
        meta = {}
    return (meta if isinstance(meta, dict) else {}), text[m.end():]


def _toml_str(value: str) -> str:
    """A TOML string literal. Multi-line literal (no escaping, readable in
    the installed file) unless the text contains its delimiter; JSON's
    escapes are a subset of TOML basic-string escapes otherwise."""
    if "'''" not in value and "\r" not in value:
        return "'''\n" + value + "'''"
    return json.dumps(value, ensure_ascii=False)


def render_agent(src_rel: str, fmt: str) -> str:
    """The installed content of agent `src_rel` for a root of format `fmt`."""
    text = (PACKAGE_DIR / src_rel).read_text(encoding="utf-8")
    if fmt == "markdown":
        return text
    meta, body = _split_frontmatter(text)
    name = str(meta.get("name") or Path(src_rel).stem)
    lines = [
        "# Generated by painapple-code helper install from "
        f"{Path(src_rel).name} — re-run install to refresh; local edits are overwritten.",
        f"name = {json.dumps(name)}",
        f"description = {json.dumps(str(meta.get('description') or name), ensure_ascii=False)}",
        f"developer_instructions = {_toml_str(body.strip() + chr(10))}",
    ]
    return "\n".join(lines) + "\n"


# Legacy install paths that earlier versions wrote — install + uninstall
# both clean these up so users don't end up with both old and new agents
# in `#` autocomplete after a rename. Safe to keep forever.
LEGACY_TARGETS = [
    Path.home() / ".claude" / "agents" / "shadow-git-researcher.md",
    Path.home() / ".local" / "bin" / "dbq",
]

# These two helpers are bash scripts, which used to mean "not on Windows".
# They do work there: Git for Windows ships bash and every coreutil they
# call (sha256sum, sed, cut, awk...), and anyone using shadow-git already
# has git. What they can't do is be *invoked* from the PowerShell the
# terminal tab runs, so on Windows each one also gets a .cmd shim.
SHELL_SCRIPT_SOURCES = {"tools/shadow-git", "tools/shadow-query"}

_NO_BASH_REASON = "needs Git for Windows (bash) — not found"


def find_bash() -> str | None:
    """Absolute path to a bash that can run the shell helpers, or None.

    On Windows, resolve Git for Windows' own bash from git.exe rather than
    trusting PATH. `C:\\Windows\\System32\\bash.exe` is the WSL launcher: it
    would run the helper inside a Linux filesystem namespace where
    ~/.painapple-code is a DIFFERENT (empty) directory, so the helper would
    succeed while querying nothing. Git ships bash at <root>/bin/bash.exe
    and deliberately keeps it off PATH, so PATH alone finds the wrong one.
    """
    if sys.platform != "win32":
        return shutil.which("bash")

    git = shutil.which("git")
    if git:
        root = Path(git).parent.parent  # ...\Git\cmd\git.exe -> ...\Git
        for cand in (root / "bin" / "bash.exe", root / "usr" / "bin" / "bash.exe"):
            if cand.is_file():
                return str(cand)

    found = shutil.which("bash")
    if found and Path(found).parent.name.lower() != "system32":
        return found
    return None


def _shim_path(target: Path) -> Path:
    """The .cmd next to `target` that makes it callable from PowerShell."""
    return target.with_name(target.name + ".cmd")


def _shim_body(bash: str, target: Path) -> str:
    """A batch wrapper that hands the script to bash and forwards argv.

    The bash path is resolved at install time, not runtime: a missing Git
    then fails with a readable message from cmd instead of a silent
    fall-through to whatever else answers to `bash`.
    """
    return (
        "@echo off\r\n"
        "rem Generated by painapple-code helper install. Re-run install to refresh.\r\n"
        f'"{bash}" "{target}" %*\r\n'
    )


def _supported_here(src_rel: str) -> bool:
    if sys.platform == "win32" and src_rel in SHELL_SCRIPT_SOURCES:
        return find_bash() is not None
    return True

# The helper agents' model is user-selectable (see
# paths.get_helper_agent_model). The choice is a Claude model id, so it is
# applied to MARKDOWN (Claude-format) agent targets only; Codex-format agents
# inherit the spawning session's model. The `model:` frontmatter line is kept
# orthogonal to the freshness check so a non-default choice doesn't read as
# "outdated", and is re-applied after every install (the copy resets it).
AGENT_SRC_REL = AGENT_SOURCES[0]
AGENT_TARGET = Path.home() / ".claude" / "agents" / "shadow-git-helper.md"

# Matches the leading YAML frontmatter block only (anchored at start, up to the
# first closing `---`), so example frontmatter later in the body is untouched.
_FRONTMATTER_RE = re.compile(r"\A(---[ \t]*\r?\n)(.*?\r?\n)(---[ \t]*\r?\n?)", re.DOTALL)
_MODEL_LINE_RE = re.compile(r"(?im)^[ \t]*model:.*\r?\n?")


def _strip_model_line(text: str) -> str:
    """Remove the `model:` line from the leading frontmatter only."""
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return text
    body = _MODEL_LINE_RE.sub("", m.group(2))
    return m.group(1) + body + m.group(3) + text[m.end():]


def _set_model_line(text: str, model: str) -> str:
    """Set `model: <model>` in the leading frontmatter, replacing any existing."""
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return text
    body = _MODEL_LINE_RE.sub("", m.group(2))
    if body and not body.endswith("\n"):
        body += "\n"
    body += f"model: {model}\n"
    return m.group(1) + body + m.group(3) + text[m.end():]


def _markdown_agent_targets(enabled: Optional[dict] = None) -> list[Path]:
    return [t.target for t in helper_targets(enabled)
            if t.kind == "agent" and t.fmt == "markdown"]


def read_installed_agent_model(enabled: Optional[dict] = None) -> str | None:
    """Return the `model:` value parsed from the first installed markdown
    agent file, or None."""
    for target in _markdown_agent_targets(enabled) or [AGENT_TARGET]:
        try:
            text = target.read_text(encoding="utf-8")
        except Exception:
            continue
        m = _FRONTMATTER_RE.match(text)
        if not m:
            continue
        mm = re.search(r"(?im)^[ \t]*model:[ \t]*(\S+)", m.group(2))
        return mm.group(1).strip().lower() if mm else None
    return None


def _sha256(path: Path) -> str | None:
    """Return hex sha256 of a file's contents, or None if unreadable."""
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except Exception as e:
        logger.debug(f"sha256 failed for {path}: {e}")
        return None


def _normalized_hash(path: Path) -> str | None:
    """sha256 of file text with the frontmatter `model:` line removed, so the
    user's model choice does not read as a freshness mismatch."""
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as e:
        logger.debug(f"read failed for {path}: {e}")
        return None
    return hashlib.sha256(_strip_model_line(text).encode("utf-8")).hexdigest()


def _target_current(t: HelperTarget) -> bool:
    """Does the installed file match what install would write now?"""
    if t.kind == "agent" and t.fmt == "markdown":
        # Model choice is orthogonal to freshness — compare content with
        # the `model:` frontmatter line stripped from both sides.
        src_hash = _normalized_hash(PACKAGE_DIR / t.src)
        tgt_hash = _normalized_hash(t.target)
    elif t.kind == "agent":
        try:
            want = render_agent(t.src, t.fmt).encode("utf-8")
        except Exception:
            return False
        src_hash = hashlib.sha256(want).hexdigest()
        tgt_hash = _sha256(t.target)
    else:
        src_hash = _sha256(PACKAGE_DIR / t.src)
        tgt_hash = _sha256(t.target)
    return src_hash is not None and src_hash == tgt_hash


def helpers_status(enabled: Optional[dict] = None) -> dict:
    """
    Per-file install + freshness state, plus aggregate flags.

    `enabled` is the provider enabled-map (routes pass
    ``provider_enabled_map(app)``); agents are listed for every enabled,
    available provider's personal agent root.

    Returns:
        {
          "files": [
            {"name": "shadow-git", "src": "tools/shadow-git", "target": "/...",
             "kind": "script"|"agent", "provider": str, "provider_label": str,
             "installed": bool, "up_to_date": bool},
            ...
          ],
          "agent_hosts": [{"provider": str, "label": str, "fmt": str}],
          "all_installed": bool,    # every target exists
          "all_current": bool,      # every target exists AND matches source
          "any_outdated": bool,     # at least one installed-but-stale file
        }
    """
    files = []
    all_installed = True
    all_current = True
    any_outdated = False
    hosts = []

    for t in helper_targets(enabled):
        base = {
            "name": t.target.name,
            "src": t.src,
            "target": str(t.target),
            "kind": t.kind,
            "provider": t.provider,
            "provider_label": t.provider_label,
        }
        if t.kind == "agent" and not any(h["provider"] == t.provider for h in hosts):
            hosts.append({"provider": t.provider, "label": t.provider_label,
                          "fmt": t.fmt})

        if not _supported_here(t.src):
            # Don't let a helper we deliberately never install drag
            # all_installed/all_current to False forever — that would
            # show a permanent "helpers outdated" nag on Windows.
            files.append({**base, "installed": False, "up_to_date": False,
                          "unsupported": True,
                          "unsupported_reason": _NO_BASH_REASON})
            continue

        installed = t.target.exists()
        up_to_date = False
        if installed:
            up_to_date = _target_current(t)
            if (up_to_date and sys.platform == "win32"
                    and t.src in SHELL_SCRIPT_SOURCES
                    and not _shim_path(t.target).exists()):
                # Script content is current but the .cmd is missing — an
                # install from before shims existed. It's unreachable from
                # the terminal's PowerShell, so surface it as stale and let
                # the normal Install button regenerate the wrapper.
                up_to_date = False
            if not up_to_date:
                any_outdated = True
        else:
            all_installed = False

        if not (installed and up_to_date):
            all_current = False

        files.append({**base, "installed": installed, "up_to_date": up_to_date})

    from painapple_code import paths

    return {
        "files": files,
        "agent_hosts": hosts,
        "all_installed": all_installed,
        "all_current": all_current,
        "any_outdated": any_outdated,
        # How to actually invoke the helper in THIS platform's terminal.
        # PowerShell resolves a bare name through PATHEXT and finds the
        # .cmd, but `~/.local/bin/shadow-git` (no extension) silently does
        # nothing there — it exits 0 having run no command at all, which is
        # worse than an error. POSIX shells take the explicit path.
        "usage_command": ("shadow-git log" if sys.platform == "win32"
                          else "~/.local/bin/shadow-git log"),
        # Model the Claude-format helper subagents run on (full model ID or
        # "inherit"); options mirror the main model selector + "inherit".
        "agent_model": paths.get_helper_agent_model(),
        "agent_model_options": paths.get_helper_agent_options(),
    }


def install_helpers_script_path() -> Path:
    """Return the path to tools/install-helpers.sh — the equivalent shell
    script users can run by hand (scripts + Claude agents only; the
    per-provider agent rendering lives here). install_helpers() below does
    the full job in-process; this stays for docs and manual installs."""
    return PACKAGE_DIR / "tools" / "install-helpers.sh"


def install_helpers(force: bool = True, enabled: Optional[dict] = None) -> dict:
    """Write the bundled helpers to their user-level targets.

    Scripts are copied (mkdir -p, copy, chmod 755 when the source is
    executable — a Python port of tools/install-helpers.sh --update; the
    endpoint used to shell out to `bash`, which isn't there on a stock
    Windows box). Agents are rendered per target root format.

    Returns the same {ok, exit_code, stdout, stderr} shape the route
    reports, so the frontend is unchanged.
    """
    lines = [f"painapple-code helpers — install (pkg: {PACKAGE_DIR})", ""]
    errors = []

    bash = find_bash() if sys.platform == "win32" else None

    for t in helper_targets(enabled):
        src_rel, target = t.src, t.target
        if not _supported_here(src_rel):
            lines.append(f"  skip   {target}  ({_NO_BASH_REASON})")
            continue
        src_abs = PACKAGE_DIR / src_rel
        if not src_abs.is_file():
            errors.append(f"source missing: {src_abs}")
            continue
        existed = target.exists()
        if existed and not force:
            lines.append(f"  skip   {target}  (exists — use --update to overwrite)")
            continue
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            if t.kind == "agent" and t.fmt != "markdown":
                target.write_text(render_agent(src_rel, t.fmt), encoding="utf-8")
            else:
                # copyfile, not copy2: we deliberately do not carry over
                # source mtimes (the freshness check hashes content instead).
                shutil.copyfile(src_abs, target)
                if os.access(src_abs, os.X_OK):
                    target.chmod(0o755)  # mirrors the script's `chmod 755`
            label = f"  ({t.provider_label})" if t.provider_label else ""
            lines.append(f"  {'update' if existed else 'install'} {target}{label}")
            if bash and src_rel in SHELL_SCRIPT_SOURCES:
                # PowerShell (what the terminal tab runs) can't execute an
                # extensionless bash script; the .cmd is what makes
                # `shadow-git log` work there the way it does on a POSIX box.
                shim = _shim_path(target)
                shim.write_text(_shim_body(bash, target), encoding="ascii")
                lines.append(f"  {'update' if existed else 'install'} {shim}")
        except OSError as e:
            logger.warning(f"install: failed to write {target}: {e}")
            errors.append(f"{target}: {e}")

    for legacy in LEGACY_TARGETS:
        if legacy.exists():
            try:
                legacy.unlink()
                lines.append(f"  remove {legacy}  (legacy)")
            except OSError as e:
                errors.append(f"{legacy}: {e}")

    return {
        "ok": not errors,
        "exit_code": 0 if not errors else 1,
        "stdout": "\n".join(lines) + "\n",
        "stderr": "\n".join(errors),
    }


def uninstall_helpers() -> dict:
    """
    Remove every installed helper target from disk — across EVERY registered
    provider's agent root, not just the currently enabled ones, so disabling
    a provider and then uninstalling leaves nothing behind — plus any legacy
    targets from earlier installs. Idempotent — missing targets are skipped,
    not errors.

    Returns:
        {
          "ok": bool,           # True if every target is gone after the call
          "removed": [str],     # paths actually deleted this call
          "missing": [str],     # paths that were already absent
          "errors": [{"path": str, "error": str}],
        }
    """
    removed: list[str] = []
    missing: list[str] = []
    errors: list[dict] = []

    all_targets = helper_targets(include_all=True)
    targets = [t.target for t in all_targets] + LEGACY_TARGETS
    if sys.platform == "win32":
        # Remove what install could have created — the PowerShell shims.
        targets += [_shim_path(t.target) for t in all_targets
                    if t.src in SHELL_SCRIPT_SOURCES]
    for target in dict.fromkeys(targets):
        if not target.exists():
            missing.append(str(target))
            continue
        try:
            target.unlink()
            removed.append(str(target))
        except Exception as e:
            logger.warning(f"uninstall: failed to remove {target}: {e}")
            errors.append({"path": str(target), "error": str(e)})

    return {
        "ok": not errors,
        "removed": removed,
        "missing": missing,
        "errors": errors,
    }


def apply_agent_model(model: str, enabled: Optional[dict] = None) -> bool:
    """Write `model: <model>` into every installed markdown helper agent.

    Returns True when at least one installed file now carries that model
    (whether it needed a write or was already correct), False otherwise.
    """
    applied = False
    for target in _markdown_agent_targets(enabled):
        if not target.exists():
            continue
        try:
            text = target.read_text(encoding="utf-8")
        except Exception as e:
            logger.warning(f"apply_agent_model: read failed for {target}: {e}")
            continue
        new_text = _set_model_line(text, model)
        if new_text != text:
            try:
                target.write_text(new_text, encoding="utf-8")
            except Exception as e:
                logger.warning(f"apply_agent_model: write failed for {target}: {e}")
                continue
        applied = True
    return applied


def apply_agent_model_from_config(enabled: Optional[dict] = None) -> bool:
    """Re-apply the persisted model choice to the installed agent files.

    Called after install, whose copy overwrites the installed markdown with
    the bundled default model line.
    """
    from painapple_code import paths
    return apply_agent_model(paths.get_helper_agent_model(), enabled)
