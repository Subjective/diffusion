import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { payload } from "./fixture";

vi.mock("../lib/highlight", () => ({
  langFor: () => null,
  highlightHunk: async () => new Map(),
  highlightLines: async () => [],
}));
vi.mock("../api", () => ({ fetchPR: vi.fn(async () => payload), fetchVersions: vi.fn(), fetchGuide: vi.fn() }));

// Minimal fake engine for /api/chats*
type Turn = {
  questions: { n: number; text: string; anchor: unknown }[];
  answers: Record<string, string>;
  tools: string[];
  shows?: unknown[];
  status: string;
};
const chats = new Map<string, { id: string; turns: Turn[]; updated_at: number }>();
let release: (() => void) | null = null;
const turnBodies: { questions: { n: number; text: string }[]; version?: number | null; mode?: string }[] = [];
const sse = (events: [string, unknown][]) =>
  events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

function streamBody(chunks: string[], gate?: Promise<void>) {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(c) {
      c.enqueue(enc.encode(chunks[0]));
      if (gate) await gate;
      for (const ch of chunks.slice(1)) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

const approveBodies: unknown[] = [];
globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://x");
  const path = url.pathname;
  if (path.endsWith("/approve")) {
    approveBodies.push(JSON.parse(String(init!.body)));
    return new Response("{}");
  }
  if (path === "/api/chats" && init?.method === "POST") {
    const id = `c${chats.size + 1}`;
    chats.set(id, { id, turns: [], updated_at: Date.now() / 1000 });
    return new Response(JSON.stringify({ id }), { status: 200 });
  }
  if (path === "/api/chats") {
    const list = [...chats.values()]
      .filter((c) => c.turns.length)
      .map((c) => ({
        id: c.id,
        title: c.turns[0].questions[0].text,
        questions: c.turns.reduce((n, t) => n + t.questions.length, 0),
        anchored: 0,
        updated_at: c.updated_at,
      }));
    return new Response(JSON.stringify(list));
  }
  const m = path.match(/^\/api\/chats\/(\w+)(\/turn)?$/);
  if (m && !m[2]) return new Response(JSON.stringify(chats.get(m[1])));
  if (m?.[2]) {
    const body = JSON.parse(String(init!.body));
    turnBodies.push(body);
    const chat = chats.get(m[1])!;
    // "where…" questions: answer with citations and a show_code focus, like the real engine
    const where = (q: { text: string }) => q.text.startsWith("where");
    const text = (q: { n: number; text: string }) =>
      where(q) ? "In `session.ts:6–7`, not `README.md:1`." : `answer ${q.n}`;
    const shows = body.questions.filter(where).map((q: { n: number }) => ({
      n: q.n,
      file: "src/auth/session.ts",
      start: 6,
      end: 7,
      side: "new",
      label: "end() clears timer",
    }));
    const answers = Object.fromEntries(body.questions.map((q: { n: number; text: string }) => [String(q.n), text(q)]));
    chat.turns.push({ questions: body.questions, answers, tools: ["Grep x"], shows, status: "done" });
    const gate = new Promise<void>((r) => (release = r));
    const deltas = body.questions.map((q: { n: number; text: string }) => sse([["delta", { n: q.n, text: text(q) }]]));
    deltas.push(...shows.map((f: unknown) => sse([["focus", f]])));
    // "change…" questions: the answer saved a new guide version
    const edit = body.questions.find((q: { text: string }) => q.text.startsWith("change"));
    if (edit) deltas.push(sse([["guide", { n: edit.n, version: 2 }]]));
    // "think…" questions: the agent reasons first, and the turn reports how long it took
    const think = body.questions.some((q: { text: string }) => q.text.startsWith("think"));
    if (think) deltas.unshift(sse([["thinking", { text: "Check **who** calls it." }]]));
    // "risky…" questions: the session asks before a command its settings don't allow (before the answer lands)
    const risky = body.questions.some((q: { text: string }) => q.text.startsWith("risky"));
    const asking = risky
      ? sse([["approval", { id: "a1", tool: "Bash", summary: "Ran rm -rf build", input: { command: "rm -rf build" } }]])
      : "";
    // "fail…" questions: the tool call comes back as an error
    if (body.questions.some((q: { text: string }) => q.text.startsWith("fail")))
      deltas.unshift(sse([["tool_failed", { id: "t1" }]]));
    return new Response(
      streamBody(
        [
          sse([["tool", { name: "Grep", summary: "Grep x", id: "t1" }]]) + asking,
          ...deltas,
          sse([["done", think ? { seconds: 12 } : {}]]),
        ],
        gate,
      ),
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
  }
  return new Response("{}", { status: 404 });
}) as never;

const { App } = await import("../App");
const { useApp } = await import("../store");
const api = await import("../api");

async function mount() {
  useApp.setState({ url: payload.pr.url, chatOpen: true });
  render(<App />);
  await waitFor(() => expect(screen.getByText("Add token refresh")).toBeTruthy());
}

const type = (text: string) => {
  const ta = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
  fireEvent.change(ta, { target: { value: text } });
  fireEvent.keyDown(ta, { key: "Enter" });
};

test("composer sends immediately; answer streams; the latest step shows while pending", async () => {
  await mount();
  expect(document.querySelector(".empty")).toBeTruthy();
  type("What does this do?");
  await waitFor(() => expect(document.querySelector(".trace-h")?.textContent).toBe("Grep x"));
  expect(document.querySelector(".bubble")!.textContent).toBe("What does this do?");
  expect(document.querySelector(".cursor")).toBeTruthy();
  await act(async () => release!());
  await waitFor(() => expect(document.querySelector(".ans-t")!.textContent).toBe("answer 0"));
  expect(document.querySelector(".cursor")).toBeNull();
  expect(document.querySelector(".ans-h")).toBeNull(); // single unnumbered: no header
});

test("new chat starts fresh; history lists and restores past chats", async () => {
  await mount();
  await waitFor(() => expect(document.querySelectorAll(".msg.user").length).toBeGreaterThan(0)); // state persisted from previous test
  fireEvent.click(screen.getByTitle("New chat"));
  expect(document.querySelector(".empty")).toBeTruthy();
  fireEvent.click(screen.getByTitle("History"));
  await waitFor(() => expect(document.querySelectorAll(".h-item")).toHaveLength(1));
  expect(document.querySelector(".h-t")!.textContent).toBe("What does this do?");
  fireEvent.click(document.querySelector(".h-item")!);
  await waitFor(() => expect(document.querySelector(".ans-t")!.textContent).toBe("answer 0"));
  expect(document.querySelector(".hist")).toBeNull();
});

test("suggestion chip asks", async () => {
  await mount();
  fireEvent.click(screen.getByTitle("New chat"));
  fireEvent.click(screen.getByText("Risks"));
  await waitFor(() => expect(document.querySelector(".bubble")!.textContent).toBe("What are the risks in this PR?"));
  await act(async () => release!());
});

test("both side panes resize within clamps that keep the diff ≥ 420px; double-click resets", async () => {
  Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true });
  localStorage.removeItem("rv-chat-w");
  localStorage.removeItem("rv-guide-w");
  await mount();
  const app = document.getElementById("app")!;
  const w = (k: string) => app.style.getPropertyValue(k);
  const drag = (h: Element, x: number) => {
    fireEvent.mouseDown(h, { button: 0, clientX: x });
    fireEvent.mouseMove(window, { clientX: x });
    fireEvent.mouseUp(window);
  };
  const chatH = document.querySelector(".chat .resizer")!;
  const guideH = document.querySelector(".guide-wrap .resizer")!;

  drag(chatH, 1000);
  expect(w("--chat-w")).toBe("600px");
  drag(chatH, 1500);
  expect(w("--chat-w")).toBe("300px"); // min
  drag(guideH, 500);
  expect(w("--guide-w")).toBe("500px");
  drag(guideH, 100);
  expect(w("--guide-w")).toBe("260px"); // min
  drag(guideH, 1500);
  expect(w("--guide-w")).toBe(`${1600 - 300 - 420}px`); // max given chat width
  drag(chatH, 0);
  expect(w("--chat-w")).toBe(`${1600 - (1600 - 300 - 420) - 420}px`); // chat can't squeeze the diff either
  fireEvent.doubleClick(guideH);
  fireEvent.doubleClick(chatH);
  expect([w("--guide-w"), w("--chat-w")]).toEqual(["360px", "380px"]);
  expect(JSON.parse(localStorage.getItem("rv-guide-w")!)).toBe(360);
});

