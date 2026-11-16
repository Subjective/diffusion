import { expect, test } from "vitest";
import { commentable } from "../review";
import type { FileDiff } from "../types";

const files = [
  {
    path: "a.rs",
    hunks: [
      {
        id: "h1",
        file: "a.rs",
        old_start: 10,
        old_len: 3,
        new_start: 10,
        new_len: 3,
        symbol: "",
        lines: [
          { type: "ctx", old: 10, new: 10, text: "" },
          { type: "del", old: 11, new: null, text: "" },
          { type: "add", old: null, new: 11, text: "" },
          { type: "ctx", old: 12, new: 12, text: "" },
        ],
      },
    ],
  },
] as unknown as FileDiff[];

test("GitHub takes comments only on lines of the diff, on their side", () => {
  expect(commentable(files, "a.rs", "new", 10, 12)).toBe(true);
  expect(commentable(files, "a.rs", "old", 11, 11)).toBe(true);
  expect(commentable(files, "a.rs", "new", 30, 30)).toBe(false); // expanded context
  expect(commentable(files, "a.rs", "new", 12, 13)).toBe(false); // runs past the hunk
  expect(commentable(files, "b.rs", "new", 1, 1)).toBe(false); // a file the PR doesn't change
});
