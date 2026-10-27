// Regression: ask listeners must work when the diff mounts *after* App (real page load order).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { payload } from "./fixture";

let resolvePR: (v: unknown) => void = () => {};
vi.mock("../lib/highlight", () => ({
  langFor: () => null,
  highlightHunk: async () => new Map(),
  highlightLines: async () => [],
}));
vi.mock("../api", () => ({ fetchPR: vi.fn(() => new Promise((r) => (resolvePR = r))), streamGuide: vi.fn() }));

const { App } = await import("../App");
const { useApp } = await import("../store");

test("bubble drag and text selection open the ask popup after a delayed load", async () => {
  useApp.setState({ url: payload.pr.url, pr: null, files: [], guide: null, chatOpen: true });
  render(<App />);
  expect(document.querySelector(".diffpane")).toBeNull(); // not mounted yet
  resolvePR(payload);
  await waitFor(() => expect(screen.getByText("Add token refresh")).toBeTruthy());

  const rows = [...document.querySelectorAll<HTMLElement>('tr.ln[data-file="src/auth/session.ts"]')];
  Object.defineProperty(document, "elementFromPoint", { value: () => rows[3], configurable: true });
  fireEvent.mouseDown(rows[1].querySelector(".ask-btn")!, { button: 0, clientX: 300, clientY: 100 });
  fireEvent.mouseMove(window, { clientX: 300, clientY: 140 });
  fireEvent.mouseUp(window, { clientX: 300, clientY: 140 });
  await waitFor(() => expect(document.querySelector(".ask-pop")).toBeTruthy());
  expect(document.querySelector(".ask-ctx")!.textContent).toContain("session.ts");
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(document.querySelector(".ask-pop")).toBeNull());

  // text selection across two rows
  const range = document.createRange();
  range.setStart(rows[4].querySelector(".src")!.firstChild!, 0);
  range.setEnd(rows[6].querySelector(".src")!.firstChild!, 3);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
  fireEvent.mouseUp(rows[6].querySelector(".src")!, { clientX: 320, clientY: 180 });
  await waitFor(() => expect(document.querySelector(".ask-pop")).toBeTruthy());
});