test("drag bubble across lines → popup → queue two → badges → send → linked answers", async () => {
  await mount();
  fireEvent.click(screen.getByTitle("New chat"));
  const rows = [...document.querySelectorAll<HTMLElement>('tr.ln[data-file="src/auth/session.ts"]')];
  const pointAt = rows[6];
  Object.defineProperty(document, "elementFromPoint", { value: () => pointAt, configurable: true });

  // drag from row 4 to row 6
  fireEvent.mouseDown(rows[4].querySelector(".ask-btn")!, { button: 0, clientX: 300, clientY: 100 });
  fireEvent.mouseMove(window, { clientX: 300, clientY: 160 });
  expect(document.querySelectorAll("tr.sel").length).toBeGreaterThanOrEqual(3);
  expect(document.querySelector(".drag-tip")).toBeTruthy();
  fireEvent.mouseUp(window, { clientX: 300, clientY: 160 });
  await waitFor(() => expect(document.querySelector(".ask-pop")).toBeTruthy());

  // queue it (Enter; ⌘Enter would ask now)
  const input = document.querySelector<HTMLTextAreaElement>(".ask-in textarea")!;
  fireEvent.change(input, { target: { value: "Why clear the timer?" } });
  fireEvent.keyDown(input, { key: "Enter" });
  // it attaches to the next message as a pill in the composer: its number and lines, the note on hover
  await waitFor(() => expect(document.querySelector(".composer .note")).toBeTruthy());
  const note = document.querySelector<HTMLElement>(".composer .note")!;
  expect(note.textContent).toBe("1session.ts:5–6");
  // the chat box takes focus, so ↵ sends it
  await waitFor(() => expect(document.activeElement).toBe(document.querySelector(".composer textarea")));
  // on the line, the same numbered badge
  expect(document.querySelector(".qb.s-staged")!.textContent).toBe("1");
  expect(document.querySelector("tr.qd")).toBeTruthy();

  // clicking it reopens the popup it was written in, to edit; ↵ saves in place
  fireEvent.click(document.querySelector<HTMLElement>(".composer .note")!);
  const edit = await waitFor(() => document.querySelector<HTMLTextAreaElement>(".ask-pop .ask-in textarea")!);
  expect(edit.value).toBe("Why clear the timer?");
  fireEvent.change(edit, { target: { value: "Why clear it here?" } });
  fireEvent.keyDown(edit, { key: "Enter" });
  await waitFor(() => expect(document.querySelector(".ask-pop")).toBeNull());
  const { useChat } = await import("../chat");
  expect(
    useChat
      .getState()
      .chat.questions.filter((q) => q.status === "staged")
      .map((q) => [q.n, q.text]),
  ).toEqual([[1, "Why clear it here?"]]);
  expect(document.querySelector(".composer .note")!.className).toBe("note");

  // send all with an extra typed message
  type("anything else?");
  await waitFor(() => expect(document.querySelector(".composer .note")).toBeNull());
  expect(document.querySelectorAll(".ans-h").length).toBeGreaterThanOrEqual(2); // numbered -> headers
  await act(async () => release!());
  await waitFor(() => expect(document.querySelector(".qb.s-answered")).toBeTruthy());
});

