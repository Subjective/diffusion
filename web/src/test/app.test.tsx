import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { payload } from "./fixture";

vi.mock("../lib/highlight", () => ({
  langFor: () => null,
  highlightHunk: async () => new Map(),
  highlightLines: async () => [],
}));
vi.mock("../api", () => ({
  fetchPR: vi.fn(async () => payload),
  fetchVersions: vi.fn(async () => ({ head_sha: payload.pr.head_sha, versions: payload.versions })),
  fetchGuide: vi.fn(),
  fetchFile: vi.fn(async () => Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n")),
  fetchDefinition: vi.fn(),
}));
// jsdom has no caret-from-point; the clicked name comes from here
const nav = vi.hoisted(() => ({ word: "refreshTokens" }));
vi.mock("../lib/definition", async (orig) => ({
  ...(await orig<typeof import("../lib/definition")>()),
  wordAtPoint: () => nav.word,
}));

const { App } = await import("../App");
const api = await import("../api");
const { useApp } = await import("../store");
const { useUI } = await import("../ui");
const { useChat } = await import("../chat");

const rows = (sel: string) => [...document.querySelectorAll<HTMLTableRowElement>(`tr.ln${sel}`)];
const nums = (sel: string) =>
  rows(sel).map((r) => `${r.dataset.file!.split("/").pop()}:${r.dataset.new ?? `-${r.dataset.old}`}`);

beforeEach(() => localStorage.clear());

async function mount() {
  useApp.setState({ url: payload.pr.url });
  render(<App />);
  await waitFor(() => expect(screen.getByText("Add token refresh")).toBeTruthy());
}

test("renders guide, diff in guide order, skippable collapsed", async () => {
  await mount();
  const order = [...document.querySelectorAll<HTMLElement>(".file")].map((f) => f.dataset.path);
  expect(order).toEqual(["src/auth/types.ts", "src/auth/session.ts", "package-lock.json"]);
  expect(document.querySelector('.file[data-path="package-lock.json"]')!.classList.contains("collapsed")).toBe(true);
  expect(document.querySelectorAll(".step")).toHaveLength(3);
  expect(document.querySelector(".tldr code")!.textContent).toBe("tokens");
  expect(document.querySelector(".sec-h")?.textContent).not.toBe("Notes");
  // gutter dots at first row of each ref
  expect([...document.querySelectorAll("td.mark .dot")].map((d) => d.textContent)).toEqual([
    "1",
    "3.2",
    "3.2",
    "3.1",
    "2",
  ]);
});

test("hovering a step highlights exactly its lines; leaving clears", async () => {
  await mount();
  const step2 = document.querySelector<HTMLElement>('.step[data-step="2"]')!;
  fireEvent.mouseEnter(step2);
  expect(nums(".hl")).toEqual(["session.ts:6", "session.ts:7"]);
  fireEvent.mouseLeave(step2.parentElement!);
  expect(nums(".hl")).toEqual([]);
});

test("click pins + expands; clicking again unpins; j/k navigate; Esc clears", async () => {
  await mount();
  fireEvent.click(document.querySelector('.step[data-step="1"]')!);
  expect(nums(".pin")).toEqual(["types.ts:2"]);
  expect(document.querySelector('.step[data-step="1"]')!.classList.contains("active")).toBe(true);
  fireEvent.keyDown(window, { key: "j" });
  expect(nums(".pin")).toEqual(["session.ts:6", "session.ts:7"]);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(nums(".pin")).toEqual([]);
  fireEvent.click(document.querySelector('.step[data-step="2"]')!);
  fireEvent.click(document.querySelector('.step[data-step="2"]')!);
  expect(nums(".pin")).toEqual([]);
});

test("viewed collapses; skippable row expands lockfile; gutter dot focuses step", async () => {
  await mount();
  const types = document.querySelector('.file[data-path="src/auth/types.ts"]')!;
  fireEvent.click(types.querySelector(".viewed")!);
  expect(types.classList.contains("collapsed")).toBe(true);
  fireEvent.click(document.querySelector(".skip-row")!);
  await waitFor(() =>
    expect(document.querySelector('.file[data-path="package-lock.json"]')!.classList.contains("collapsed")).toBe(false),
  );
  fireEvent.click(document.querySelector('td.mark .dot[data-step="2"]')!);
  expect(nums(".pin")).toEqual(["session.ts:6", "session.ts:7"]);
  fireEvent.click(document.querySelector(".step .check")!);
  expect(document.body.textContent).toContain("1/3");
});

test("flow graph nodes link to steps", async () => {
  await mount();
  const nodes = document.querySelectorAll<SVGGElement>(".flow .fn");
  expect(nodes).toHaveLength(2);
  fireEvent.mouseEnter(nodes[1]);
  expect(nums(".hl")).toEqual(["session.ts:6", "session.ts:7"]);
  expect(document.querySelector('.step[data-step="2"]')!.classList.contains("hover")).toBe(true);
  fireEvent.click(nodes[0]);
  expect(nums(".pin")).toEqual(["types.ts:2"]);
  expect(nodes[0].classList.contains("active")).toBe(true);
});

test("substeps: hover/click highlight just their lines (multi-file); j/k walk substeps; gutter dots", async () => {
  await mount();
  const subs = document.querySelectorAll<HTMLElement>(".sub");
  expect([...subs].map((s) => s.querySelector(".sub-n")!.textContent)).toEqual(["3.1", "3.2"]);
  fireEvent.mouseEnter(subs[1]);
  expect(nums(".hl").sort()).toEqual(["session.ts:2", "types.ts:2"]);
  fireEvent.mouseEnter(document.querySelector('.step[data-step="3"]')!);
  expect(nums(".hl")).toHaveLength(3); // step = union of its substeps
  fireEvent.click(subs[0]);
  expect(nums(".pin")).toEqual(["session.ts:5"]);
  expect(subs[0].classList.contains("active")).toBe(true);
  fireEvent.keyDown(window, { key: "j" });
  expect(nums(".pin").sort()).toEqual(["session.ts:2", "types.ts:2"]);
  fireEvent.keyDown(window, { key: "k" });
  fireEvent.keyDown(window, { key: "k" });
  expect(document.querySelector('.step[data-step="3"]')!.classList.contains("active")).toBe(true);
  fireEvent.click(document.querySelector('td.mark .dot[data-step="3"][data-sub="1"]')!);
  expect(nums(".pin")).toEqual(["session.ts:5"]);
});

test("h/l walk the pinned step's line ranges, keeping the pin", async () => {
  await mount();
  useUI.getState().clearPin();
  fireEvent.click(document.querySelector('.step[data-step="3"]')!);
  expect(nums(".pin")).toHaveLength(3);
  fireEvent.keyDown(window, { key: "l" });
  expect(nums(".flash")).toEqual(["session.ts:5"]);
  expect(document.querySelector(".ref.on")!.textContent).toBe("session.ts:5");
  fireEvent.keyDown(window, { key: "l" });
  fireEvent.keyDown(window, { key: "l" });
  expect(nums(".flash")).toEqual(["types.ts:2"]);
  fireEvent.keyDown(window, { key: "l" }); // stays on the last one
  expect(nums(".flash")).toEqual(["types.ts:2"]);
  fireEvent.keyDown(window, { key: "h" });
  expect(nums(".flash")).toEqual(["session.ts:2"]);
  expect(nums(".pin")).toHaveLength(3); // still the whole step
  // j moves on, and h/l start again from the new item's first range
  fireEvent.keyDown(window, { key: "j" });
  expect(document.querySelector(".ref.on")).toBeNull();
  fireEvent.keyDown(window, { key: "l" });
  expect(nums(".flash")).toEqual(["session.ts:5"]);
});

test("comments sit under their last line, highlight it, and can be hidden, resolved, unresolved or asked about", async () => {
  await mount();
  const cmts = () => [...document.querySelectorAll<HTMLElement>("tr.cmt-row")];
  // each comment row follows the last line it cites
  expect(
    cmts().map((r) => [r.querySelector("b")!.textContent, (r.previousElementSibling as HTMLElement).dataset.new]),
  ).toEqual([
    ["No retry", "2"],
    ["Teardown on logout", "7"],
  ]);
  expect(cmts()[0].dataset.tone).toBe("bug");
  fireEvent.mouseEnter(cmts()[1]);
  expect(nums(".hl")).toEqual(["session.ts:6", "session.ts:7"]);

  // Ask opens the popup on the comment's lines, carrying the comment as context
  fireEvent.click(cmts()[1].querySelector('button[title="Ask in chat"]')!);
  const pop = document.querySelector(".ask-pop")!;
  expect(pop.querySelector(".ask-ctx")!.textContent).toContain("Teardown on logout");
  expect(pop.querySelector("input")!.getAttribute("placeholder")).toBe("Ask about this comment");
  fireEvent.keyDown(pop.querySelector("input")!, { key: "Enter", shiftKey: true }); // queue it
  const q = useChat.getState().chat.questions.at(-1)!;
  expect([q.text, q.anchor?.comment, q.anchor?.start, q.anchor?.end]).toEqual([
    "Tell me more about this comment.",
    "Teardown on logout. `end()` runs on logout too.",
    6,
    7,
  ]);

  // the toolbar toggle hides them all; resolving one removes it and the count
  const tg = document.querySelector<HTMLElement>(".cmt-tg")!;
  expect(tg.textContent).toBe("2");
  fireEvent.click(tg);
  expect(cmts()).toHaveLength(0);
  fireEvent.click(tg);
  fireEvent.click(cmts()[0].querySelector('button[title="Resolve"]')!);
  expect(tg.textContent).toBe("1");
  // a resolved comment collapses to one line, and one click on it unresolves
  const closed = cmts()[0];
  expect([closed.classList.contains("closed"), closed.textContent]).toEqual([true, "ResolvedNo retryUnresolve"]);
  fireEvent.click(closed.querySelector(".cmt-closed")!);
  expect([cmts()[0].querySelector(".cmt-t")!.textContent, tg.textContent]).toEqual(["A 5xx is not retried.", "2"]);
});

test("file list toggles, groups by directory, and opens a picked file", async () => {
  await mount();
  expect(document.querySelector(".rail")).toBeNull();
  fireEvent.click(document.querySelector('.diffpane button[title="Files"]')!);
  const rail = document.querySelector(".rail")!;
  expect([...rail.querySelectorAll(".rail-dir")].map((d) => d.textContent)).toEqual(["src/auth/"]);
  expect([...rail.querySelectorAll(".rail-f")].map((f) => f.querySelector(".nm")!.textContent)).toEqual([
    "package-lock.json",
    "session.ts",
    "types.ts",
  ]);
  expect(rail.querySelector('[data-path="package-lock.json"]')!.classList.contains("skip")).toBe(true);
  // picking a collapsed file opens it and marks it current
  fireEvent.click(rail.querySelector('[data-path="package-lock.json"]')!);
  await waitFor(() =>
    expect(rail.querySelector('[data-path="package-lock.json"]')!.classList.contains("on")).toBe(true),
  );
  expect(document.querySelector('.file[data-path="package-lock.json"]')!.classList.contains("collapsed")).toBe(false);
  expect(localStorage.getItem("rv-rail")).toBe("true");
});

test("expanding a gap fetches the file and reveals numbered context rows", async () => {
  await mount();
  const file = () => document.querySelector<HTMLElement>('.file[data-path="src/auth/session.ts"]')!;
  const ctxNums = () =>
    [...file().querySelectorAll<HTMLElement>("tr.ln.ctx")].map((r) => `${r.dataset.old}/${r.dataset.new}`);
  const before = ctxNums().length;
  // the hunk starts at line 1, so the only expander is the one after it
  expect(file().querySelectorAll("tr.gap")).toHaveLength(1);
  fireEvent.click(file().querySelector("tr.gap .exp-btn")!);
  await waitFor(() => expect(ctxNums().length).toBe(before + 20));
  expect(ctxNums().slice(-20)[0]).toBe("6/9");
  expect(file().querySelector('tr[data-rk="src/auth/session.ts:28"] .src')!.textContent).toBe("line 28");
  // 12 lines left: no more arrows; the row itself opens the rest and goes away
  expect(file().querySelector("tr.gap .exp-btn")).toBeNull();
  expect(file().querySelector("tr.gap .exp-all")!.textContent).toBe("12 more lines");
  fireEvent.click(file().querySelector("tr.gap")!);
  await waitFor(() => expect(ctxNums().at(-1)).toBe("37/40"));
  expect(file().querySelectorAll("tr.gap")).toHaveLength(0);
});

test("full file toggle shows every line, then folds back to the hunks", async () => {
  await mount();
  const file = () => document.querySelector<HTMLElement>('.file[data-path="src/auth/types.ts"]')!;
  const toggle = () =>
    file().querySelector<HTMLElement>(
      '.file-h button[title="Show full file"], .file-h button[title="Show changes only"]',
    )!;
  fireEvent.click(toggle());
  await waitFor(() => expect(file().querySelectorAll("tr.ln")).toHaveLength(40));
  fireEvent.click(toggle());
  expect(file().querySelectorAll("tr.ln")).toHaveLength(3);
});

test("⌘-click on a name previews its definition under the row; Esc closes it", async () => {
  await mount();
  vi.mocked(api.fetchDefinition).mockResolvedValueOnce([
    { path: "src/api/client.ts", line: 3, end: 5, text: "export async function refreshTokens(t) {\n  return t;\n}" },
  ]);
  nav.word = "refreshTokens";
  const row = document.querySelector<HTMLElement>('tr[data-rk="src/auth/session.ts:2"]')!;
  fireEvent.click(row.querySelector(".src")!, { metaKey: true });
  await waitFor(() => expect(document.querySelector(".peek .path")?.textContent).toBe("src/api/client.ts"));
  expect(api.fetchDefinition).toHaveBeenCalledWith(payload.pr.url, "refreshTokens", "src/auth/session.ts");
  expect(row.nextElementSibling!.classList.contains("peek-row")).toBe(true);
  expect([...document.querySelectorAll(".peek-b td.no")].map((td) => td.textContent)).toEqual(["3", "4", "5"]);
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(document.querySelector(".peek")).toBeNull());
  // a plain click does nothing
  fireEvent.click(row.querySelector(".src")!);
  expect(document.querySelector(".peek")).toBeNull();
});

