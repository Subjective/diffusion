import { ArrowDownAZ, ChevronsDownUp, EyeOff, Route } from "lucide-react";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { focusScrollTop, measureRows, mergeSpans } from "../lib/focus";
import { indexFiles, rowKey, rowsForRef } from "../lib/refs";
import { useApp } from "../store";
import type { FileDiff as FD, Guide, Ref } from "../types";
import { markDiffActivity, useUI } from "../ui";
import { type Dot, FileDiff, type Gutter } from "./FileDiff";
import { ic } from "./icons";

/** Files in guide order: by first step that references them, then unreferenced, then skippable. */
export function guideOrder(files: FD[], guide: Guide | null): FD[] {
  if (!guide) return files;
  const hunkFile = new Map(files.flatMap((f) => f.hunks.map((h) => [h.id, f.path] as const)));
  const rank = new Map<string, number>();
  guide.steps.forEach((s, i) => {
    for (const r of s.refs) {
      const p = hunkFile.get(r.hunk);
      if (p && !rank.has(p)) rank.set(p, i);
    }
  });
  const skip = new Set(guide.skippable.map((s) => s.file));
  const score = (f: FD) => rank.get(f.path) ?? (skip.has(f.path) || f.skip ? 2000 : 1000);
  return files
    .map((f, i) => [f, i] as const)
    .sort((a, b) => score(a[0]) - score(b[0]) || a[1] - b[1])
    .map(([f]) => f);
}

export function DiffPane({ extras }: { extras?: Gutter["extras"] }) {
  const { files, guide } = useApp();
  const { order, setOrder, hideSkip, toggleHideSkip, collapseAll, scrollTo } = useUI();
  const pane = useRef<HTMLElement>(null);

  const idx = useMemo(() => indexFiles(files), [files]);
  const skipFiles = useMemo(
    () => new Set([...files.filter((f) => f.skip).map((f) => f.path), ...(guide?.skippable.map((s) => s.file) ?? [])]),
    [files, guide],
  );

  const { dots, fileSteps } = useMemo(() => {
    const dots = new Map<string, Dot[]>();
    const fileSteps = new Map<string, number[]>();
    const mark = (refs: Ref[], dot: Dot) => {
      for (const r of refs) {
        const rows = rowsForRef(r, idx);
        if (!rows.length) continue;
        const k = rowKey(rows[0].file, rows[0].pos);
        const list = dots.get(k) ?? [];
        if (!list.some((d) => d.step === dot.step && d.sub === dot.sub)) dots.set(k, [...list, dot]);
        const fs = fileSteps.get(rows[0].file) ?? [];
        if (!fs.includes(dot.step)) fileSteps.set(rows[0].file, [...fs, dot.step]);
      }
    };
    for (const s of guide?.steps ?? []) {
      // Steps with substeps mark each substep (1.1, 1.2…); others mark the step.
      if (s.substeps?.length) for (const b of s.substeps) mark(b.refs, { step: s.id, sub: b.id });
      else mark(s.refs, { step: s.id, sub: null });
    }
    return { dots, fileSteps };
  }, [guide, idx]);

  const ordered = useMemo(
    () => (order === "guide" ? guideOrder(files, guide) : [...files].sort((a, b) => a.path.localeCompare(b.path))),
    [files, guide, order],
  );

  useEffect(() => {
    if (!scrollTo) return;
    // wait a frame for expanded files to render
    requestAnimationFrame(() => {
      const p = pane.current;
      const first = p?.querySelector<HTMLElement>(`tr[data-rk="${CSS.escape(scrollTo.keys[0])}"]`);
      if (!p || !first) return;
      const file = first.closest<HTMLElement>(".file");
      const header =
        (p.querySelector<HTMLElement>(".toolbar")?.offsetHeight ?? 0) +
        (file?.querySelector<HTMLElement>(".file-h")?.offsetHeight ?? 0);
      const top = focusScrollTop(
        measureRows(p, scrollTo.keys),
        file?.dataset.path ?? "",
        p.clientHeight,
        header,
        2 * first.offsetHeight,
      );
      p.scrollTo({ top, behavior: "smooth" });
    });
  }, [scrollTo]);

  const gutter: Gutter = useMemo(() => ({ dots, extras }), [dots, extras]);
  const allCollapsed = useUI((s) => files.length > 0 && files.every((f) => s.collapsed[f.path]));

  return (
    <div className="diffwrap">
      <section
        className="diffpane"
        id="diffPane"
        ref={pane}
        onWheel={markDiffActivity}
        onTouchMove={markDiffActivity}
        onMouseDown={markDiffActivity}
        onKeyDown={markDiffActivity}
      >
        <div className="toolbar">
          <span className="grow" />
          <button
            type="button"
            className="icon-btn sm on"
            title={order === "guide" ? "Order: guide" : "Order: A–Z"}
            onClick={() => setOrder(order === "guide" ? "alpha" : "guide")}
          >
            {ic(order === "guide" ? Route : ArrowDownAZ, 15)}
          </button>
          <button
            type="button"
            className={`icon-btn sm${hideSkip ? " on" : ""}`}
            title="Hide skippable"
            onClick={toggleHideSkip}
          >
            {ic(EyeOff, 15)}
          </button>
          <button
            type="button"
            className="icon-btn sm"
            title={allCollapsed ? "Expand all" : "Collapse all"}
            onClick={() => collapseAll(!allCollapsed, [...skipFiles])}
          >
            {ic(ChevronsDownUp, 15)}
          </button>
        </div>
        <div className={`files${hideSkip ? " hide-skip" : ""}`}>
          {ordered.map((f) => (
            <FileDiff
              key={f.path}
              file={skipFiles.has(f.path) && !f.skip ? { ...f, skip: "trivial" } : f}
              steps={fileSteps.get(f.path) ?? []}
              gutter={gutter}
            />
          ))}
        </div>
      </section>
      <ScrollMarks pane={pane} />
    </div>
  );
}

/** Ticks on the scrollbar for the hovered lines (else the pinned ones), so highlights off screen (or in other files) are easy to find. */
function ScrollMarks({ pane }: { pane: RefObject<HTMLElement | null> }) {
  const pin = useUI((s) => s.pinRows);
  const hover = useUI((s) => s.hoverRows);
  const [marks, setMarks] = useState<{ top: number; height: number }[]>([]);

  useEffect(() => {
    const p = pane.current;
    if (!p) return;
    const measure = () => {
      const h = p.scrollHeight;
      const spans = h > p.clientHeight ? mergeSpans(measureRows(p, hover.size ? hover : pin), 24) : [];
      setMarks(spans.map((s) => ({ top: s.top / h, height: (s.bottom - s.top) / h })));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(p);
    const files = p.querySelector(".files");
    if (files) ro.observe(files);
    return () => ro.disconnect();
  }, [pane, pin, hover]);

  if (!marks.length) return null;
  return (
    <div className="scroll-marks" aria-hidden>
      {marks.map((m) => (
        <span key={m.top} style={{ top: `${m.top * 100}%`, height: `max(3px, ${m.height * 100}%)` }} />
      ))}
    </div>
  );
}