test("messages asked mid-answer queue, can be edited or removed, and go out one per turn", async () => {
  await mount();
  fireEvent.click(screen.getByTitle("New chat"));
  turnBodies.length = 0;
  type("first?");
  await waitFor(() => expect(document.querySelector(".cursor")).toBeTruthy());
  type("second?");
  type("third?");
  type("fourth?");
  expect(turnBodies).toHaveLength(1); // nothing new sent while streaming
  // queued above the composer, not in the thread
  const rows = () => [...document.querySelectorAll(".queue-row .qt")].map((q) => q.textContent);
  expect(rows()).toEqual(["second?", "third?", "fourth?"]);
  expect(document.querySelector(".queue-h")!.textContent).toBe("3 Queued");

  // edit one in the composer: the row says so, ✓ saves it back in place
  fireEvent.click(document.querySelectorAll<HTMLElement>(".queue-row")[1].querySelector('[title="Edit"]')!);
  const ta = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
  expect(ta.value).toBe("third?");
  expect(document.querySelector(".editing-chip")).toBeTruthy();
  expect(document.querySelector(".queue-row.editing .queue-tag")!.textContent).toBe("Editing");
  fireEvent.change(ta, { target: { value: "third, edited?" } });
  fireEvent.click(screen.getByTitle("Save"));
  expect(rows()).toEqual(["second?", "third, edited?", "fourth?"]);
  expect(document.querySelector(".editing-chip")).toBeNull();
  // remove one
  fireEvent.click(document.querySelectorAll<HTMLElement>(".queue-row")[2].querySelector('[title="Remove"]')!);
  expect(rows()).toEqual(["second?", "third, edited?"]);
  // collapse to a pill and back
  fireEvent.click(screen.getByTitle("Collapse"));
  expect(document.querySelector(".queue-pill")!.textContent).toBe("Queued 2");
  fireEvent.click(document.querySelector(".queue-pill")!);

  // with nothing typed, send becomes Stop
  fireEvent.click(screen.getByTitle("Stop"));
  const fetched = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
  expect(fetched.some((u) => /\/api\/chats\/[^/]+\/stop$/.test(u))).toBe(true);

  // each turn's end sends the next queued message, alone
  await act(async () => release!());
  await waitFor(() => expect(turnBodies).toHaveLength(2));
  expect(turnBodies[1].questions.map((q) => q.text)).toEqual(["second?"]);
  expect(rows()).toEqual(["third, edited?"]);
  await act(async () => release!());
  await waitFor(() => expect(turnBodies).toHaveLength(3));
  expect(turnBodies[2].questions.map((q) => q.text)).toEqual(["third, edited?"]);
  expect(document.querySelector(".queue")).toBeNull();
  await act(async () => release!());
  await waitFor(() => expect(document.querySelectorAll(".ans-t")).toHaveLength(3));
});

