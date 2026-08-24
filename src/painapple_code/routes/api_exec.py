"""
Exec API Route - Shell command execution endpoint

Provides a POST endpoint for executing shell commands
with output capture and timeout handling.
"""

import asyncio
import logging
import os
import signal
import sys

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from painapple_code.utils.file_paths import safe_resolve

logger = logging.getLogger(__name__)

router = APIRouter(tags=["exec"])

# Combined stdout+stderr ceiling. `communicate()` buffers without limit, so a
# `cat` of a huge file or a runaway `yes` grows the server's heap until the OOM
# killer settles it. Generous enough that no realistic bang-command output is
# clipped; the truncation is reported, never silent.
MAX_OUTPUT_BYTES = 1 * 1024 * 1024


def _kill_tree(process) -> None:
    """Kill the command AND anything it spawned.

    `process.kill()` signals only the shell. A pipeline or a backgrounded child
    outlives it and keeps holding the pipes, so the timeout fires and the
    orphans keep running. POSIX commands are spawned with `start_new_session`
    so the whole group can be signalled at once; Windows has no equivalent here
    and gets the single-process kill.
    """
    try:
        if sys.platform != "win32":
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        else:
            process.kill()
    except (ProcessLookupError, PermissionError):
        pass  # already gone


async def _read_capped(stream, limit: int, on_overflow) -> tuple[bytes, bool]:
    """Read a pipe, keeping at most `limit` bytes.

    Keeps draining past the cap rather than just stopping: an unread pipe fills
    up and the child blocks forever on write, converting an over-limit command
    into a hang. `on_overflow` kills the process group the first time the cap is
    passed, which is what actually ends the read.
    """
    buf = bytearray()
    truncated = False
    while True:
        chunk = await stream.read(65536)
        if not chunk:
            return bytes(buf), truncated
        if not truncated:
            buf.extend(chunk[: limit - len(buf)])
            if len(buf) >= limit:
                truncated = True
                on_overflow()


class ExecRequest(BaseModel):
    command: str
    cwd: str = "."


@router.post("/api/exec")
async def execute_command(req: ExecRequest):
    """Execute a shell command directly and return the output.

    Inputs ride in a JSON body (not query params): this forces a
    non-simple cross-origin request (CORS-preflighted), so a hostile
    page can't fire ``POST /api/exec?command=...`` with the user's
    ambient cookie, and the command never lands in an access-log query
    string.
    """
    command = req.command
    cwd = req.cwd
    try:
        p = safe_resolve(cwd)
        if not p.exists() or not p.is_dir():
            raise HTTPException(status_code=400, detail="Invalid working directory")

        if sys.platform == "win32":
            # create_subprocess_shell would use COMSPEC (cmd.exe), whose
            # dialect shares almost nothing with the POSIX-shaped commands
            # every doc and quick-action here assumes. PowerShell is both
            # closer and what native Claude Code itself defaults to on
            # Windows. Note for docs: bang commands are PowerShell-flavored
            # on Windows.
            process = await asyncio.create_subprocess_exec(
                "powershell.exe", "-NoProfile", "-NonInteractive",
                "-Command", command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(p),
            )
        else:
            process = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(p),
                start_new_session=True,  # own process group, so _kill_tree gets the children too
            )

        killed = False

        def _overflow():
            nonlocal killed
            if not killed:
                killed = True
                logger.warning(f"exec output exceeded {MAX_OUTPUT_BYTES} bytes, killing: {command[:80]}")
                _kill_tree(process)

        try:
            (stdout, out_trunc), (stderr, err_trunc) = await asyncio.wait_for(
                asyncio.gather(
                    _read_capped(process.stdout, MAX_OUTPUT_BYTES, _overflow),
                    _read_capped(process.stderr, MAX_OUTPUT_BYTES, _overflow),
                ),
                timeout=30.0,
            )
            await process.wait()
        except asyncio.TimeoutError:
            _kill_tree(process)
            raise HTTPException(status_code=408, detail="Command timed out after 30 seconds")

        return {
            "command": command,
            "cwd": str(p),
            "exit_code": process.returncode,
            "stdout": stdout.decode('utf-8', errors='replace'),
            "stderr": stderr.decode('utf-8', errors='replace'),
            # Reported, not silent: a clipped result must not read as a complete
            # one. Callers that ignore this see less output, never wrong output.
            "truncated": out_trunc or err_trunc,
            "output_limit": MAX_OUTPUT_BYTES,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
