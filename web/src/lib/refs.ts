// Map guide refs onto diff rows. A row is identified by (file, pos) where pos is the new-side line number
// for add/context lines. Deletions sit between the previous and next new line, spread evenly across a run so
// each one keeps its own pos (a lone deletion gets +0.5).
import type { FileDiff, Hunk, Line, Ref } from "../types";

export interface Row {
  file: string;
  hunk: string;
  pos: number;
  old: number | null;
  new: number | null;
  type: Line["type"];
}

export function rowsOfHunk(h: Hunk): Row[] {
  // Deletions left in the run from each line on, so each deletion knows how far through its run it is.
  const left: number[] = [];
  for (let i = h.lines.length - 1; i >= 0; i--) left[i] = h.lines[i].type === "del" ? (left[i + 1] ?? 0) + 1 : 0;
  let lastNew = h.new_start - 1;
  let k = 0;
  return h.lines.map((ln, i) => {
    let pos: number;
    if (ln.type === "del") {
      k++;
      pos = lastNew + k / (k + left[i]);
    } else {
      pos = lastNew = ln.new!;
      k = 0;
    }
    return { file: h.file, hunk: h.id, pos, old: ln.old, new: ln.new, type: ln.type };
  });
}

export interface HunkIndex {
  byId: Map<string, Hunk>;
  rows: Map<string, Row[]>; // hunk id → rows
}

export function indexFiles(files: FileDiff[]): HunkIndex {
  const byId = new Map<string, Hunk>();
  const rows = new Map<string, Row[]>();
  for (const f of files)
    for (const h of f.hunks) {
      byId.set(h.id, h);
      rows.set(h.id, rowsOfHunk(h));
    }
  return { byId, rows };
}

export const rowKey = (file: string, pos: number) => `${file}:${pos}`;

/** Rows a ref covers. Whole-hunk refs cover every row; ranges filter by line number on the ref's side. */
export function rowsForRef(ref: Ref, idx: HunkIndex): Row[] {
  const rows = idx.rows.get(ref.hunk) ?? [];
  if (ref.start == null && ref.end == null) return rows;
  const start = ref.start ?? ref.end!;
  const end = ref.end ?? start;
  if (ref.side === "old") return rows.filter((r) => r.old != null && r.old >= start && r.old <= end);
  // new side: include deletions interleaved within the range
  return rows.filter((r) => r.pos >= start && r.pos <= end && (r.type !== "del" || (r.pos > start && r.pos < end)));
}

export function refLabel(ref: Ref, idx: HunkIndex): string {
  const h = idx.byId.get(ref.hunk);
  if (!h) return ref.hunk;
  const name = h.file.split("/").pop();
  let a = ref.start,
    b = ref.end;
  if (a == null && b == null) {
    const r = idx.rows.get(h.id) ?? [];
    const nums = r.map((x) => (ref.side === "old" ? x.old : x.new)).filter((n): n is number => n != null);
    if (!nums.length) return name!;
    a = Math.min(...nums);
    b = Math.max(...nums);
  }
  a ??= b;
  b ??= a;
  return `${name}:${a}${b !== a ? `–${b}` : ""}`;
}