test("answers link citations to diff rows; show_code chips focus the diff, auto-jumping only if it wasn't touched", async () => {
  await mount();
  fireEvent.click(screen.getByTitle("New chat"));
  const row = (k: string) => document.querySelector<HTMLElement>(`tr[data-rk="${k}"]`)!;
  type("where is the timer cleared?");
  await waitFor(() => expect(document.querySelector(".cursor")).toBeTruthy());
  await act(async () => release!());
  await waitFor(() => expect(document.querySelector(".show-chip")).toBeTruthy());

  // auto-jump: the first show of the turn flashes its rows
  await waitFor(() => expect(row("src/auth/session.ts:7").className).toMatch(/flash/));
  expect(document.querySelector(".show-chip")!.textContent).toBe("end() clears timersession.ts:6–7");

  const cite = document.querySelector<HTMLElement>(".ans-t button.cite")!;
  expect(cite.textContent).toBe("session.ts:6–7");
  expect(cite.title).toBe("src/auth/session.ts · Show in diff");
  // not in the diff: opens in a tab
  const other = document.querySelector<HTMLElement>('.ans-t button.cite[title="README.md · Open in a tab"]')!;
  expect(other.textContent).toBe("README.md:1");
  fireEvent.mouseEnter(cite);
  expect(row("src/auth/session.ts:6").className).toMatch(/\bhl\b/);
  expect(row("src/auth/session.ts:5").className).not.toMatch(/\bhl\b/);
  fireEvent.mouseLeave(cite);
  expect(row("src/auth/session.ts:6").className).not.toMatch(/\bhl\b/);

  // after the reviewer scrolls the diff, a new answer's show_code doesn't move it
  fireEvent.click(screen.getByTitle("New chat"));
  const { useUI } = await import("../ui");
  const flashN = useUI.getState().flash.n;
  type("where again?");
  await waitFor(() => expect(document.querySelector(".cursor")).toBeTruthy());
  fireEvent.wheel(document.getElementById("diffPane")!);
  await act(async () => release!());
  await waitFor(() => expect(document.querySelector(".show-chip")).toBeTruthy());
  expect(useUI.getState().flash.n).toBe(flashN);
  fireEvent.click(document.querySelector(".show-chip")!); // the chip still works on demand
  expect(useUI.getState().flash.n).toBe(flashN + 1);
  expect(useUI.getState().scrollTo?.keys[0]).toBe("src/auth/session.ts:6");

  // shows persist with the chat
  fireEvent.click(screen.getByTitle("New chat"));
  fireEvent.click(screen.getByTitle("History"));
  await waitFor(() => expect(document.querySelectorAll(".h-item").length).toBeGreaterThan(1));
  fireEvent.click([...document.querySelectorAll(".h-item")].find((h) => h.textContent!.includes("where again?"))!);
  await waitFor(() => expect(document.querySelector(".show-chip .loc")!.textContent).toBe("session.ts:6–7"));
});

