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
from .commands import TERMINAL_ONLY

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
_CMD = re.compile(r"<command-name>\s*(/?[^<\s]+)\s*</command-name>")
_ARGS = re.compile(r"<command-args>(.*?)</command-args>", re.S)
_HUMAN = re.compile(r"<message\b[^>]*\bfrom=\"human\"[^>]*>(.*?)</message>", re.S)


def _user_text(text: str) -> str | bool:
    """A prompt as the person typed it; False for one to leave out (CLI echoes), True for one a harness sent on its
    own (notifications, other agents' messages), whose reply is left out but whose work is kept."""
    text = _REMINDER.sub("", text).strip()
    if m := _CMD.search(text):
        # A slash command the person ran, as Claude Code records it: show it as they typed it.
        name = "/" + m.group(1).lstrip("/")
        if name[1:] in TERMINAL_ONLY:
            return False  # terminal housekeeping like /clear, not a question
        args = a.group(1).strip() if (a := _ARGS.search(text)) else ""
        return f"{name} {args}".strip()
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

    def ask(self, text: str | bool, uuid: str | None = None) -> None:
        if text is False:
            return
        self.muted = text is True
        if isinstance(text, str):
            self.turns.append({**_turn(text), **({"uuid": uuid} if uuid else {})})

    @property
    def cur(self) -> dict | None:
        return self.turns[-1] if self.turns else None

    def say(self, text: str) -> None:
        # What the agent did for a harness's own message stays with the person's last turn; only its words to
        # the harness are left out.
        if (t := self.cur) is not None and text.strip() and not self.muted:
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


def _active_branch(entries: list[dict]) -> list[dict]:
    """The conversation as it now stands. Rewinding in Claude Code (editing an earlier message) branches the
    transcript: the abandoned messages stay in the file. Follow the links back from the latest message (across
    compactions) and keep only what's on that path."""
    by_id = {e["uuid"]: e for e in entries if e.get("uuid")}
    leaf = next((e for e in reversed(entries) if e.get("uuid") and not e.get("isSidechain")), None)
    on: set[str] = set()
    while leaf is not None and leaf["uuid"] not in on:
        on.add(leaf["uuid"])
        leaf = by_id.get(leaf.get("parentUuid") or leaf.get("logicalParentUuid") or "")
    return [e for e in entries if not e.get("uuid") or e["uuid"] in on]


def read_claude(path: Path) -> list[dict]:
    b = _Builder()
    for e in _active_branch(list(_lines(path))):
        if e.get("isSidechain") or e.get("isMeta") or e.get("isCompactSummary"):
            continue
        msg = e.get("message") or {}
        content = msg.get("content")
        if e.get("type") == "user":
            if isinstance(content, str):
                b.ask(_user_text(content), e.get("uuid"))
                continue
            texts = []
            for c in content or []:
                if c.get("type") == "tool_result" and c.get("is_error"):
                    b.failed(c.get("tool_use_id", ""))
                elif c.get("type") == "text":
                    texts.append(c.get("text", ""))
            if texts:
                b.ask(_user_text("\n".join(texts)), e.get("uuid"))
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


def rewind_point(path: Path, uuid: str) -> str | None:
    """Where to resume a Claude Code session to edit its message ``uuid``: the entry just before it."""
    for e in _lines(path):
        if e.get("uuid") == uuid:
            return e.get("parentUuid") or e.get("logicalParentUuid")
    return None


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
    transcript doesn't have yet (one still streaming) go last; ones it no longer has (rewound away) are dropped."""
    if session is None:
        return stored
    rest = list(enumerate(stored))
    last = -1  # the latest stored turn the transcript has
    out: list[dict] = []
    for t in session:
        text = t["questions"][0]["text"]
        if not asked_here(text):
            out.append(t)
            continue
        # Messages steered into a turn reach the transcript as prompts of their own: the turn they joined has them.
        i = next(
            (
                i
                for i, (_, s) in enumerate(rest)
                if (s.get("uuid") == t.get("uuid") if s.get("uuid") and t.get("uuid") else True)
                and all(q["text"].strip() in text for q in s["questions"] if not q.get("steered"))
            ),
            None,
        )
        if i is not None:
            # Diffusion's record, with the transcript's account of what the agent did (it marks failed calls),
            # unless something was steered into it: the transcript splits that turn, so keep the record's own.
            at, mine = rest.pop(i)
            last = max(last, at)
            mine = {**mine, "uuid": t.get("uuid") or mine.get("uuid")}
            out.append({**mine, "trace": t["trace"]} if t["trace"] and not mine.get("steers") else mine)
    return out + [s for at, s in rest if at > last and not s.get("uuid")]
