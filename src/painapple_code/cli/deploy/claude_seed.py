"""Seeding an isolated CLAUDE_HOME for container sandboxes."""

import json
from pathlib import Path

# Subset of ~/.claude.json worth carrying into the container: "not a
# fresh install" flags so the onboarding wizard doesn't re-run. The
# host file's `projects` map is keyed by host paths (dead in the
# container) and caches refetch on first run — deliberately skipped.
# KEEP IN SYNC with CLAUDE_JSON_ALLOW in
# tauri-app/src-tauri/src/local.rs (the desktop app's setup wizard
# seeds an isolated CLAUDE_HOME the same way).
CLAUDE_JSON_ALLOW = {
    "hasCompletedOnboarding",
    "lastOnboardingVersion",
    "installMethod",
    "migrationVersion",
    "claudeCodeFirstTokenDate",
    "opusProMigrationComplete",
    "sonnet1m45MigrationComplete",
    "lastReleaseNotesSeen",
    "opus47LaunchSeenCount",
}


def seed_claude_json(src, dst):
    """Write a minimal .claude.json (dst) from the allowlisted fields of
    the host file (src). Returns False on any parse/write problem."""
    try:
        from painapple_code.paths import lock_mode

        data = json.loads(Path(src).read_text(encoding="utf-8"))
        subset = {k: data[k] for k in CLAUDE_JSON_ALLOW if k in data}
        Path(dst).write_text(json.dumps(subset, indent=2), encoding="utf-8")
        # lock_mode, not chmod: on Windows chmod only toggles the
        # read-only attribute and reports success, so the 0600 here was
        # decorative and this file inherited whatever ACEs its parent had.
        lock_mode(dst, 0o600)
        return True
    except (OSError, ValueError):
        return False