test("an answer that changes the guide switches to the new version and links to it", async () => {
  await mount();
  fireEvent.click(screen.getByTitle("New chat"));
  const v2 = { version: 2, label: "Edited in chat", scope: null, source: "chat" as const, created_at: 0 };
  vi.mocked(api.fetchVersions).mockResolvedValue({
    head_sha: payload.pr.head_sha,
    versions: [...payload.versions, v2],
  });
  vi.mocked(api.fetchGuide).mockResolvedValue({ ...payload.guide!, version: 2, tldr: "edited" });
  type("change step 2 to cover the timer");
  await waitFor(() => expect(document.querySelector(".trace-live")).toBeTruthy());
  await act(async () => release!());
  await waitFor(() => expect(document.querySelector(".tldr")!.textContent).toBe("edited"));
  expect(turnBodies.at(-1)!.version).toBe(1); // asked about the version on screen
  const link = document.querySelector<HTMLElement>(".guide-upd")!;
  expect(link.textContent).toBe("Updated the guidev2");
  expect(link.classList.contains("on")).toBe(true);
  expect(document.querySelector(".ver-btn")!.textContent).toBe("v2");
});

test("a turn's reasoning and tools fold into one line that opens to a timeline", async () => {
  await mount();
  fireEvent.click(screen.getByTitle("New chat"));
  type("think about the callers");
  await waitFor(() => expect(document.querySelector(".trace-live")).toBeTruthy());
  await act(async () => release!());
  await waitFor(() => expect(document.querySelector(".trace-h")?.textContent).toBe("Thought for 12s · 1 tool"));
  expect(document.querySelector(".trace-b")).toBeNull();
  fireEvent.click(document.querySelector(".trace-h")!);
  // a timeline, in the order things happened
  const items = [...document.querySelectorAll(".trace-b > li")];
  expect(items.map((li) => li.className)).toEqual(["trace-tool", "trace-think"]);
  expect(items[0].querySelector("code")!.textContent).toBe("x"); // a tool call: verb, then what it acted on
  expect(items[1].textContent).toBe("Check who calls it.");
});

test("a tool call that failed is marked in the timeline", async () => {
  await mount();
  fireEvent.click(screen.getByTitle("New chat"));
  type("fail at grepping");
  await waitFor(() => expect(document.querySelector(".trace-live")).toBeTruthy());
  await act(async () => release!());
  await waitFor(() => expect(document.querySelector(".trace-live")).toBeNull());
  fireEvent.click(document.querySelector(".trace-h")!);
  const row = document.querySelector(".trace-tool")!;
  expect(row.classList.contains("failed")).toBe(true);
  expect(row.querySelector(".fail")!.textContent).toBe("Failed");
});

test("reasoning headlines: first bold phrase, else first sentence", async () => {
  const { headline } = await import("../components/ChatPanel");
  expect(headline("**Finding callers**\n\nI'll grep.")).toBe("Finding callers");
  expect(headline("Check the timer. Then the API.")).toBe("Check the timer.");
});

test("chat opens on the guide's session; new chats fork it; history keeps the two apart", async () => {
  await mount();
  const g = useApp.getState().guide!;
  useApp.setState({ guide: { ...g, meta: { head_sha: "x", harness: "codex", session: "th_1" } } });
  const { useChat } = await import("../chat");
  await act(async () => useChat.getState().openGuide());
  expect(document.querySelector(".chat-title")!.textContent).toBe("Guide session");
  expect(document.querySelector('.chat-mark svg[aria-label="Codex"]')).toBeTruthy();
  const posts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
  type("keep going");
  await waitFor(() => expect(document.querySelector(".cursor")).toBeTruthy());
  const post = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    .slice(posts)
    .find(([u, i]) => String(u) === "/api/chats" && i?.method === "POST");
  expect(JSON.parse(String(post![1].body)).kind).toBe("guide");
  await act(async () => release!());

  fireEvent.click(screen.getByTitle("New chat"));
  expect(document.querySelector(".chat-title .kind")).toBeTruthy(); // a fork
  fireEvent.click(screen.getByTitle("History"));
  expect(document.querySelector(".chat-title")!.textContent).toBe("History");
  await waitFor(() => expect(document.querySelector(".h-item.guide .h-t")!.textContent).toBe("Guide session"));
  useApp.setState({ guide: g });
});

