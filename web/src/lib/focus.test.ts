import { describe, expect, it } from "vitest";
import { focusScrollTop, mergeSpans, type Span } from "./focus";

const row = (top: number, file = "a.ts", h = 20): Span => ({ top, bottom: top + h, file });
const block = (top: number, n: number, file = "a.ts") => Array.from({ length: n }, (_, i) => row(top + i * 20, file));

// 800px pane, 84px of sticky headers, 40px of context: 636px of room
const place = (spans: Span[], anchor = "a.ts") => focusScrollTop(spans, anchor, 800, 84, 40);

describe("focusScrollTop", () => {
  it("puts a block taller than the screen just under the headers", () => {
    expect(place(block(2000, 60))).toBe(2000 - 84 - 40);
  });

  it("centers a block that fits", () => {
    // 200px block, (636 - 200) / 2 = 218px of slack on each side
    expect(place(block(2000, 10))).toBe(2000 - 84 - 40 - 218);
  });

  it("anchors on the first ref's file and keeps what follows in view", () => {
    const spans = [...block(5000, 5, "b.ts"), ...block(1000, 5, "a.ts"), ...block(3000, 5, "c.ts")];
    expect(place(spans, "c.ts")).toBe(3000 - 84 - 40);
  });

  it("never scrolls above the top", () => {
    expect(place(block(10, 3))).toBe(0);
  });
});

describe("mergeSpans", () => {
  it("joins touching rows and keeps gaps", () => {
    expect(mergeSpans([row(40), row(0), row(20), row(200)])).toEqual([
      { top: 0, bottom: 60, file: "a.ts" },
      { top: 200, bottom: 220, file: "a.ts" },
    ]);
  });
});
