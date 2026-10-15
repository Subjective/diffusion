// Code citations in chat answers (`path:line`, `path:a–b`) and model-requested focus regions, resolved to diff rows.
import type { FileDiff } from "../types";
import { type HunkIndex, rowKey, rowsForRef } from "./refs";

export interface CodeLoc {
  file: string;
  start: number;
  end: number;
  side: "new" | "old";
}

export interface Resolved {
  file: string; // full diff path
  keys: string[];
  files: string[];
}

const CITE = /^(?:\.\/)?((?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[\w]+):L?(\d+)(?:\s*[-–—]\s*L?(\d+))?$/;

/** Parse an inline-code citation. Only `file.ext:N` or `file.ext:N–M` shapes count, so `a:b` code is left alone. */
export function parseCite(text: string): CodeLoc | null {
  const m = text.trim().match(CITE);
  if (!m) return null;
  const a = Number(m[2]);
  const b = m[3] ? Number(m[3]) : a;
  return { file: m[1], start: Math.min(a, b), end: Math.max(a, b), side: "new" };
}

/** Exact path, else the unique diff file whose path ends with `/file` (answers often cite short paths). */
export function findFile(files: FileDiff[], file: string): FileDiff | null {
  const exact = files.find((f) => f.path === file);
  if (exact) return exact;
  const hits = files.filter((f) => f.path.endsWith(`/${file}`));
  return hits.length === 1 ? hits[0] : null;
}

/** Rows a location covers in the diff, or null when the file or lines aren't part of it. */
export function resolveLoc(loc: CodeLoc, files: FileDiff[], idx: HunkIndex): Resolved | null {
  const f = findFile(files, loc.file);
  if (!f) return null;
  const rows = f.hunks.flatMap((h) => rowsForRef({ hunk: h.id, side: loc.side, start: loc.start, end: loc.end }, idx));
  return rows.length ? { file: f.path, keys: rows.map((r) => rowKey(r.file, r.pos)), files: [f.path] } : null;
}
