import random

import pytest

from diffusion.agent import DoneEvent, TextEvent, ToolEvent
from diffusion.chat_agent import (
    Anchor,
    ChatDelta,
    ChatFocus,
    GuideBlock,
    Question,
    SectionSplitter,
    format_turn,
    run_turn,
    seed_context,
    show_code_tool,
)
from diffusion.github import PRMeta, PRRef
from diffusion.hunks import parse_diff
from diffusion.pipeline import Prepared

ANSWER = (
    "### Q1\nThe delay is **clamped** at 0.\nSee `session.ts:14`.\n\n"
    "### Q2\nYes, `end()` clears it.\n## Not a marker\nQ2 is fine\n"
    "### Q3\n- one\n- two"
)
EXPECTED = {
    1: "The delay is **clamped** at 0.\nSee `session.ts:14`.\n\n",
    2: "Yes, `end()` clears it.\n## Not a marker\nQ2 is fine\n",
    3: "- one\n- two",
}


def split_all(chunks, ns=(1, 2, 3)):
    s = SectionSplitter(list(ns))
    got: dict[int, str] = {}
    for c in chunks:
        for n, t in s.feed(c):
            got[n] = got.get(n, "") + t
    for n, t in s.flush():
        got[n] = got.get(n, "") + t
    return got


def test_splitter_whole():
    assert split_all([ANSWER]) == EXPECTED


@pytest.mark.parametrize("seed", range(40))
def test_splitter_random_chunking(seed):
    rnd = random.Random(seed)
    chunks, i = [], 0
    while i < len(ANSWER):
        k = rnd.randint(1, 7)
        chunks.append(ANSWER[i : i + k])
        i += k
    assert split_all(chunks) == EXPECTED


def test_splitter_preamble_goes_to_first_and_unknown_marker_is_text():
    got = split_all(["Sure.\n### Q9\nx\n### Q2\ny"], ns=(1, 2))
    assert got == {1: "Sure.\n### Q9\nx\n", 2: "y"}


def test_splitter_streams_partial_lines_promptly():
    s = SectionSplitter([1])
    assert s.feed("Hello wor") == [(1, "Hello wor")]
    assert s.feed("ld") == [(1, "ld")]
    assert s.feed("\n##") == [(1, "\n")]  # '##' held: could be a marker
    assert s.feed("# Q1 again") == []  # still could be a marker line
    assert s.feed("\nok") == [(1, "ok")]


def test_splitter_single_question_no_markers():
    assert split_all(["just an ", "answer"], ns=(4,)) == {4: "just an answer"}


@pytest.fixture
def prep(upstream, checkout):
    meta = PRMeta(PRRef("github.com", "acme", "web", 7), "Add refresh", "Body here", "jy", "main", "feature",
                  upstream.base_sha, upstream.head_sha, 1, 1, 1)  # fmt: skip
    return Prepared(meta, checkout, parse_diff(checkout.diff()))


def test_seed_context_includes_table_and_guide(prep):
    s = seed_context(prep, {"tldr": "TLDR!", "steps": [], "meta": {"cost_usd": 1}})
    assert "Add refresh" in s and "Body here" in s and prep.index.table() in s
    assert "TLDR!" in s and "cost_usd" not in s


def test_format_turn_single_and_multi(prep):
    a = Anchor(file="src/auth/types.ts", start=4, end=4, code="  expiresAt: number;")
    single = format_turn([Question(n=1, text="Why?", anchor=a)], prep.index)
    assert (
        "`src/auth/types.ts:4` (new side, hunk H" in single and "expiresAt" in single and "Q1" not in single
    )
    multi = format_turn([Question(n=1, text="Why?", anchor=a), Question(n=2, text="Overall OK?")], prep.index)
    assert multi.index("## Q1") < multi.index("## Q2")
    assert "each under its own `### Q<n>` heading" in multi


async def test_run_turn_routes_sections_and_tools(prep):
    seen = {}

    async def runner(req):
        seen["req"] = req
        yield TextEvent("Let me check.")
        yield ToolEvent("Grep", "Grep refreshTokens")
        for c in [ANSWER[:20], ANSWER[20:]]:
            yield TextEvent(c)
        yield DoneEvent(2, 0.01, False, "sess-9")

    qs = [Question(n=1, text="a"), Question(n=2, text="b"), Question(n=3, text="c")]
    evs = [e async for e in run_turn(prep, None, qs, runner, "m", resume="sess-1")]
    text: dict[int, str] = {}
    for e in evs:
        if isinstance(e, ChatDelta):
            text[e.n] = text.get(e.n, "") + e.text
    assert text[1] == "Let me check.\n\n" + EXPECTED[1]
    assert text[2] == EXPECTED[2] and text[3] == EXPECTED[3]
    assert any(isinstance(e, ToolEvent) for e in evs) and isinstance(evs[-1], DoneEvent)
    req = seen["req"]
    assert (
        req.resume == "sess-1"
        and req.include_partial
        and [t.name for t in req.tools] == ["get_hunk", "show_code"]
    )
    assert prep.index.table() in req.system_prompt


