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

/** Highlighted rows of the pane, measured in scroll-content coordinates, one span per run of adjacent rows.
 *  Only the files holding the keys are searched, and only each run's ends are measured: measuring forces layout,
 *  and content-visibility skips the layout of files out of view. Rows in collapsed or hidden files are skipped. */
export function measureRows(pane: HTMLElement, keys: Iterable<string>): Span[] {
  const byFile = groupByFile(keys);
  if (!byFile.size) return [];
  const base = pane.getBoundingClientRect().top - pane.scrollTop;
  const spans: Span[] = [];
  const add = (a: HTMLElement, b: HTMLElement, file: string) =>
    spans.push({ top: a.getBoundingClientRect().top - base, bottom: b.getBoundingClientRect().bottom - base, file });
  for (const el of filesOf(pane)) {
    const file = el.dataset.path!;
    const want = byFile.get(file);
    if (!want || !el.offsetParent) continue;
    let first: HTMLElement | null = null;
    let last: HTMLElement | null = null;
    for (const row of el.querySelectorAll<HTMLElement>("tr[data-rk]")) {
      if (want.has(row.dataset.rk!)) {
        first ??= row;
        last = row;
      } else if (first) {
        add(first, last!, file);
        first = null;
      }
    }
    if (first) add(first, last!, file);
  }
  return spans;
}

/** Roughly where highlighted rows sit, for the scrollbar's marks: each file is measured, and rows are placed by
 *  their share of its rows (close enough for a mark a few pixels tall). Measuring the rows themselves would lay out every file they are in. */
export function estimateRows(pane: HTMLElement, keys: Iterable<string>): Span[] {
  const byFile = groupByFile(keys);
  if (!byFile.size) return [];
  const base = pane.getBoundingClientRect().top - pane.scrollTop;
  const spans: Span[] = [];
  for (const el of filesOf(pane)) {
    const file = el.dataset.path!;
    const want = byFile.get(file);
    const body = want && el.querySelector<HTMLElement>(".file-b");
    if (!body || !el.offsetParent) continue;
    const rows = body.querySelectorAll<HTMLElement>("tr");
    // The file's own box is cheap: out of view, content-visibility sizes it without laying out its rows.
    const box = el.getBoundingClientRect();
    const top = box.top - base;
    const per = box.height / rows.length;
    let first = -1;
    rows.forEach((row, i) => {
      const on = want.has(row.dataset.rk ?? "");
      if (on && first < 0) first = i;
      if (first >= 0 && (!on || i === rows.length - 1)) {
        const end = on ? i + 1 : i;
        spans.push({ top: top + first * per, bottom: top + end * per, file });
        first = -1;
      }
    });
  }
  return spans;
}

function groupByFile(keys: Iterable<string>): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  for (const k of keys) {
    const file = k.slice(0, k.lastIndexOf(":"));
    const set = byFile.get(file) ?? new Set<string>();
    set.add(k);
    byFile.set(file, set);
  }
  return byFile;
}

/** The pane's file sections, from their parent rather than a search of every row. */
function filesOf(pane: HTMLElement): HTMLElement[] {
  return [...(pane.querySelector(".files")?.children ?? [])].filter(
    (el): el is HTMLElement => el instanceof HTMLElement,
  );
}
