import type { Hunk } from "../types";
import { gapsOf, shownLines, splitLines } from "./expand";

const hunk = (old_start: number, old_len: number, new_start: number, new_len: number): Hunk => ({
  id: "H",
  file: "f",
  old_start,
  old_len,
  new_start,
  new_len,
  symbol: "",
  lines: [],
});

test("gaps sit before each hunk and after the last, with the old/new offset", () => {
  // lines 10–14 → 10–16, then 40–41 → 42–42
  const gaps = gapsOf([hunk(10, 5, 10, 7), hunk(40, 2, 42, 1)]);
  expect(gaps).toEqual([
    { start: 1, end: 9, delta: 0 },
    { start: 17, end: 41, delta: -2 },
    { start: 43, end: null, delta: -1 },
  ]);
});

test("empty sides: a file added from nothing, and a hunk that only deletes", () => {
  expect(gapsOf([hunk(0, 0, 1, 3)])[0]).toEqual({ start: 1, end: 0, delta: 0 });
  // delete old 5–6; new side has 4 lines before, so the trailing gap starts at 5
  expect(gapsOf([hunk(5, 2, 4, 0)])).toEqual([
    { start: 1, end: 4, delta: 0 },
    { start: 5, end: null, delta: 2 },
  ]);
});

test("reveals from either end and merges once they meet", () => {
  const gap = { start: 17, end: 41, delta: -2 };
  expect(shownLines(gap, { top: 0, bottom: 0 }, null)).toEqual({ top: [], bottom: [], hidden: 25 });
  const s = shownLines(gap, { top: 2, bottom: 3 }, null);
  expect([s.top, s.bottom, s.hidden]).toEqual([[17, 18], [39, 40, 41], 20]);
  expect(shownLines(gap, { top: 20, bottom: 20 }, null).top).toHaveLength(25);
});

test("the trailing gap waits for the file length", () => {
  const gap = { start: 43, end: null, delta: -1 };
  expect(shownLines(gap, { top: 20, bottom: 0 }, null).hidden).toBeNull();
  expect(shownLines(gap, { top: 20, bottom: 0 }, 50)).toEqual({
    top: [43, 44, 45, 46, 47, 48, 49, 50],
    bottom: [],
    hidden: 0,
  });
  expect(shownLines(gap, { top: 0, bottom: 0 }, 42).hidden).toBe(0);
});

test("splitLines drops the trailing newline's empty line", () => {
  expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
  expect(splitLines("a\nb")).toEqual(["a", "b"]);
});
