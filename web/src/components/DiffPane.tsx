import { useEffect, useMemo, useRef } from "react";
import { ArrowDownAZ, ChevronsDownUp, EyeOff, FileCode, Route } from "lucide-react";
import { indexFiles, rowKey, rowsForRef } from "../lib/refs";
import { useApp } from "../store";
import type { FileDiff as FD, Guide, Ref } from "../types";
import { useUI } from "../ui";
import { FileDiff, type Dot, type Gutter } from "./FileDiff";
import { ic } from "./icons";

/** Files in guide order: by first step that references them, then unreferenced, then skippable. */
export function guideOrder(files: FD[], guide: Guide | null): FD[] {
  if (!guide) return files;
  const hunkFile = new Map(files.flatMap((f) => f.hunks.map((h) => [h.id, f.path] as const)));
  const rank = new Map<string, number>();
  guide.steps.forEach((s, i) =>
    s.refs.forEach((r) => {
      const p = hunkFile.get(r.hunk);
      if (p && !rank.has(p)) rank.set(p, i);
    }),
  );
  const skip = new Set(guide.skippable.map((s) => s.file));
  const score = (f: FD) => rank.get(f.path) ?? (skip.has(f.path) || f.skip ? 2000 : 1000);
  return files.map((f, i) => [f, i] as const).sort((a, b) => score(a[0]) - score(b[0]) || a[1] - b[1]).map(([f]) => f);
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
      if (s.substeps?.length) s.substeps.forEach((b) => mark(b.refs, { step: s.id, sub: b.id }));
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
      const el = pane.current?.querySelector(`tr[data-rk="${CSS.escape(scrollTo.key)}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, [scrollTo]);

  const gutter: Gutter = useMemo(() => ({ dots, extras }), [dots, extras]);
  const allCollapsed = useUI((s) => files.length > 0 && files.every((f) => s.collapsed[f.path]));

  return (
    <section className="diffpane" id="diffPane" ref={pane}>
      <div className="toolbar">
        <span className="lbl">
          {ic(FileCode, 14)}
          <span>{files.length}</span>
        </span>
        <span className="grow" />
        <button
          className="icon-btn sm on"
          title={order === "guide" ? "Order: guide" : "Order: A–Z"}
          onClick={() => setOrder(order === "guide" ? "alpha" : "guide")}
        >
          {ic(order === "guide" ? Route : ArrowDownAZ, 15)}
        </button>
        <button className={`icon-btn sm${hideSkip ? " on" : ""}`} title="Hide skippable" onClick={toggleHideSkip}>
          {ic(EyeOff, 15)}
        </button>
        <button className="icon-btn sm" title={allCollapsed ? "Expand all" : "Collapse all"} onClick={() => collapseAll(!allCollapsed, [...skipFiles])}>
          {ic(ChevronsDownUp, 15)}
        </button>
      </div>
      <div className={`files${hideSkip ? " hide-skip" : ""}`}>
        {ordered.map((f) => (
          <FileDiff key={f.path} file={skipFiles.has(f.path) && !f.skip ? { ...f, skip: "trivial" } : f} steps={fileSteps.get(f.path) ?? []} gutter={gutter} />
        ))}
      </div>
    </section>
  );
}
