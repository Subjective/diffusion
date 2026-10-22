// Where to scroll the diff when lines are focused, and where their marks sit on the scrollbar.

export interface Span {
  top: number; // offset in the pane's scroll content
  bottom: number;
  file: string;
}

/** Scroll offset that shows as much of a focus as fits. The first ref's file is primary: its first
 *  highlighted line lands just under the sticky headers with `pad` of context above, so everything
 *  after it gets the rest of the screen. The block is centered only when all of it fits. */
export function focusScrollTop(spans: Span[], anchorFile: string, view: number, header: number, pad: number): number {
  const sorted = [...spans].sort((a, b) => a.top - b.top);
  const start = sorted.find((s) => s.file === anchorFile) ?? sorted[0];
  if (!start) return 0;
  const room = view - header - 2 * pad;
  const span = sorted[sorted.length - 1].bottom - start.top;
  const slack = span <= room ? (room - span) / 2 : 0;
  return Math.max(0, start.top - header - pad - slack);
}

/** Merge rows that touch into one span, so a highlighted block reads as one mark. */
export function mergeSpans(spans: Span[], gap = 1): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].sort((a, b) => a.top - b.top)) {
    const last = out[out.length - 1];
    if (last && s.top <= last.bottom + gap) last.bottom = Math.max(last.bottom, s.bottom);
    else out.push({ ...s });
  }
  return out;
}

/** Highlighted rows of the pane, measured in scroll-content coordinates. Rows in collapsed files are skipped. */
export function measureRows(pane: HTMLElement, keys: Iterable<string>): Span[] {
  const base = pane.getBoundingClientRect().top - pane.scrollTop;
  const spans: Span[] = [];
  for (const k of new Set(keys)) {
    const el = pane.querySelector<HTMLElement>(`tr[data-rk="${CSS.escape(k)}"]`);
    if (!el?.offsetParent) continue;
    const r = el.getBoundingClientRect();
    spans.push({
      top: r.top - base,
      bottom: r.bottom - base,
      file: el.closest<HTMLElement>(".file")?.dataset.path ?? "",
    });
  }
  return spans;
}
