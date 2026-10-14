import { indexFiles, refLabel, rowsForRef, rowsOfHunk } from "./refs";
import type { FileDiff, Hunk } from "../types";

const hunk: Hunk = {
  id: "H1",
  file: "src/a.ts",
  old_start: 10,
  old_len: 4,
  new_start: 10,
  new_len: 5,
  symbol: "",
  lines: [
    { type: "ctx", old: 10, new: 10, text: "a" },
    { type: "del", old: 11, new: null, text: "b" },
    { type: "add", old: null, new: 11, text: "B" },
    { type: "add", old: null, new: 12, text: "C" },
    { type: "ctx", old: 12, new: 13, text: "d" },
    { type: "del", old: 13, new: null, text: "e" },
    { type: "ctx", old: 14, new: 14, text: "f" },
  ],
};
const files: FileDiff[] = [
  { path: "src/a.ts", old_path: null, status: "modified", binary: false, additions: 2, deletions: 2, hunks: [hunk], skip: null },
];

test("positions: deletions sit half a line after the previous new line", () => {
  expect(rowsOfHunk(hunk).map((r) => r.pos)).toEqual([10, 10.5, 11, 12, 13, 13.5, 14]);
});

test("whole-hunk ref covers all rows", () => {
  expect(rowsForRef({ hunk: "H1", side: "new", start: null, end: null }, indexFiles(files))).toHaveLength(7);
});

test("new-side range includes interior deletions only", () => {
  const idx = indexFiles(files);
  const pos = (s: number, e: number) => rowsForRef({ hunk: "H1", side: "new", start: s, end: e }, idx).map((r) => r.pos);
  expect(pos(11, 12)).toEqual([11, 12]);
  expect(pos(10, 13)).toEqual([10, 10.5, 11, 12, 13]);
  expect(pos(13, 14)).toEqual([13, 13.5, 14]);
});

test("old-side range uses old numbers", () => {
  const rows = rowsForRef({ hunk: "H1", side: "old", start: 11, end: 11 }, indexFiles(files));
  expect(rows.map((r) => r.type)).toEqual(["del"]);
});

test("labels", () => {
  const idx = indexFiles(files);
  expect(refLabel({ hunk: "H1", side: "new", start: 11, end: 12 }, idx)).toBe("a.ts:11–12");
  expect(refLabel({ hunk: "H1", side: "new", start: null, end: null }, idx)).toBe("a.ts:10–14");
  expect(refLabel({ hunk: "H9", side: "new", start: null, end: null }, idx)).toBe("H9");
});
