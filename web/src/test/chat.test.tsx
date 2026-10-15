import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { payload } from "./fixture";

vi.mock("../lib/highlight", () => ({ langFor: () => null, highlightHunk: async () => new Map() }));
vi.mock("../api", () => ({ fetchPR: vi.fn(async () => payload), streamGuide: vi.fn() }));

// Minimal fake engine for /api/chats*
type Turn = {
  questions: { n: number; text: string; anchor: unknown }[];
  answers: Record<string, string>;
  tools: string[];
  status: string;
};
const chats = new Map<string, { id: string; turns: Turn[]; updated_at: number }>();
let release: (() => void) | null = null;
const turnBodies: { questions: { n: number; text: string }[] }[] = [];
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

globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://x");
  const path = url.pathname;
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
  if (m && m[2]) {
    const body = JSON.parse(String(init!.body));
    turnBodies.push(body);
    const chat = chats.get(m[1])!;
    const answers = Object.fromEntries(body.questions.map((q: { n: number }) => [String(q.n), `answer ${q.n}`]));
    chat.turns.push({ questions: body.questions, answers, tools: ["Grep x"], status: "done" });
    const gate = new Promise<void>((r) => (release = r));
    const deltas = body.questions.map((q: { n: number }) => sse([["delta", { n: q.n, text: `answer ${q.n}` }]]));
    return new Response(
      streamBody([sse([["tool", { name: "Grep", summary: "Grep x" }]]), ...deltas, sse([["done", {}]])], gate),
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
  }
  return new Response("{}", { status: 404 });
}) as never;

const { App } = await import("../App");
const { useApp } = await import("../store");

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

test("composer sends immediately; answer streams; tool chips show while pending", async () => {
  await mount();
  expect(document.querySelector(".empty")).toBeTruthy();
  type("What does this do?");
  await waitFor(() => expect(document.querySelector(".tool-chip")?.textContent).toBe("Grep x"));
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

  // queue it (Shift+Enter)
  const input = document.querySelector<HTMLInputElement>(".ask-in input")!;
  fireEvent.change(input, { target: { value: "Why clear the timer?" } });
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  await waitFor(() => expect(document.querySelector(".tray")).toBeTruthy());
  expect(document.querySelectorAll(".q-row")).toHaveLength(1);
  expect(document.querySelector(".qb.s-staged")).toBeTruthy();
  expect(document.querySelector("tr.qd")).toBeTruthy();
  expect(document.querySelector(".send-n")!.textContent).toBe("1");

  // send all with an extra typed message
  type("anything else?");
  await waitFor(() => expect(document.querySelector(".tray")).toBeNull());
  expect(document.querySelectorAll(".ans-h").length).toBeGreaterThanOrEqual(2); // numbered -> headers
  await act(async () => release!());
  await waitFor(() => expect(document.querySelector(".qb.s-answered")).toBeTruthy());
});

test("questions asked mid-answer wait, then go out together as one turn", async () => {
  await mount();
  fireEvent.click(screen.getByTitle("New chat"));
  turnBodies.length = 0;
  type("first?");
  await waitFor(() => expect(document.querySelector(".cursor")).toBeTruthy());
  type("second?");
  type("third?");
  expect(turnBodies).toHaveLength(1); // nothing new sent while streaming
  expect(document.querySelectorAll(".msg.user.waiting .bubble")).toHaveLength(2);
  expect(document.querySelector(".wait-note")!.textContent).toBe("2");

  await act(async () => release!()); // first answer finishes → waiting batch sends
  await waitFor(() => expect(turnBodies).toHaveLength(2));
  expect(turnBodies[1].questions.map((q) => [q.n, q.text])).toEqual([
    [1, "second?"],
    [2, "third?"],
  ]);
  expect(document.querySelector(".msg.user.waiting")).toBeNull();
  await act(async () => release!());
  await waitFor(() =>
    expect([...document.querySelectorAll(".ans-t")].map((a) => a.textContent)).toEqual([
      "answer 0",
      "answer 1",
      "answer 2",
    ]),
  );
});
