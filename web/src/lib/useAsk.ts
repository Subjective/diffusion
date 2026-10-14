// Drag/select-to-ask controller: owns the bubble drag, text-selection detection, and ask-popup placement.
import { useEffect, useRef, useState } from "react";
import type { AskState } from "../components/AskPopup";
import { anchorFromRows, rangeText, rowInfo, rowsBetween, selectionRows } from "./selection";

function setSel(rows: HTMLElement[], on: boolean) {
  rows.forEach((r) => r.classList.toggle("sel", on));
}

export function useAsk() {
  const [ask, setAsk] = useState<AskState | null>(null);
  const drag = useRef<{ origin: HTMLElement; all: HTMLElement[]; end: HTMLElement; tip: HTMLElement; sel: HTMLElement[]; x: number; y: number; timer: number } | null>(null);

  const clearSel = () => {
    document.querySelectorAll<HTMLElement>("tr.sel").forEach((r) => r.classList.remove("sel"));
  };
  const open = (rows: HTMLElement[], x: number, y: number) => {
    const info = rows.map(rowInfo).filter((r): r is NonNullable<typeof r> => !!r);
    const anchor = anchorFromRows(info);
    if (!anchor) return;
    clearSel();
    setSel(rows, true);
    setAsk({ anchor, x, y });
  };
  const close = () => {
    clearSel();
    setAsk(null);
  };

  useEffect(() => {
    // Listen on the document: the diff pane mounts only after the PR loads.
    const inDiff = (e: Event) => !!(e.target as HTMLElement | null)?.closest?.(".diffpane");
    const pane = () => document.querySelector<HTMLElement>(".diffpane");

    const paint = (x: number, y: number) => {
      const d = drag.current!;
      d.x = x;
      d.y = y;
      const r = document.elementFromPoint(x, y)?.closest<HTMLElement>("tr.ln");
      if (r && d.all.includes(r)) d.end = r;
      setSel(d.sel, false);
      d.sel = rowsBetween(d.origin, d.end);
      setSel(d.sel, true);
      const info = d.sel.map(rowInfo).filter((i): i is NonNullable<typeof i> => !!i);
      const nums = info.map((i) => (i.type === "del" ? i.old : i.new)).filter((n): n is number => n != null);
      d.tip.textContent = nums.length ? rangeText(Math.min(...nums), Math.max(...nums)) : "";
      d.tip.style.left = `${x + 14}px`;
      d.tip.style.top = `${y - 10}px`;
    };
    const autoscroll = () => {
      const d = drag.current;
      const p = pane();
      if (!d || !p) return;
      const b = p.getBoundingClientRect();
      const dy = d.y < b.top + 110 ? -14 : d.y > b.bottom - 40 ? 14 : 0;
      if (dy) {
        p.scrollTop += dy;
        paint(d.x, d.y);
      }
    };
    const end = () => {
      const d = drag.current;
      if (!d) return;
      clearInterval(d.timer);
      d.tip.remove();
      d.origin.classList.remove("drag-origin");
      document.body.classList.remove("dragging");
      drag.current = null;
    };

    const onDown = (e: MouseEvent) => {
      if (!inDiff(e)) return;
      const btn = (e.target as HTMLElement).closest(".ask-btn");
      if (!btn || e.button !== 0) return;
      e.preventDefault();
      close();
      getSelection()?.removeAllRanges();
      const origin = btn.closest<HTMLElement>("tr.ln")!;
      const table = origin.closest("table")!;
      const tip = document.body.appendChild(Object.assign(document.createElement("div"), { className: "drag-tip" }));
      drag.current = { origin, all: [...table.querySelectorAll<HTMLElement>("tr.ln")], end: origin, tip, sel: [], x: e.clientX, y: e.clientY, timer: 0 };
      document.body.classList.add("dragging");
      origin.classList.add("drag-origin");
      paint(e.clientX, e.clientY);
      drag.current.timer = setInterval(autoscroll, 16) as unknown as number;
    };
    const onMove = (e: MouseEvent) => drag.current && paint(e.clientX, e.clientY);
    const onUp = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const rows = d.sel.length ? d.sel : [d.origin];
      end();
      open(rows, e.clientX, e.clientY);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (drag.current || !inDiff(e)) return;
      setTimeout(() => {
        const rows = selectionRows(getSelection());
        if (rows) open(rows, e.clientX, e.clientY);
      }, 0);
    };

    document.addEventListener("mousedown", onDown);
    addEventListener("mousemove", onMove);
    addEventListener("mouseup", onUp);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousedown", onDown);
      removeEventListener("mousemove", onMove);
      removeEventListener("mouseup", onUp);
      document.removeEventListener("mouseup", onMouseUp);
      end();
    };
  }, []);

  return { ask, close };
}
