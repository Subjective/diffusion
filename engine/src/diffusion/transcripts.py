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

from .agent import ran, summarize_tool
from .commands import TERMINAL_ONLY

_REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
# Text the CLI injects as a "user" message: slash-command echoes, local command output, interrupts, context.
_INJECTED = ("<command-", "<local-command-", "Caveat:", "[Request interrupted", "<environment_context>",
             "<user_instructions>", "# AGENTS.md", "<turn_aborted>", "<skill>")  # fmt: skip
"""Prompts a harness adds to the person's own (Codex puts a skill's instructions after the ``$skill`` that ran it):
left out, with the reply kept on the person's turn."""


def find_transcript(harness: str, session: str, home: Path | None = None) -> Path | None:
    if not session or "/" in session or session.startswith("."):
        return None
    home = home or Path.home()
    if harness == "claude-code":
        root = Path(os.environ.get("CLAUDE_CONFIG_DIR") or home / ".claude") / "projects"
        return next(iter(sorted(root.glob(f"*/{session}.jsonl"))), None)
    if harness == "codex":
        root = Path(os.environ.get("CODEX_HOME") or home / ".codex") / "sessions"
        return max(_rollouts(root, session), key=lambda p: p.name, default=None)
    return None


def _rollouts(root: Path, thread: str) -> list[Path]:
    """A Codex thread's rollout files: the first, and a segment for each time its history was reverted."""
    return [*root.glob(f"**/rollout-*{thread}.jsonl"), *root.glob(f"**/rollout-*{thread}_*.jsonl")]


def _codex_entries(path: Path, limit: int | None = None) -> list[dict]:
    """A rollout's entries, after the history it carries on from. A segment written by a revert keeps only a prefix
    of the file before it (``history_base``: up to a byte offset), and holds just what came after."""
    with path.open("rb") as f:
        data = f.read(limit) if limit is not None else f.read()
    out = []
    for line in data.decode("utf-8", errors="replace").splitlines():
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    meta = next((e.get("payload") or {} for e in out if e.get("type") == "session_meta"), {})
    base = meta.get("history_base") or {}
    if base.get("thread_id") and isinstance(base.get("end_byte_offset"), int):
        root = next((p for p in path.parents if p.name == "sessions"), path.parent)
        earlier = [p for p in _rollouts(root, base["thread_id"]) if p.name < path.name]
        if earlier:
            return _codex_entries(max(earlier, key=lambda p: p.name), base["end_byte_offset"]) + out
    return out


def _turn(text: str) -> dict:
    return {"questions": [{"n": 0, "text": text, "anchor": None}], "answers": {"0": ""}, "tools": [],
            "trace": [], "status": "done", "source": "session"}  # fmt: skip


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


_CITATIONS = re.compile(r"<oai-mem-citation>.*?(?:</oai-mem-citation>|\Z)", re.S)
"""Codex's notes of which memories an answer drew on, for its own app."""
_JS_STR = r'"(?:[^"\\\n]|\\.)*"|\'(?:[^\'\\\n]|\\.)*\'|`(?:[^`\\]|\\.)*`'
_JS_CMD = re.compile(rf"\bcmd\s*:\s*({_JS_STR})")
_JS_LIST = re.compile(rf"\bof\s*\[((?:\s*(?:{_JS_STR})\s*,?)+)\]")


def _js_string(lit: str) -> str:
    body = lit[1:-1]
    if lit[0] == '"':
        try:
            return json.loads(lit)
        except ValueError:
            return body
    return body.replace("\\" + lit[0], lit[0]).replace("\\n", "\n")


def exec_commands(script: str) -> list[str]:
    """The shell commands in a script Codex ran through its ``exec`` tool (newer Codex writes its shell work as a
    little JavaScript program calling ``tools.exec_command({cmd: …})``): each ``cmd`` given, or, where the commands
    come from a loop, the list it loops over."""
    cmds = [_js_string(m.group(1)) for m in _JS_CMD.finditer(script)]
    if not cmds:
        for m in _JS_LIST.finditer(script):
            cmds += [_js_string(x) for x in re.findall(_JS_STR, m.group(1))]
    return [c for c in cmds if c.strip()]


def read_codex(path: Path) -> list[dict]:
    b = _Builder()
    turn_id, given = None, set()  # the running turn; turns whose first message has its id (to revert to it)
    for e in _codex_entries(path):
        p = e.get("payload") or {}
        if e.get("type") == "turn_context" or (
            e.get("type") == "event_msg" and p.get("type") == "task_started"
        ):
            turn_id = p.get("turn_id") or turn_id
        if e.get("type") != "response_item":
            continue
        kind = p.get("type")
        if kind == "message":
            text = "\n".join(c.get("text", "") for c in p.get("content") or [] if isinstance(c, dict))
            if p.get("role") == "user":
                q = _user_text(text)
                tid = (p.get("internal_chat_message_metadata_passthrough") or {}).get("turn_id") or turn_id
                # A message steered into a running turn shares its id, and can't be reverted to on its own.
                uuid = tid if isinstance(q, str) and tid not in given else None
                if uuid:
                    given.add(uuid)
                b.ask(q, uuid)
            elif p.get("role") == "assistant":
                b.say(_CITATIONS.sub("", text))
        elif kind == "reasoning":
            for s in p.get("summary") or []:
                b.think(s.get("text", ""))
        elif kind == "custom_tool_call" and p.get("name") == "exec" and isinstance(p.get("input"), str):
            cmds = exec_commands(p["input"])
            if not cmds and "write_stdin" in p["input"]:
                continue  # polling a command that's still running: the command has its row
            for i, cmd in enumerate(cmds or [""]):
                b.tool(ran(cmd) if cmd else "Ran a script", p.get("call_id") if i == 0 else None)
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
    """The transcript's turns, with each one Diffusion asked replaced by its own record (anchors, guide versions).
    ``asked_here(text)`` says whether a transcript prompt came from Diffusion. Stored turns the transcript doesn't
    have yet (one still streaming) go last; ones it no longer has (rewound away) are dropped."""
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
