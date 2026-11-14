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

const PATH = String.raw`(?:\.\/)?((?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.\w+)`;
const RANGE = String.raw`L?(\d+)(?:\s*[-–—]\s*L?(\d+))?`;
const CITE = new RegExp(`^${PATH}:(${RANGE}(?:\\s*,\\s*${RANGE})*)$`);
const ONE_RANGE = new RegExp(`^${RANGE}$`);
/** `:12` or `L12–20` on its own: a line in the file cited just before it. */
const BARE = new RegExp(`^(?::L?|L)${RANGE.slice(2)}$`);

const loc = (file: string, a: number, b = a): CodeLoc => ({
  file,
  start: Math.min(a, b),
  end: Math.max(a, b),
  side: "new",
});

/** Parse an inline-code citation: `file.ext:N`, `file.ext:N–M`, or a list on one file (`file.ext:3, 8–10`).
 *  Other shapes return null, so `a:b` code is left alone. One location per range, with the text it was cited as. */
export function parseCites(text: string): { loc: CodeLoc; text: string }[] | null {
  const m = text.trim().match(CITE);
  if (!m) return null;
  return m[2].split(",").map((part, i) => {
    const r = part.trim().match(ONE_RANGE)!;
    const a = Number(r[1]);
    return { loc: loc(m[1], a, r[2] ? Number(r[2]) : a), text: i ? part.trim() : `${m[1]}:${part.trim()}` };
  });
}

const FILE = /^\/?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.\w+$/;

/** A bare file path in inline code (`src/a.ts`, or an absolute one), or null. It needs a folder (`a/b.ts`), so
 *  `x.y` code isn't taken for a file. */
export function parsePath(text: string): string | null {
  const t = text.trim().replace(/^\.\//, "");
  return t.includes("/") && FILE.test(t) ? t : null;
}

/** A path as the repository knows it: itself; else, for a longer one (an absolute path in the agent's checkout),
 *  the longest known path it ends with; else, for a shorter one, the one known path ending with it. */
export function repoPath(path: string, known: Iterable<string>): string | null {
  let longest: string | null = null;
  const ending: string[] = [];
  for (const k of known) {
    if (k === path) return k;
    if (path.endsWith(`/${k}`) && (!longest || k.length > longest.length)) longest = k;
    if (k.endsWith(`/${path}`)) ending.push(k);
  }
  return longest ?? (ending.length === 1 ? ending[0] : null);
}

/** The first location of a citation (see `parseCites`). */
export function parseCite(text: string): CodeLoc | null {
  return parseCites(text)?.[0].loc ?? null;
}

/** Answers sometimes cite a file once and then only line numbers (`a.ts:3` … `:9`). Spell those out so every
 *  citation names its file. */
export function expandCites(md: string): string {
  let file: string | null = null;
  return md.replace(/`([^`\n]+)`/g, (span, inner: string) => {
    const full = inner.trim().match(CITE);
    if (full) file = full[1];
    else if (file && BARE.test(inner.trim())) return `\`${file}:${inner.trim().replace(/^:/, "")}\``;
    return span;
  });
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
