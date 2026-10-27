// Unchanged lines around and between hunks. A gap sits before each hunk (and one after the last); within a gap
// old and new line numbers differ by a constant, so revealed lines need only the new-side file.
import type { Hunk } from "../types";

export const STEP = 20;

export interface Gap {
  /** First and last new-side line. `end` is null for the trailing gap until the file's length is known. */
  start: number;
  end: number | null;
  /** old = new + delta */
  delta: number;
}

/** Lines revealed from each end of a gap: `top` below the previous hunk, `bottom` above the next. */
export interface Reveal {
  top: number;
  bottom: number;
}

const first = (start: number, len: number) => (len ? start : start + 1);
const last = (start: number, len: number) => (len ? start + len - 1 : start);

/** One gap per hunk (the lines before it), plus a trailing gap after the last hunk. */
export function gapsOf(hunks: Hunk[]): Gap[] {
  const gaps: Gap[] = hunks.map((h, i) => {
    const prev = hunks[i - 1];
    const newFirst = first(h.new_start, h.new_len);
    return {
      start: prev ? last(prev.new_start, prev.new_len) + 1 : 1,
      end: newFirst - 1,
      delta: first(h.old_start, h.old_len) - newFirst,
    };
  });
  const h = hunks.at(-1);
  if (h) {
    const newLast = last(h.new_start, h.new_len);
    gaps.push({ start: newLast + 1, end: null, delta: last(h.old_start, h.old_len) - newLast });
  }
  return gaps;
}

export interface Shown {
  /** New-side line numbers shown below the previous hunk, then above the next. */
  top: number[];
  bottom: number[];
  /** Lines still hidden, or null when the trailing gap's end isn't known yet. */
  hidden: number | null;
}

const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);

/** What a gap shows given how far it's been revealed. `total` is the file's line count, once loaded. */
export function shownLines(gap: Gap, rev: Reveal, total: number | null): Shown {
  const end = gap.end ?? total;
  if (end == null) return { top: [], bottom: [], hidden: null };
  const size = Math.max(0, end - gap.start + 1);
  if (rev.top + rev.bottom >= size) return { top: range(gap.start, end), bottom: [], hidden: 0 };
  return {
    top: range(gap.start, gap.start + rev.top - 1),
    bottom: range(end - rev.bottom + 1, end),
    hidden: size - rev.top - rev.bottom,
  };
}

/** Lines of a file's text, without the empty entry a trailing newline leaves. */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
