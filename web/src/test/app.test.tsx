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
  streamGuide: vi.fn(),
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
  expect(document.querySelector(".note.warn")!.textContent).toBe("No retry on 5xx");
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

test("notes with refs link to lines", async () => {
  await mount();
  const note = document.querySelector<HTMLElement>(".note.linked")!;
  fireEvent.mouseEnter(note);
  expect(nums(".hl")).toEqual(["session.ts:6", "session.ts:7"]);
  fireEvent.click(note);
  expect(document.querySelectorAll("tr.ln.flash").length).toBe(2);
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