async def test_show_code_validates_against_diff(prep):
    shown: list[dict] = []
    tool = show_code_tool(prep.index, shown)
    ok = await tool.handler({"file": "session.ts", "start": 3, "end": 40, "label": "refresh timer"})
    assert ok == "shown src/auth/session.ts:3–25"  # short path resolved, end clamped to the hunk
    assert shown == [
        {
            "file": "src/auth/session.ts",
            "start": 3,
            "end": 25,
            "side": "new",
            "label": "refresh timer",
            "q": None,
        }
    ]
    assert (await tool.handler({"file": "README.md", "start": 1})).startswith(
        "rejected: file is not in the diff"
    )
    assert "outside the diff" in await tool.handler({"file": "src/auth/types.ts", "start": 50})
    assert (await tool.handler({"file": "src/legacy.ts", "start": 1, "side": "old"})).startswith("shown")
    assert "line numbers" in await tool.handler({"file": "src/auth/types.ts", "start": "x"})
    assert len(shown) == 2
    f = prep.index.resolve("./src/auth/types.ts")
    assert f and f.path == "src/auth/types.ts"
    assert prep.index.resolve(".auth/types.ts") is None  # a leading dot is part of the name
    assert set(tool.schema["properties"]) == {"file", "start", "end", "side", "label", "q"}


async def test_run_turn_attaches_focus_to_current_question(prep):
    async def runner(req):
        show = next(t for t in req.tools if t.name == "show_code")
        yield TextEvent("### Q1\nSee below.\n### Q2\n")
        yield ToolEvent("show_code", "Show client.ts:2")
        await show.handler({"file": "src/api/client.ts", "start": 2, "end": 4})
        yield TextEvent("It's in `client.ts:2–4`.")
        yield DoneEvent(1, 0.0, False, "s")

    qs = [Question(n=1, text="a"), Question(n=2, text="where?")]
    evs = [e async for e in run_turn(prep, None, qs, runner, "m", None)]
    focus = [e for e in evs if isinstance(e, ChatFocus)]
    assert focus == [ChatFocus(2, "src/api/client.ts", 2, 4, "new")]
    assert evs.index(focus[0]) < len(evs) - 1 and isinstance(evs[-1], DoneEvent)


async def test_run_turn_focus_prefers_named_question(prep):
    async def runner(req):
        show = next(t for t in req.tools if t.name == "show_code")
        await show.handler({"file": "src/api/client.ts", "start": 2, "q": 2})  # before any marker
        await show.handler(
            {"file": "src/api/client.ts", "start": 3, "q": 9}
        )  # unknown: falls back to current
        yield TextEvent("### Q1\nx\n### Q2\ny")
        yield DoneEvent(1, 0.0, False, "s")

    qs = [Question(n=1, text="a"), Question(n=2, text="where?")]
    focus = [
        e for e in [e async for e in run_turn(prep, None, qs, runner, "m", None)] if isinstance(e, ChatFocus)
    ]
    assert [(f.n, f.start) for f in focus] == [(2, 2), (1, 3)]


def test_guide_block_is_held_back_and_kept():
    b = GuideBlock()
    text = "Done.\n``" + "`diffusion-guide\n" + '{"a":' + " 1}\n``" + "`\nAnything else?"
    out = "".join(b.feed(text[i : i + 3]) for i in range(0, len(text), 3)) + b.flush()
    assert out == "Done.\nAnything else?" and b.found == '{"a": 1}\n'
    # other fences pass through, and an unclosed block still counts
    b = GuideBlock()
    out = b.feed("```ts\nx\n```\n```diffusion-guide\n{}\n") + b.flush()
    assert out == "```ts\nx\n```\n" and b.found == "{}\n"


@pytest.mark.live
async def test_live_chat_multi(prep):
    from diffusion.agent import make_runner
    from diffusion.config import load_config

    cfg = load_config()
    qs = [
        Question(n=1, text="What new field does TokenPair get?",
                 anchor=Anchor(file="src/auth/types.ts", start=4, end=4, code="  expiresAt: number;")),
        Question(n=2, text="Which file defines refreshTokens? Answer with just the path."),
    ]  # fmt: skip
    text: dict[int, str] = {}
    done = None
    async for e in run_turn(
        prep,
        None,
        qs,
        make_runner("claude-code", cfg.cli_path("claude-code")),
        cfg.chat_model("claude-code"),
        None,
    ):
        if isinstance(e, ChatDelta):
            text[e.n] = text.get(e.n, "") + e.text
        elif isinstance(e, DoneEvent):
            done = e
    assert done and not done.is_error and done.session_id
    assert "expiresAt" in text.get(1, "")
    assert "client.ts" in text.get(2, "")
    assert "### Q" not in "".join(text.values())
