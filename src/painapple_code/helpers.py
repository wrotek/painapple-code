"""
Helpers - Track install state of bundled CLI/agent helpers.

Mirrors the FILES array in `tools/install-helpers.sh`. If you add a new
helper there, add it here too (and vice versa).

Surfaces install/freshness state via `helpers_status()`, used by the
GET /api/bridge/helpers/status endpoint to drive the install-prompt UI.
"""

import hashlib
import logging
import re
from pathlib import Path

from painapple_code import PACKAGE_DIR

logger = logging.getLogger(__name__)

# Source-in-package (relative to PACKAGE_DIR) → install target (absolute, expanded $HOME).
# Must mirror tools/install-helpers.sh:FILES.
HELPER_FILES = [
    ("tools/shadow-git", Path.home() / ".local" / "bin" / "shadow-git"),
    ("tools/shadow-query", Path.home() / ".local" / "bin" / "shadow-query"),
    ("tools/agents/shadow-git-helper.md",
     Path.home() / ".claude" / "agents" / "shadow-git-helper.md"),
]

# Legacy install paths that earlier versions wrote — install + uninstall
# both clean these up so users don't end up with both old and new agents
# in `#` autocomplete after a rename. Safe to keep forever.
LEGACY_TARGETS = [
    Path.home() / ".claude" / "agents" / "shadow-git-researcher.md",
    Path.home() / ".local" / "bin" / "dbq",
]

# The shadow-git-helper agent's model is user-selectable (see
# bridge_paths.get_helper_agent_model). Its `model:` frontmatter line is kept
# orthogonal to the freshness check so a non-default choice doesn't read as
# "outdated", and is re-applied after every install (cp -f resets it).
AGENT_SRC_REL = "tools/agents/shadow-git-helper.md"
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


def read_installed_agent_model() -> str | None:
    """Return the `model:` value parsed from the installed agent file, or None."""
    try:
        text = AGENT_TARGET.read_text(encoding="utf-8")
    except Exception:
        return None
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return None
    mm = re.search(r"(?im)^[ \t]*model:[ \t]*(\S+)", m.group(2))
    return mm.group(1).strip().lower() if mm else None


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


def helpers_status() -> dict:
    """
    Per-file install + freshness state, plus aggregate flags.

    Returns:
        {
          "files": [
            {"name": "shadow-git", "src": "tools/shadow-git", "target": "/...",
             "installed": bool, "up_to_date": bool},
            ...
          ],
          "all_installed": bool,    # every target exists
          "all_current": bool,      # every target exists AND matches source hash
          "any_outdated": bool,     # at least one installed-but-stale file
        }
    """
    files = []
    all_installed = True
    all_current = True
    any_outdated = False

    for src_rel, target in HELPER_FILES:
        src_abs = PACKAGE_DIR / src_rel
        installed = target.exists()
        up_to_date = False

        if installed:
            if src_rel == AGENT_SRC_REL:
                # Model choice is orthogonal to freshness — compare content
                # with the `model:` frontmatter line stripped from both sides.
                src_hash = _normalized_hash(src_abs)
                tgt_hash = _normalized_hash(target)
            else:
                src_hash = _sha256(src_abs)
                tgt_hash = _sha256(target)
            up_to_date = src_hash is not None and src_hash == tgt_hash
            if not up_to_date:
                any_outdated = True
        else:
            all_installed = False

        if not (installed and up_to_date):
            all_current = False

        files.append({
            "name": target.name,
            "src": src_rel,
            "target": str(target),
            "installed": installed,
            "up_to_date": up_to_date,
        })

    from painapple_code import bridge_paths

    return {
        "files": files,
        "all_installed": all_installed,
        "all_current": all_current,
        "any_outdated": any_outdated,
        # Model the shadow-git-helper subagent runs on (full model ID or
        # "inherit"); options mirror the main model selector + "inherit".
        "agent_model": bridge_paths.get_helper_agent_model(),
        "agent_model_options": bridge_paths.get_helper_agent_options(),
    }


def install_helpers_script_path() -> Path:
    """Return the path to tools/install-helpers.sh — the script the API endpoint shells out to."""
    return PACKAGE_DIR / "tools" / "install-helpers.sh"


def uninstall_helpers() -> dict:
    """
    Remove every installed helper target from disk, plus any legacy
    targets from earlier installs (renamed/moved files). Idempotent —
    missing targets are skipped, not errors.

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

    targets = [t for _, t in HELPER_FILES] + LEGACY_TARGETS
    for target in targets:
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


def apply_agent_model(model: str) -> bool:
    """Write `model: <model>` into the installed shadow-git-helper frontmatter.

    Returns True when the installed file exists and now carries that model
    (whether it needed a write or was already correct), False otherwise.
    """
    if not AGENT_TARGET.exists():
        return False
    try:
        text = AGENT_TARGET.read_text(encoding="utf-8")
    except Exception as e:
        logger.warning(f"apply_agent_model: read failed: {e}")
        return False
    new_text = _set_model_line(text, model)
    if new_text != text:
        try:
            AGENT_TARGET.write_text(new_text, encoding="utf-8")
        except Exception as e:
            logger.warning(f"apply_agent_model: write failed: {e}")
            return False
    return True


def apply_agent_model_from_config() -> bool:
    """Re-apply the persisted model choice to the installed agent file.

    Called after install-helpers.sh, whose `cp -f` overwrites the installed
    copy with the bundled default (model: sonnet).
    """
    from painapple_code import bridge_paths
    return apply_agent_model(bridge_paths.get_helper_agent_model())
