import type { FileDiff, Guide } from "../types";
import { guideOrder } from "./DiffPane";

const f = (path: string, hunks: string[], skip: FileDiff["skip"] = null): FileDiff => ({
  path,
  old_path: null,
  status: "modified",
  binary: false,
  additions: 1,
  deletions: 0,
  skip,
  hunks: hunks.map((id) => ({
    id,
    file: path,
    old_start: 1,
    old_len: 1,
    new_start: 1,
    new_len: 1,
    symbol: "",
    lines: [],
  })),
});

test("guide order: step order first, then unreferenced, then skippable", () => {
  const files = [f("a.ts", ["H1"]), f("lock.json", ["H2"], "lockfile"), f("b.ts", ["H3"]), f("c.ts", ["H4"])];
  const guide = {
    steps: [
      { id: 1, title: "", kind: "core", summary: "", refs: [{ hunk: "H3", side: "new", start: null, end: null }] },
      { id: 2, title: "", kind: "core", summary: "", refs: [{ hunk: "H1", side: "new", start: null, end: null }] },
    ],
    skippable: [],
  } as unknown as Guide;
  expect(guideOrder(files, guide).map((x) => x.path)).toEqual(["b.ts", "a.ts", "c.ts", "lock.json"]);
  expect(guideOrder(files, null).map((x) => x.path)).toEqual(files.map((x) => x.path));
});
