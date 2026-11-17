import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installTips } from "./tips";

let uninstall: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  uninstall = installTips();
});
afterEach(() => {
  uninstall();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const button = (label: string) => {
  const b = document.createElement("button");
  b.dataset.tip = label;
  b.innerHTML = "<svg></svg>";
  document.body.append(b);
  return b;
};
const bubble = () => document.getElementById("tip")!;
const hover = (el: Element, from: Element | null = null) =>
  el.firstElementChild!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: from }));
const leave = (el: Element, to: Element | null = document.body) =>
  el.firstElementChild!.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: to }));

test("a data-tip shows after a short hover, describes its element, and hides on leaving", () => {
  const b = button("Comments");
  hover(b);
  expect(bubble().classList.contains("on")).toBe(false);
  vi.advanceTimersByTime(400);
  expect(bubble().classList.contains("on")).toBe(true);
  expect(bubble().textContent).toBe("Comments");
  expect(b.getAttribute("aria-describedby")).toBe("tip");
  leave(b);
  expect(bubble().classList.contains("on")).toBe(false);
  expect(b.hasAttribute("aria-describedby")).toBe(false);
});

test("moving straight to the next tip shows it at once", () => {
  const a = button("Files");
  const b = button("Collapse all");
  hover(a);
  vi.advanceTimersByTime(400);
  leave(a, b.firstElementChild);
  hover(b, a);
  expect(bubble().classList.contains("on")).toBe(true);
  expect(bubble().textContent).toBe("Collapse all");
});

test("an open menu's button shows no tip", () => {
  const b = button("Agent");
  b.setAttribute("aria-expanded", "true");
  hover(b);
  vi.advanceTimersByTime(400);
  expect(bubble().classList.contains("on")).toBe(false);
});