test("a definition already in the diff is jumped to instead of previewed", async () => {
  await mount();
  vi.mocked(api.fetchDefinition).mockResolvedValueOnce([
    { path: "src/auth/types.ts", line: 2, end: 2, text: "  expiresAt: number;" },
  ]);
  nav.word = "expiresAt";
  fireEvent.click(document.querySelector('tr[data-rk="src/auth/session.ts:2"] .src')!, { metaKey: true });
  await waitFor(() => expect(nums(".flash")).toEqual(["types.ts:2"]));
  expect(document.querySelector(".peek")).toBeNull();
});

async function mountWith(data: typeof payload) {
  vi.mocked(api.fetchPR).mockResolvedValueOnce(data);
  useApp.setState({ url: data.pr.url, pr: null, guide: null, versions: [] });
  render(<App />);
  await waitFor(() => expect(screen.getByText("Add token refresh")).toBeTruthy());
}

test("version history: shown once there are two, and picking one swaps the guide", async () => {
  const v2 = { ...payload.guide!, version: 2, tldr: "second", label: "Split config" };
  const versions = [
    ...payload.versions,
    { version: 2, label: "Split config", scope: null, source: "chat" as const, created_at: 0 },
  ];
  await mountWith({ ...payload, guide: v2, versions });
  expect(document.querySelector(".tldr")!.textContent).toBe("second");
  fireEvent.click(document.querySelector(".ver-btn")!);
  const items = [...document.querySelectorAll<HTMLElement>(".ver-menu .h-item")];
  expect(items.map((i) => i.querySelector(".h-t")!.textContent)).toEqual(["v2Split config", "v1Guide"]);
  vi.mocked(api.fetchGuide).mockResolvedValueOnce({ ...payload.guide!, version: 1, tldr: "first" });
  fireEvent.click(items[1]);
  await waitFor(() => expect(document.querySelector(".tldr")!.textContent).toBe("first"));
  expect(api.fetchGuide).toHaveBeenCalledWith(payload.pr.url, 1);
  expect(new URLSearchParams(location.search).get("v")).toBe("1");
  expect(useApp.getState().following).toBe(false); // an older version stays put when new ones arrive
});

test("scope chip names what the guide covers", async () => {
  const scoped = { ...payload.guide!, scope: { files: ["src/auth/"], note: "auth only" } };
  await mountWith({ ...payload, guide: scoped });
  expect(document.querySelector(".scope-chip")!.textContent).toBe("auth only");
  expect(document.querySelector(".ver-btn")).toBeNull(); // one version: no history
});

test("no guide yet: says how to get one, then shows it when it's submitted", async () => {
  await mountWith({ ...payload, guide: null, versions: [] });
  expect(document.querySelector(".no-guide code")!.textContent).toBe("/diffusion:review");
  vi.mocked(api.fetchGuide).mockResolvedValueOnce({ ...payload.guide!, version: 1 });
  await useApp.getState().refresh();
  await waitFor(() => expect(document.querySelector(".tldr")).toBeTruthy());
  expect(document.querySelector(".no-guide")).toBeNull();
});
