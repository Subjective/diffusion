import { questionRows } from "../App";
import type { Question } from "../chat";
import { indexFiles } from "../lib/refs";
import { payload } from "./fixture";

const note = (file: string, pfrom: number, pto: number): Question => ({
  id: "q",
  n: 1,
  text: "why?",
  anchor: { file, side: "new", start: pfrom, end: pto, code: "", pfrom, pto },
  status: "answered",
  answer: "",
  tools: [],
  turn: 0,
});

test("a note's badge goes on its first line, in the diff, in expanded context, or in a file tab", () => {
  const idx = indexFiles(payload.files);
  const f = payload.files[0];
  const h = f.hunks[0];
  // on the diff's own rows
  const inDiff = questionRows(note(f.path, h.new_start, h.new_start + 1), idx);
  expect(inDiff.keys[0]).toBe(`${f.path}:${h.new_start}`);
  // on lines no hunk has (expanded context, a file tab): still keyed by line
  const outside = questionRows(note(f.path, 900, 902), idx);
  expect(outside.keys).toEqual([`${f.path}:900`, `${f.path}:901`, `${f.path}:902`]);
});
