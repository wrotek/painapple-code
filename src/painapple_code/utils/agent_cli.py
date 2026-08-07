"""
Claude CLI Utilities

Helper functions for interacting with the Claude Code CLI binary,
including process I/O, token parsing, and configuration.
"""

import asyncio
import json
import logging
import re
import signal
from typing import Optional

from painapple_code import bridge_paths

logger = logging.getLogger(__name__)


MAX_LINE_SIZE = 10 * 1024 * 1024  # 10MB limit for single JSON line (Claude thinking can be huge)

# Exit codes that indicate normal termination (not errors)
# Python subprocess: negative signal number (-15 for SIGTERM, -9 for SIGKILL)
# Shell convention: 128 + signal number (143 for SIGTERM, 137 for SIGKILL)
NORMAL_TERMINATION_CODES = frozenset({
    -signal.SIGTERM, 128 + signal.SIGTERM,  # -15, 143: graceful stop
    -signal.SIGKILL, 128 + signal.SIGKILL,  # -9, 137: forced kill (after timeout)
    -signal.SIGINT, 128 + signal.SIGINT,    # -2, 130: Ctrl+C / interrupt
})

def get_claude_binary() -> str:
    """Get the Claude CLI binary path from config or default to 'claude'.

    Checks global config for 'claude_path' setting.
    Falls back to 'claude' (uses PATH lookup).
    """
    config = bridge_paths.load_global_config()
    return config.get("claude_path", "claude")


# Default max thinking tokens (31999 to stay under limit, 63999 is Opus 4.5 max)
DEFAULT_MAX_THINKING_TOKENS = 31999


def get_max_thinking_tokens() -> int:
    """Get the max thinking tokens from config or default.

    This enables extended thinking in -p mode (required since Claude CLI 2.1.8).
    Set to 0 to disable extended thinking.
    """
    config = bridge_paths.load_global_config()
    return config.get("max_thinking_tokens", DEFAULT_MAX_THINKING_TOKENS)


def short_model_name(model_id: str) -> str:
    """Extract short model name from full model ID.

    'claude-opus-4-5-20251101' → 'opus'
    'claude-haiku-4-5-20251001' → 'haiku'
    'claude-sonnet-4-5-20250929' → 'sonnet'
    """
    model_id = model_id.lower()
    for name in ("opus", "sonnet", "haiku"):
        if name in model_id:
            return name
    return model_id.split("-")[1] if "-" in model_id else model_id


async def read_line_unlimited(stream: asyncio.StreamReader) -> bytes:
    """Read a line from stream without the default 64KB limit.

    Claude's thinking output can exceed the default asyncio readline limit.
    This function reads in chunks until a newline is found.
    """
    chunks = []
    total_size = 0

    while True:
        try:
            # Try to read until newline with a large limit
            chunk = await stream.readuntil(b'\n')
            chunks.append(chunk)
            return b''.join(chunks)
        except asyncio.LimitOverrunError as e:
            # Line is longer than buffer limit, read what we can and continue
            chunk = await stream.read(e.consumed)
            chunks.append(chunk)
            total_size += len(chunk)
            if total_size > MAX_LINE_SIZE:
                raise ValueError(f"Line exceeds maximum size of {MAX_LINE_SIZE} bytes")
        except asyncio.IncompleteReadError as e:
            # EOF reached
            chunks.append(e.partial)
            return b''.join(chunks)


def parse_token_value(val: str) -> int:
    """Parse token value like '33.3k', '1m', or '98' to integer."""
    val = val.strip()
    if val.endswith('m'):
        return int(float(val[:-1]) * 1_000_000)
    if val.endswith('k'):
        return int(float(val[:-1]) * 1000)
    return int(float(val))


