// Turn a diff text selection or a bubble-drag into a line range + anchor, using the DOM rows the diff renders.
import type { Anchor } from "../chat";

export interface RowInfo {
  file: string;
  pos: number;
  new: number | null;
  old: number | null;
  type: "add" | "del" | "ctx";
  code: string;
}

export function rowInfo(tr: HTMLElement): RowInfo | null {
  if (!tr.dataset.file || tr.dataset.pos == null) return null;
  return {
    file: tr.dataset.file,
    pos: Number(tr.dataset.pos),
    new: tr.dataset.new ? Number(tr.dataset.new) : null,
    old: tr.dataset.old ? Number(tr.dataset.old) : null,
    type: (tr.className.match(/\b(add|del|ctx)\b/)?.[1] as RowInfo["type"]) ?? "ctx",
    code: tr.querySelector(".src")?.textContent ?? "",
  };
}

export function anchorFromRows(rows: RowInfo[]): Anchor | null {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => a.pos - b.pos);
  const allDel = sorted.every((r) => r.type === "del");
  const side: "new" | "old" = allDel ? "old" : "new";
  const nums = sorted.map((r) => (side === "old" ? r.old : r.new)).filter((n): n is number => n != null);
  const start = Math.min(...nums);
  const end = Math.max(...nums);
  return {
    file: sorted[0].file,
    side,
    start,
    end,
    code: sorted.map((r) => r.code).join("\n"),
    pfrom: sorted[0].pos,
    pto: sorted[sorted.length - 1].pos,
  };
}

const rowOf = (node: Node | null): HTMLElement | null => {
  const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null);
  return el?.closest<HTMLElement>("tr.ln") ?? null;
};

/** Contiguous rows between two endpoints in the same table, in document order. */
export function rowsBetween(a: HTMLElement, b: HTMLElement): HTMLElement[] {
  const table = a.closest("table");
  if (!table || b.closest("table") !== table) return [a];
  const all = [...table.querySelectorAll<HTMLElement>("tr.ln")];
  const i = all.indexOf(a);
  const j = all.indexOf(b);
  if (i < 0 || j < 0) return [a];
  return all.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** Current text selection → contiguous rows within one file, or null. */
export function selectionRows(sel: Selection | null): HTMLElement[] | null {
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return null;
  const a = rowOf(sel.anchorNode);
  const b = rowOf(sel.focusNode);
  if (!a || !b || a.dataset.file !== b.dataset.file) return null;
  return rowsBetween(a, b);
}

export const rangeText = (a: number, b: number) => (a === b ? `L${a}` : `L${a}–${b}`);
