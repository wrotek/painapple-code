"""
Token Profiles - Per-session OAuth token management

Scans ~/.config/painapple-code/tokens/ for token files and provides helpers
to build subprocess environments with CLAUDE_CODE_OAUTH_TOKEN set.

Token files are plain text containing a single OAuth token string.
File names become profile names (e.g., "max", "team").
"""

import logging
import os
from typing import Optional

from painapple_code import paths

logger = logging.getLogger("painapple-code.tokens")

TOKENS_DIR = paths.CONFIG_HOME / "tokens"


def list_profiles() -> list[dict]:
    """List available token profiles from ~/.config/painapple-code/tokens/.

    Returns list of {"name": "profile_name"} dicts, sorted alphabetically.
    """
    if not TOKENS_DIR.is_dir():
        return []
    profiles = []
    for f in sorted(TOKENS_DIR.iterdir()):
        if f.is_file() and not f.name.startswith("."):
            profiles.append({"name": f.name})
    return profiles


def get_default_profile() -> Optional[str]:
    """Get the global default token profile name from config.json."""
    config = paths.load_global_config()
    return config.get("default_token_profile")


def read_token(profile_name: str) -> Optional[str]:
    """Read the token string for a profile. Returns None if not found."""
    token_path = TOKENS_DIR / profile_name
    if not token_path.is_file():
        logger.warning(f"Token profile not found: {profile_name}")
        return None
    try:
        return token_path.read_text(encoding="utf-8").strip()
    except Exception as e:
        logger.error(f"Failed to read token profile {profile_name}: {e}")
        return None


def resolve_profile(session_profile: Optional[str], provider=None) -> Optional[str]:
    """Resolve effective token profile: session override > engine default > None.

    With a provider, the default is that ENGINE's configured profile
    (`default_token_profiles` map, legacy flat key as fallback) — engines
    without selectable accounts resolve to None. Provider-less callers keep
    the legacy flat-key behavior.
    """
    if session_profile:
        return session_profile
    if provider is not None:
        return paths.engine_default_token_profile(provider)
    return get_default_profile()


def build_env(profile_name: Optional[str] = None) -> Optional[dict]:
    """Build subprocess environment dict with CLAUDE_CODE_OAUTH_TOKEN set.

    Args:
        profile_name: Token profile name, or None for inherited env.

    Returns:
        Environment dict with token set, or None (= inherit parent env).
    """
    if not profile_name:
        return None

    token = read_token(profile_name)
    if not token:
        return None

    env = os.environ.copy()
    env["CLAUDE_CODE_OAUTH_TOKEN"] = token
    # Remove CLAUDECODE to prevent "nested session" error if bridge
    # happens to run inside Claude Code (e.g., during development)
    env.pop("CLAUDECODE", None)
    return env
