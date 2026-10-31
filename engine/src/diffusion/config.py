"""Configuration: where Diffusion keeps its cache, and which agent CLI answers chat.

Guides are written by the agent you run Diffusion from (Claude Code, Codex or Cursor). Chat in the browser runs
on that same agent's CLI, picking up the session that wrote the guide where the agent can fork one. Nothing
needs configuring; a few environment variables override the defaults:

- ``DIFFUSION_CACHE_DIR``: checkouts, guides and chats (default ``~/.cache/diffusion``).
- ``DIFFUSION_CHAT_MODEL``: the model chat asks the agent CLI for (default: per agent, below).
- ``DIFFUSION_CLI``: the agent CLI to run, e.g. a wrapper script (default: the Claude Code bundled with the SDK,
  or ``codex`` / ``cursor-agent`` on ``PATH``).
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

Harness = Literal["claude-code", "codex", "cursor"]
HARNESSES: tuple[Harness, ...] = ("claude-code", "codex", "cursor")
CHAT_MODELS: dict[str, str] = {
    "claude-code": "sonnet",
    "codex": "",  # empty = the CLI's configured default model
    "cursor": "auto",  # the CLI's own default can be a model the user's plan excludes
}
CLI_NAMES = {"claude-code": "claude", "codex": "codex", "cursor": "cursor-agent"}
# The variable each agent sets, for the commands it runs, to the id its CLI resumes the session by.
SESSION_ENV = {
    "claude-code": "CLAUDE_CODE_SESSION_ID",
    "codex": "CODEX_THREAD_ID",
    "cursor": "CURSOR_CONVERSATION_ID",
}
# Agents whose CLI can branch a session, so chat builds on the guide's session without writing into it.
FORKABLE = ("claude-code", "codex")


@dataclass(frozen=True)
class Config:
    cache_dir: Path
    chat_model_override: str | None = None
    cli_override: str | None = None

    def chat_model(self, harness: str) -> str:
        return self.chat_model_override or CHAT_MODELS.get(harness, "")

    def cli_path(self, harness: str) -> str | None:
        """The CLI to run; None for Claude Code means the SDK's bundled one."""
        if self.cli_override:
            return shutil.which(self.cli_override) or self.cli_override
        if harness == "claude-code":
            return None
        return shutil.which(CLI_NAMES[harness]) or CLI_NAMES[harness]


def detect_harness(environ: dict[str, str]) -> Harness | None:
    """The agent this process runs under, from the variables each agent sets for its shell commands. Claude Code
    and Codex come first: either can run inside Cursor's terminal."""
    if environ.get("CLAUDECODE"):
        return "claude-code"
    if environ.get("CODEX_SANDBOX") or environ.get("CODEX_THREAD_ID") or environ.get("CODEX_CI"):
        return "codex"
    if environ.get("CURSOR_AGENT") or environ.get("CURSOR_TRACE_ID"):
        return "cursor"
    return None


def harness_session(harness: str | None, environ: dict[str, str]) -> str | None:
    """The session id the running agent's CLI can resume, if the agent exposes one."""
    return environ.get(SESSION_ENV[harness]) or None if harness in SESSION_ENV else None


def installed_harness(environ: dict[str, str]) -> Harness | None:
    """The first agent CLI on ``PATH``, for chat about a guide no agent session wrote."""
    return next((h for h in HARNESSES if shutil.which(CLI_NAMES[h], path=environ.get("PATH"))), None)


def load_config(environ: dict[str, str] | None = None) -> Config:
    env = dict(os.environ if environ is None else environ)
    home = Path(env.get("HOME") or Path.home())
    return Config(
        cache_dir=Path(env.get("DIFFUSION_CACHE_DIR") or home / ".cache" / "diffusion"),
        chat_model_override=env.get("DIFFUSION_CHAT_MODEL") or None,
        cli_override=env.get("DIFFUSION_CLI") or None,
    )
