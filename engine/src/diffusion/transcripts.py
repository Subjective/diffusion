"""Read an agent session's own transcript as chat turns, so the guide-session chat shows the whole conversation:
what was said in the terminal before the guide was written, and anything said there since.

Claude Code keeps ``~/.claude/projects/<dir>/<session>.jsonl``; Codex keeps
``~/.codex/sessions/YYYY/MM/DD/rollout-…-<session>.jsonl``. Both are read-only here. Cursor keeps no readable
transcript, so a Cursor guide session has only the turns asked in Diffusion.
"""

from __future__ import annotations

import html
import json
import os
import re
from pathlib import Path

from .agent import summarize_tool

_REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
# Text the CLI injects as a "user" message: slash-command echoes, local command output, interrupts, context.
_INJECTED = ("<command-", "<local-command-", "Caveat:", "[Request interrupted", "<environment_context>",
             "<user_instructions>", "# AGENTS.md", "<turn_aborted>")  # fmt: skip


def find_transcript(harness: str, session: str, home: Path | None = None) -> Path | None:
    if not session or "/" in session or session.startswith("."):
        return None
    home = home or Path.home()
    if harness == "claude-code":
        root = Path(os.environ.get("CLAUDE_CONFIG_DIR") or home / ".claude") / "projects"
        return next(iter(sorted(root.glob(f"*/{session}.jsonl"))), None)
    if harness == "codex":
        root = Path(os.environ.get("CODEX_HOME") or home / ".codex") / "sessions"
        return next(iter(sorted(root.glob(f"**/rollout-*{session}.jsonl"))), None)
    return None


def _turn(text: str) -> dict:
    return {"questions": [{"n": 0, "text": text, "anchor": None}], "answers": {"0": ""}, "tools": [],
            "trace": [], "shows": [], "status": "done", "source": "session"}  # fmt: skip


_TAG = re.compile(r"^<([A-Za-z][\w-]*)[\s>]")
_HUMAN = re.compile(r"<message\b[^>]*\bfrom=\"human\"[^>]*>(.*?)</message>", re.S)


def _user_text(text: str) -> str | bool:
    """A prompt as the person typed it; False for one to leave out (CLI echoes), True for one a harness sent on its
    own (notifications, other agents' messages), whose answer is left out with it."""
    text = _REMINDER.sub("", text).strip()
    if not text or text.startswith(_INJECTED):
        return False
    if _TAG.match(text):
        # A harness envelope: keep the person's own words from it, if there are any.
        said = [html.unescape(m.strip()) for m in _HUMAN.findall(text)]
        return "\n\n".join(m for m in said if m) or True
    return text


def _lines(path: Path):
    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                yield json.loads(line)
            except ValueError:
                continue


class _Builder:
    def __init__(self) -> None:
        self.turns: list[dict] = []
        self.muted = False

    def ask(self, text: str | bool) -> None:
        if text is False:
            return
        self.muted = text is True
        if isinstance(text, str):
            self.turns.append(_turn(text))

    @property
    def cur(self) -> dict | None:
        return self.turns[-1] if self.turns and not self.muted else None

    def say(self, text: str) -> None:
        if (t := self.cur) is not None and text.strip():
            a = t["answers"]["0"]
            t["answers"]["0"] = f"{a}\n\n{text.strip()}" if a else text.strip()

    def think(self, text: str) -> None:
        if (t := self.cur) is not None and text.strip():
            tr = t["trace"]
            if tr and "think" in tr[-1]:
                tr[-1]["think"] += "\n\n" + text.strip()
            else:
                tr.append({"think": text.strip()})

    def tool(self, summary: str, id: str | None) -> None:
        if (t := self.cur) is not None:
            t["tools"].append(summary)
            t["trace"].append({"tool": summary, **({"id": id} if id else {})})

    def failed(self, id: str) -> None:
        for t in reversed(self.turns[-2:]):
            for item in t["trace"]:
                if item.get("id") == id:
                    item["failed"] = True
                    return


def read_claude(path: Path) -> list[dict]:
    b = _Builder()
    for e in _lines(path):
        if e.get("isSidechain") or e.get("isMeta") or e.get("isCompactSummary"):
            continue
        msg = e.get("message") or {}
        content = msg.get("content")
        if e.get("type") == "user":
            if isinstance(content, str):
                b.ask(_user_text(content))
                continue
            texts = []
            for c in content or []:
                if c.get("type") == "tool_result" and c.get("is_error"):
                    b.failed(c.get("tool_use_id", ""))
                elif c.get("type") == "text":
                    texts.append(c.get("text", ""))
            if texts:
                b.ask(_user_text("\n".join(texts)))
        elif e.get("type") == "assistant":
            for c in content if isinstance(content, list) else []:
                kind = c.get("type")
                if kind == "text":
                    b.say(c.get("text", ""))
                elif kind == "thinking":
                    b.think(c.get("thinking", ""))
                elif kind == "tool_use":
                    b.tool(summarize_tool(c.get("name", "tool"), c.get("input") or {}), c.get("id"))
    return b.turns


def read_codex(path: Path) -> list[dict]:
    b = _Builder()
    for e in _lines(path):
        if e.get("type") != "response_item":
            continue
        p = e.get("payload") or {}
        kind = p.get("type")
        if kind == "message":
            text = "\n".join(c.get("text", "") for c in p.get("content") or [] if isinstance(c, dict))
            if p.get("role") == "user":
                b.ask(_user_text(text))
            elif p.get("role") == "assistant":
                b.say(text)
        elif kind == "reasoning":
            for s in p.get("summary") or []:
                b.think(s.get("text", ""))
        elif kind in ("function_call", "custom_tool_call", "local_shell_call"):
            args = p.get("arguments") or p.get("input") or p.get("action") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    args = {}
            if isinstance(args, dict) and isinstance(args.get("command"), list):
                args = {**args, "command": " ".join(args["command"])}
            name = (
                "Bash"
                if kind == "local_shell_call" or p.get("name") in ("shell", "exec_command")
                else p.get("name")
            )
            b.tool(summarize_tool(name or "tool", args if isinstance(args, dict) else {}), p.get("call_id"))
    return b.turns


def session_turns(harness: str, session: str, home: Path | None = None) -> list[dict] | None:
    """The session's conversation as chat turns, or None when its transcript can't be found."""
    path = find_transcript(harness, session, home)
    if not path:
        return None
    try:
        return read_claude(path) if harness == "claude-code" else read_codex(path)
    except OSError:
        return None


def merge(session: list[dict] | None, stored: list[dict], asked_here) -> list[dict]:
    """The transcript's turns, with each one Diffusion asked replaced by its own record (anchors, shown code, guide
    versions). ``asked_here(text)`` says whether a transcript prompt came from Diffusion. Stored turns the
    transcript doesn't have yet (one still streaming) go last."""
    if session is None:
        return stored
    rest = list(stored)
    out: list[dict] = []
    for t in session:
        text = t["questions"][0]["text"]
        if not asked_here(text):
            out.append(t)
            continue
        i = next(
            (i for i, s in enumerate(rest) if all(q["text"].strip() in text for q in s["questions"])), None
        )
        if i is not None:
            # Diffusion's record, with the transcript's account of what the agent did (it marks failed calls).
            mine = rest.pop(i)
            out.append({**mine, "trace": t["trace"]} if t["trace"] else mine)
    return out + rest
