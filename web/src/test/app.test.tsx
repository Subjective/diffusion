import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { payload } from "./fixture";

vi.mock("../lib/highlight", () => ({ langFor: () => null, highlightHunk: async () => new Map() }));
vi.mock("../api", () => ({ fetchPR: vi.fn(async () => payload), streamGuide: vi.fn() }));

const { App } = await import("../App");
const { useApp } = await import("../store");

const rows = (sel: string) => [...document.querySelectorAll<HTMLTableRowElement>(`tr.ln${sel}`)];
const nums = (sel: string) =>
  rows(sel).map((r) => `${r.dataset.file!.split("/").pop()}:${r.dataset.new ?? "-" + r.dataset.old}`);

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