async def fetch_context_tokens(cwd: str, provider_session_id: str = None, token_profile: str = None, model: str = None) -> Optional[dict]:
    """
    Run /context command to get accurate token usage for a session.

    If provider_session_id is provided, forks from that session to get actual
    context including conversation history. Otherwise returns base overhead only.

    Uses --fork-session + --no-session-persistence to avoid modifying the
    original session or creating new session files.

    Returns dict with contextTokens, contextWindow, and detailed breakdown.
    """
    try:
        claude_path = get_claude_binary()

        # Build command args
        args = [claude_path, "-p", "/context", "--output-format", "stream-json", "--verbose"]

        if provider_session_id:
            # Fork from existing session to get actual context usage
            # --fork-session creates new ID (doesn't modify original)
            # --no-session-persistence prevents saving to disk
            args.extend(["--resume", provider_session_id, "--fork-session", "--no-session-persistence"])
        else:
            # No session - just get base overhead
            args.append("--no-session-persistence")

        # Pass model so context window reflects the correct limit (e.g. 1M for opus[1m])
        if model:
            args.extend(["--model", model])

        from painapple_code.utils.token_profiles import build_env as build_token_env
        subprocess_env = build_token_env(token_profile)

        process = await asyncio.create_subprocess_exec(
            *args,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=subprocess_env,
            start_new_session=True,  # isolate from server's process group
        )

        stdout, stderr = await asyncio.wait_for(
            process.communicate(),
            timeout=10.0  # 10 second timeout
        )

        # Parse the output - extract /context markdown from whichever message type contains it
        # CLI 2.1.50: type="user", content in msg["message"]["content"]
        # CLI 2.1.63+: type="system" subtype="local_command_output", content in msg["content"]
        # Also check type="result" where content appears in msg["result"]
        # CLI 2.1.92+: type="assistant", content in msg["message"]["content"][*]["text"]
        stdout_text = stdout.decode()
        stderr_text = stderr.decode() if stderr else ""
        if stderr_text:
            logger.debug(f"fetch_context stderr: {stderr_text[:500]}")

        for line in stdout_text.split('\n'):
            if not line.strip():
                continue
            try:
                msg = json.loads(line)
                content = None
                msg_type = msg.get("type")

                if msg_type == "system" and msg.get("subtype") == "local_command_output":
                    # CLI 2.1.63+: direct content field
                    content = msg.get("content", "")
                elif msg_type == "assistant":
                    # CLI 2.1.92+: content in message.content[*].text
                    msg_content = msg.get("message", {}).get("content", [])
                    if isinstance(msg_content, list):
                        for block in msg_content:
                            if isinstance(block, dict) and block.get("type") == "text":
                                text = block.get("text", "")
                                if "**Tokens:**" in text:
                                    content = text
                                    break
                    elif isinstance(msg_content, str):
                        content = msg_content
                elif msg_type == "user":
                    # CLI <= 2.1.50: nested in message.content
                    content = msg.get("message", {}).get("content", "")
                elif msg_type == "result":
                    # Fallback: some versions put it in result text
                    content = msg.get("result", "")

                if content and "**Tokens:**" in content:
                    return parse_context_output(content)
            except json.JSONDecodeError:
                continue

        # Log what we got for debugging
        if stdout_text.strip():
            # Show message types we received
            types = []
            for line in stdout_text.split('\n'):
                if line.strip():
                    try:
                        m = json.loads(line)
                        t = m.get("type", "?")
                        st = m.get("subtype", "")
                        types.append(f"{t}/{st}" if st else t)
                    except json.JSONDecodeError:
                        types.append("non-json")
            logger.warning(f"fetch_context got output but no **Tokens:** found. Message types: {types}. Exit code: {process.returncode}")
        else:
            logger.warning(f"fetch_context got empty stdout. Exit code: {process.returncode}")

        return None

    except asyncio.TimeoutError:
        logger.warning(f"Timeout fetching context tokens for {cwd}")
        return None
    except Exception as e:
        logger.warning(f"Error fetching context tokens: {e}")
        return None


def parse_context_output(content: str) -> Optional[dict]:
    """
    Parse /context markdown output into structured data.

    Example input:
    **Model:** claude-opus-4-5-20251101
    **Tokens:** 33.3k / 200.0k (17%)

    | Category | Tokens | Percentage |
    |----------|--------|------------|
    | System prompt | 3.5k | 1.8% |
    ...
    """
    result = {}

    # Extract model: **Model:** claude-opus-4-5-20251101
    model_match = re.search(r'\*\*Model:\*\*\s+(\S+)', content)
    if model_match:
        result["model"] = model_match.group(1)

    # Extract tokens: **Tokens:** 33.3k / 200.0k (17%)  or  25.5k / 1m (3%)
    tokens_match = re.search(r'\*\*Tokens:\*\*\s+([\d.]+[km]?)\s*/\s*([\d.]+[km]?)\s*\((\d+)%\)', content)
    if tokens_match:
        result["contextTokens"] = parse_token_value(tokens_match.group(1))
        result["contextWindow"] = parse_token_value(tokens_match.group(2))
        result["percentage"] = int(tokens_match.group(3))
    else:
        return None  # Must have at least basic token info

    # Parse category breakdown table
    # | Category | Tokens | Percentage |
    # | System prompt | 3.5k | 1.8% |
    categories = {}
    category_pattern = re.compile(
        r'\|\s*([^|]+?)\s*\|\s*([\d.]+[km]?)\s*\|\s*([\d.]+)%\s*\|'
    )
    for match in category_pattern.finditer(content):
        category = match.group(1).strip()
        # Skip header row
        if category.lower() in ('category', '----------'):
            continue
        tokens = parse_token_value(match.group(2))
        pct = float(match.group(3))
        # Normalize category names to camelCase keys
        key = category.lower().replace(' ', '_')
        categories[key] = {"tokens": tokens, "pct": pct}

    if categories:
        result["breakdown"] = categories

    # Parse memory files section for detail
    # | Type | Path | Tokens |
    # | User | /home/user/.claude/CLAUDE.md | 1.0k |
    memory_files = []
    memory_section = re.search(r'### Memory Files\s*\n\n\|[^\n]+\n\|[^\n]+\n((?:\|[^\n]+\n)*)', content)
    if memory_section:
        memory_pattern = re.compile(r'\|\s*(\w+)\s*\|\s*([^|]+?)\s*\|\s*([\d.]+[km]?)\s*\|')
        for match in memory_pattern.finditer(memory_section.group(1)):
            memory_files.append({
                "type": match.group(1).strip(),
                "path": match.group(2).strip(),
                "tokens": parse_token_value(match.group(3))
            })
    if memory_files:
        result["memoryFiles"] = memory_files

    return result




