"""What a guide session can run from the chat's / menu: its harness's own commands and skills.

Claude Code reports them itself when a session starts (slash commands, skills and plugin commands, as the
terminal has them). Codex has no slash commands but has skills, kept as folders with a ``SKILL.md`` and named in a
message as ``$name``; the menu shows them as / commands and the turn sends them the way Codex expects.
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path

_CACHE: dict[tuple, tuple[float, list[dict]]] = {}
TTL = 60.0

# Built-ins that only make sense in a terminal (they'd do nothing, or something odd, sent from the chat).
TERMINAL_ONLY = {
    "exit", "quit", "clear", "resume", "login", "logout", "config", "theme", "vim", "ide", "terminal-setup",
    "doctor", "status", "statusline", "permissions", "hooks", "agents", "mcp", "plugin", "model", "help",
    "keybindings", "export", "rewind", "add-dir", "bug", "feedback", "upgrade", "privacy-settings", "release-notes",
}  # fmt: skip


async def claude_commands(cwd: Path | None, cli_path: str | None) -> list[dict]:
    """Ask Claude Code, as the session would start in ``cwd`` with the user's settings, what it can run."""
    from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

    opts = ClaudeAgentOptions(
        cwd=str(cwd) if cwd else None, setting_sources=["user", "project", "local"], cli_path=cli_path
    )
    info: dict = {}
    async with ClaudeSDKClient(options=opts) as client:
        info = await client.get_server_info() or {}
    out = []
    for c in info.get("commands") or []:
        name = c.get("name") if isinstance(c, dict) else str(c)
        if name and name not in TERMINAL_ONLY:
            out.append({"name": name, "description": (c.get("description") or "") if isinstance(c, dict) else "",
                        "hint": (c.get("argumentHint") or "") if isinstance(c, dict) else ""})  # fmt: skip
    return out


_FRONT = re.compile(r"^---\s*\n(.*?)\n---", re.S)


def _frontmatter(text: str) -> dict[str, str]:
    m = _FRONT.match(text)
    out = {}
    for line in (m.group(1) if m else "").splitlines():
        k, _, v = line.partition(":")
        if v:
            out[k.strip()] = v.strip().strip("\"'")
    return out


def codex_skills(cwd: Path | None, home: Path | None = None) -> list[dict]:
    """Skills Codex would find: the user's (``$CODEX_HOME/skills``) and the repository's (``.codex/skills``)."""
    home = home or Path.home()
    roots = [Path(os.environ.get("CODEX_HOME") or home / ".codex") / "skills"]
    if cwd:
        roots.append(cwd / ".codex" / "skills")
    out, seen = [], set()
    for root in roots:
        for f in sorted(root.glob("*/SKILL.md")) if root.is_dir() else []:
            try:
                meta = _frontmatter(f.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                continue
            name = meta.get("name") or f.parent.name
            if name not in seen:
                seen.add(name)
                out.append({"name": name, "description": meta.get("description", ""), "hint": ""})
    return out


async def session_commands(harness: str, cwd: Path | None, cli_path: str | None) -> list[dict]:
    key = (harness, str(cwd), cli_path)
    hit = _CACHE.get(key)
    if hit and time.monotonic() - hit[0] < TTL:
        return hit[1]
    if harness == "claude-code":
        cmds = await claude_commands(cwd, cli_path)
    elif harness == "codex":
        cmds = codex_skills(cwd)
    else:
        cmds = []
    _CACHE[key] = (time.monotonic(), cmds)
    return cmds


def raw_command(harness: str, text: str) -> str | None:
    """A message that is a command, as the harness takes it (sent as typed, without the chat's wrapping), or None."""
    t = text.strip()
    if not t.startswith("/") or len(t) < 2 or t[1].isspace():
        return None
    if harness == "claude-code":
        return t
    if harness == "codex":
        return "$" + t[1:]
    return None
