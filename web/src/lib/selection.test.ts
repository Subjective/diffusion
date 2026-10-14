import { anchorFromRows, rangeText, type RowInfo } from "./selection";

const r = (over: Partial<RowInfo>): RowInfo => ({ file: "a.ts", pos: 0, new: null, old: null, type: "ctx", code: "", ...over });

test("new-side anchor from mixed rows", () => {
  const a = anchorFromRows([
    r({ pos: 11, new: 11, type: "add", code: "B" }),
    r({ pos: 10.5, old: 11, type: "del", code: "b" }),
    r({ pos: 12, new: 12, type: "add", code: "C" }),
  ])!;
  expect(a.side).toBe("new");
  expect([a.start, a.end]).toEqual([11, 12]);
  expect([a.pfrom, a.pto]).toEqual([10.5, 12]);
  expect(a.code).toBe("b\nB\nC"); // sorted by pos
});

test("all-deletions anchor uses old side", () => {
  const a = anchorFromRows([r({ pos: 13.5, old: 13, type: "del" }), r({ pos: 13.5, old: 14, type: "del" })])!;
  expect(a.side).toBe("old");
  expect([a.start, a.end]).toEqual([13, 14]);
});

test("empty -> null; range text", () => {
  expect(anchorFromRows([])).toBeNull();
  expect(rangeText(5, 5)).toBe("L5");
  expect(rangeText(5, 9)).toBe("L5–9");
});