test("the guide session runs in the harness's permission modes and asks in the conversation; forks only read", async () => {
  await mount();
  const g = useApp.getState().guide!;
  useApp.setState({ guide: { ...g, meta: { head_sha: "x", harness: "claude-code", session: "s1" } } });
  const { useChat } = await import("../chat");
  await act(async () => useChat.getState().openGuide());
  const mode = () => document.querySelector<HTMLElement>(".composer button.mode")!;
  expect(mode().textContent).toBe("Manual");
  fireEvent.click(mode());
  const items = [...document.querySelectorAll(".mode-menu .mode-item")].map((i) => i.textContent);
  expect(items).toEqual(["Manual", "Accept edits", "Plan", "Auto"]);
  fireEvent.click(screen.getByText("Plan"));
  expect(mode().textContent).toBe("Plan");
  expect(document.querySelector(".mode-menu")).toBeNull();
  fireEvent.click(mode());
  fireEvent.click(screen.getByRole("menuitemradio", { name: /Manual/ }));
  type("risky cleanup");
  await waitFor(() => expect(document.querySelector(".thread .ask-card")).toBeTruthy());
  expect(turnBodies.at(-1)!.mode).toBe("default");
  expect(document.querySelector(".ask-d")!.textContent).toBe("rm -rf build");
  fireEvent.keyDown(window, { key: "Enter" }); // ↵ allows
  expect(document.querySelector(".ask-card")).toBeNull();
  await waitFor(() => expect(approveBodies).toEqual([{ id: "a1", decision: "allow" }]));
  await act(async () => release!());
  // a fork can only read
  fireEvent.click(screen.getByTitle("New chat"));
  expect(document.querySelector(".composer .mode")!.textContent).toBe("Read-only");
  expect(document.querySelector("button.mode")).toBeNull();
  useApp.setState({ guide: g });
});

test("an edit to approve shows its diff, and allowing edits for the session switches the mode", async () => {
  const { useChat } = await import("../chat");
  useChat.setState({
    mode: "default",
    asks: [
      {
        id: "e1",
        tool: "Edit",
        summary: "Edit",
        input: { file_path: "src/a.rs", old_string: "a\nb", new_string: "c" },
      },
    ],
  });
  const { AskCardForTest } = await import("../components/ChatPanel");
  const { render } = await import("@testing-library/react");
  const r = render(<AskCardForTest id="e1" />);
  expect(r.container.querySelector(".ask-h code")!.textContent).toBe("src/a.rs");
  expect([...r.container.querySelectorAll(".ask-diff span")].map((l) => l.className)).toEqual(["del", "del", "add"]);
  fireEvent.click(r.getByText("Allow edits this session"));
  expect(useChat.getState().mode).toBe("acceptEdits");
  r.unmount();

  // a plan reads as the plan; approving it leaves plan mode
  useChat.getState().setMode("plan");
  useChat.setState({
    asks: [{ id: "p1", tool: "ExitPlanMode", summary: "ExitPlanMode", input: { plan: "## Plan\n\n1. Do it" } }],
  });
  const p = render(<AskCardForTest id="p1" />);
  expect(p.container.querySelector(".ask-plan h2")!.textContent).toBe("Plan");
  fireEvent.click(p.getByText("Approve"));
  expect(useChat.getState().mode).toBe("default");
  p.unmount();
});

test("@ in the composer picks a file from the diff", async () => {
  await mount();
  const ta = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
  fireEvent.change(ta, { target: { value: "what about @sess", selectionStart: 16 } });
  await waitFor(() => expect(document.querySelector(".ta-menu")).toBeTruthy());
  expect(document.querySelector(".ta-item.on .ta-label")!.textContent).toBe("session.ts");
  fireEvent.keyDown(ta, { key: "Enter" });
  expect(ta.value).toBe("what about @src/auth/session.ts ");
  expect(document.querySelector(".ta-menu")).toBeNull();
  expect(turnBodies.at(-1)?.questions[0]?.text).not.toBe("what about @sess");
});
