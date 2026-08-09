"""
Exec API Route - Shell command execution endpoint

Provides a POST endpoint for executing shell commands
with output capture and timeout handling.
"""

import asyncio
import logging
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(tags=["exec"])


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
        p = Path(cwd).expanduser().resolve()
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
                cwd=str(p)
            )

        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30.0)
        except asyncio.TimeoutError:
            process.kill()
            raise HTTPException(status_code=408, detail="Command timed out after 30 seconds")

        return {
            "command": command,
            "cwd": str(p),
            "exit_code": process.returncode,
            "stdout": stdout.decode('utf-8', errors='replace'),
            "stderr": stderr.decode('utf-8', errors='replace')
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
