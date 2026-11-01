import {
  ArrowDownAZ,
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronsDownUp,
  EyeOff,
  FolderTree,
  MessageCircle,
  Route,
} from "lucide-react";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { backStack, wordAtPoint } from "../lib/definition";
import { focusScrollTop, measureRows, mergeSpans } from "../lib/focus";
import { indexFiles, rowKey, rowsForRef } from "../lib/refs";
import { useApp } from "../store";
import type { FileDiff as FD, Guide, Ref } from "../types";
import { markDiffActivity, useUI } from "../ui";
import { type AskComment, commentRows } from "./Comments";
import { type Dot, FileDiff, type Gutter } from "./FileDiff";
import { FileRail, fileInView } from "./FileRail";
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

/** What a closed diff shrinks to, beside the chat. */
export function DiffRail() {
  const count = useApp((s) => s.pr?.changed_files ?? 0);
  return (
    <button type="button" className="diff-rail" title="Open the diff" onClick={() => useUI.getState().openDiff(true)}>
      {ic(ArrowLeftToLine, 15)}
      <span>
        Diff · {count} {count === 1 ? "file" : "files"}
      </span>
    </button>
  );
}

export function DiffPane({ extras, onAskComment }: { extras?: Gutter["extras"]; onAskComment: AskComment }) {
  const { files, guide } = useApp();
  const { order, setOrder, hideSkip, toggleHideSkip, collapseAll, scrollTo, rail, toggleRail } = useUI();
  const { hideComments, toggleHideComments, resolved } = useUI();
  const scroller = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<string | null>(null);

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
      const p = scroller.current;
      const first = p?.querySelector<HTMLElement>(`tr[data-rk="${CSS.escape(scrollTo.keys[0])}"]`);
      if (!p || !first) return;
      const file = first.closest<HTMLElement>(".file");
      const header = file?.querySelector<HTMLElement>(".file-h")?.offsetHeight ?? 0;
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

  // Go to definition: ⌘/Ctrl-click a name. Holding the key underlines names; ⌘[ returns from a jump.
  useEffect(() => {
    const mod = (e: KeyboardEvent) => document.body.classList.toggle("nav-mod", e.metaKey || e.ctrlKey);
    const onKey = (e: KeyboardEvent) => {
      mod(e);
      if ((e.metaKey || e.ctrlKey) && e.key === "[" && backStack.length) {
        e.preventDefault();
        scroller.current?.scrollTo({ top: backStack.pop(), behavior: "smooth" });
      }
    };
    const off = () => document.body.classList.remove("nav-mod");
    addEventListener("keydown", onKey);
    addEventListener("keyup", mod);
    addEventListener("blur", off);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("keyup", mod);
      removeEventListener("blur", off);
    };
  }, []);
  const onNavClick = (e: React.MouseEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>("tr.ln");
    if (!row || !(e.target as HTMLElement).closest(".src")) return;
    const symbol = wordAtPoint(e.clientX, e.clientY) ?? (e.target as HTMLElement).textContent?.trim();
    if (!symbol || !/^[A-Za-z_$][\w$]*$/.test(symbol)) return;
    e.preventDefault();
    e.stopPropagation();
    useUI.getState().setPeek({ rk: row.dataset.rk!, file: row.dataset.file!, symbol });
  };

  // Track the file in view for the rail, once per frame while scrolling.
  useEffect(() => {
    const p = scroller.current;
    if (!p || !rail) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setCurrent(fileInView(p));
    };
    const onScroll = () => {
      frame ||= requestAnimationFrame(update);
    };
    update();
    p.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      p.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [rail]);

  const pickFile = (path: string) => {
    useUI.getState().toggleCollapsed(path, false);
    requestAnimationFrame(() => {
      const p = scroller.current;
      const f = p?.querySelector<HTMLElement>(`.file[data-path="${CSS.escape(path)}"]`);
      if (!p || !f) return;
      p.scrollTo({ top: p.scrollTop + f.getBoundingClientRect().top - p.getBoundingClientRect().top - 12 });
      setCurrent(path);
    });
  };

  const comments = guide?.comments ?? [];
  const open = comments.filter((c) => !resolved[c.title]).length;
  const after = useMemo(
    () => (hideComments ? undefined : commentRows(guide?.comments ?? [], idx, resolved, onAskComment)),
    [guide, idx, resolved, hideComments, onAskComment],
  );
  const gutter: Gutter = useMemo(() => ({ dots, extras, after }), [dots, extras, after]);
  const allCollapsed = useUI((s) => files.length > 0 && files.every((f) => s.collapsed[f.path]));

  return (
    <section
      className="diffpane"
      id="diffPane"
      onWheel={markDiffActivity}
      onTouchMove={markDiffActivity}
      onMouseDown={markDiffActivity}
      onKeyDown={markDiffActivity}
    >
      <div className="toolbar">
        <button type="button" className={`icon-btn sm${rail ? " on" : ""}`} title="Files" onClick={toggleRail}>
          {ic(FolderTree, 15)}
        </button>
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
        {comments.length > 0 && (
          <button
            type="button"
            className={`icon-btn sm cmt-tg${hideComments ? "" : " on"}`}
            title={hideComments ? "Show comments" : "Hide comments"}
            onClick={toggleHideComments}
          >
            {ic(MessageCircle, 15)}
            {open > 0 && <span>{open}</span>}
          </button>
        )}
        <button
          type="button"
          className="icon-btn sm"
          title={allCollapsed ? "Expand all" : "Collapse all"}
          onClick={() => collapseAll(!allCollapsed, [...skipFiles])}
        >
          {ic(ChevronsDownUp, 15)}
        </button>
        <button
          type="button"
          className="icon-btn sm"
          title="Collapse the diff"
          onClick={() => useUI.getState().openDiff(false)}
        >
          {ic(ArrowRightToLine, 15)}
        </button>
      </div>
      <div className="diff-body">
        {rail && <FileRail files={files} skip={skipFiles} fileSteps={fileSteps} current={current} onPick={pickFile} />}
        <div className="diffwrap">
          <div className="diff-scroll" ref={scroller} onClickCapture={onNavClick}>
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
          </div>
          <ScrollMarks pane={scroller} />
        </div>
      </div>
    </section>
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
