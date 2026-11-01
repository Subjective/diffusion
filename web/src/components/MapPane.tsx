import { ChevronLeft, ChevronRight, FileCode, Maximize, Minus, Plus } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Box, boundsOf, layoutView, type PlacedBlock } from "../lib/layout";
import { refsOf, refsTarget, useHunkIndex } from "../lib/linking";
import { Inline } from "../lib/md";
import { MAP_W, startResize } from "../lib/panes";
import { type HunkIndex, rowsForRef } from "../lib/refs";
import { storage } from "../lib/storage";
import { useApp } from "../store";
import type { Block, Ref, Scene } from "../types";
import { useUI } from "../ui";
import { ic } from "./icons";
import { MapCanvas } from "./MapCanvas";

type VB = [number, number, number, number];
const reduceMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The map: a view of the change in the guide pane's place. j/k (or ←/→) walk its scenes with an animated camera,
 *  h/l step through the lit blocks' lines in the diff, and hovering a block peeks at every range it cites. */
export function MapPane({ onWidth }: { onWidth?: (w: number) => void }) {
  return (
    <div className="guide-wrap">
      <MapBody />
      {onWidth && (
        <div
          className="resizer right"
          title="Drag to resize · double-click to reset"
          onDoubleClick={() => {
            onWidth(MAP_W);
            storage.set("rv-map-w", MAP_W);
          }}
          onMouseDown={(e) => {
            const left = e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
            startResize(e, (x) => x - left, onWidth, "rv-map-w");
          }}
        />
      )}
    </div>
  );
}

interface Stop extends Scene {
  overview?: boolean;
}

function MapBody() {
  const guide = useApp((s) => s.guide);
  const idx = useHunkIndex();
  const views = guide?.views ?? [];
  const [vi, setVi] = useState(0);
  const view = views[Math.min(vi, views.length - 1)];
  const layout = useMemo(() => (view ? layoutView(view) : null), [view]);
  // The first stop frames the whole view; the agent's scenes follow.
  const stops: Stop[] = useMemo(
    () =>
      view
        ? [
            {
              title: view.title,
              text: vi === 0 ? (guide?.tldr ?? "") : "",
              blocks: view.blocks.map((b) => b.id),
              overview: true,
            },
            ...view.scenes,
          ]
        : [],
    [view, vi, guide?.tldr],
  );
  const [at, setAt] = useState(0);
  const stop = stops[Math.min(at, stops.length - 1)];
  const [on, setOn] = useState<string | null>(null);
  const [peek, setPeek] = useState<{ block: Block; x: number; y: number; below: boolean } | null>(null);
  const hl = useRef<{ targets: { keys: string[]; files: string[] }[]; i: number | null }>({ targets: [], i: null });

  const pane = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const vb = useRef<VB | null>(null);
  const raf = useRef(0);

  const setVB = useCallback((v: VB) => {
    vb.current = v;
    svg.current?.setAttribute("viewBox", v.join(" "));
  }, []);
  /** The viewBox that shows `box` in the part of the pane the scene card doesn't cover. */
  const frame = useCallback((box: Box): VB | null => {
    const p = pane.current;
    if (!p?.clientWidth) return null;
    const W = p.clientWidth;
    const H = p.clientHeight;
    const left = 20;
    const right = 60;
    const top = 56;
    const bottom = (card.current?.offsetHeight ?? 0) + 32;
    const aw = Math.max(40, W - left - right);
    const ah = Math.max(40, H - top - bottom);
    const s = Math.min(aw / box.w, ah / box.h, 1.1);
    return [box.x - left / s - (aw / s - box.w) / 2, box.y - top / s - (ah / s - box.h) / 2, W / s, H / s];
  }, []);
  const camera = useCallback(
    (to: VB | null, animate = true) => {
      if (!to) return;
      cancelAnimationFrame(raf.current);
      const from = vb.current;
      if (!animate || !from || reduceMotion()) return setVB(to);
      const t0 = performance.now();
      const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
      const tick = (now: number) => {
        const k = ease(Math.min(1, (now - t0) / 600));
        setVB(from.map((f, i) => f + (to[i] - f) * k) as VB);
        if (k < 1) raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    },
    [setVB],
  );
  const stopBox = useCallback(
    (s: Stop | undefined) =>
      layout
        ? boundsOf(
            layout.blocks.filter((b) => !s || s.blocks.includes(b.id)),
            28,
          )
        : null,
    [layout],
  );
  const frameStop = useCallback(
    (animate = true) => {
      const b = stopBox(stop);
      if (b) camera(frame(b), animate);
    },
    [stop, stopBox, camera, frame],
  );

  // A view opens on the scene for the step pinned in the steps, if it has one, else on its overview.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the view changes.
  useEffect(() => {
    const step = useUI.getState().pinStep;
    const i = step == null ? 0 : stops.findIndex((s) => !s.overview && s.step === step);
    setAt(Math.max(0, i));
    setOn(null);
    vb.current = null;
    if (i > 0) pin(refsOfBlocks(stops[i].blocks));
  }, [view]);
  // Leaving the map on a step's scene pins that step for the steps view.
  const here = useRef({ stop, idx });
  here.current = { stop, idx };
  useEffect(
    () => () => {
      const { stop: last, idx: hunks } = here.current;
      const step = last?.step;
      const g = useApp.getState().guide;
      if (step == null || !g?.steps.some((s) => s.id === step)) return;
      const t = refsTarget(refsOf(g, step), hunks);
      useUI.setState({ pinStep: step, pinSub: null, pinRows: new Set(t.keys), refAt: null });
    },
    [],
  );
  // Frame the stop; animate between stops, but not on first paint or a resize.
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-frame only when the stop changes.
  useLayoutEffect(() => {
    frameStop(!first.current && vb.current != null);
    first.current = false;
  }, [stop, layout]);
  useEffect(() => {
    const p = pane.current;
    if (!p || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => frameStop(false));
    ro.observe(p);
    return () => ro.disconnect();
  }, [frameStop]);

  const refsOfBlocks = useCallback(
    (ids: string[]): Ref[] => {
      const out: Ref[] = [];
      for (const b of view?.blocks ?? [])
        if (ids.includes(b.id)) for (const r of b.refs) if (!out.includes(r)) out.push(r);
      return out;
    },
    [view],
  );
  /** Pin lines in the diff, and let h/l walk them one ref at a time. */
  const pin = useCallback(
    (refs: Ref[]) => {
      const t = refsTarget(refs, idx);
      hl.current = { targets: refs.map((r) => refsTarget([r], idx)).filter((x) => x.keys.length), i: null };
      if (t.keys.length) useUI.getState().focus(t.keys, t.files, null, null, true);
      else useUI.getState().clearPin();
    },
    [idx],
  );
  const go = useCallback(
    (i: number) => {
      const n = Math.max(0, Math.min(stops.length - 1, i));
      if (n === at) return;
      setAt(n);
      setOn(null);
      setPeek(null);
      if (stops[n].overview) {
        hl.current = { targets: [], i: null };
        useUI.getState().clearPin();
      } else pin(refsOfBlocks(stops[n].blocks));
    },
    [at, stops, pin, refsOfBlocks],
  );
  // Clicking a box opens the diff beside the map at its lines.
  const pick = (b: Block) => {
    setPeek(null);
    setOn(b.id);
    if (b.refs.length) useUI.getState().openCode(true);
    pin(b.refs);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/input|textarea|select/i.test((document.activeElement as HTMLElement)?.tagName ?? "")) return;
      if (e.key === "Escape") {
        setOn(null);
        useUI.getState().clearPin();
      } else if (e.key === "j" || e.key === "ArrowRight") go(at + 1);
      else if (e.key === "k" || e.key === "ArrowLeft") go(at - 1);
      else if (e.key === "h" || e.key === "l") {
        const { targets, i } = hl.current;
        if (!targets.length) return;
        const n = Math.max(
          0,
          Math.min(targets.length - 1, (i ?? (e.key === "l" ? -1 : targets.length)) + (e.key === "l" ? 1 : -1)),
        );
        if (n === i) return;
        hl.current.i = n;
        useUI.getState().showRef(n, targets[n].keys, targets[n].files);
      } else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [go, at]);

  // Trackpad: two-finger scroll pans, pinch zooms (a pinch arrives as a wheel event with ctrlKey). Mouse: the wheel
  // pans, ⌘/Ctrl + wheel zooms, dragging the background pans.
  useEffect(() => {
    const p = pane.current;
    if (!p) return;
    const onWheel = (e: WheelEvent) => {
      const v = vb.current;
      if (!v) return;
      e.preventDefault();
      cancelAnimationFrame(raf.current);
      const r = p.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey)
        return zoomAt(Math.exp(e.deltaY * (e.ctrlKey && !e.metaKey ? 0.01 : 0.0015)), e.clientX, e.clientY);
      const k = e.deltaMode === 1 ? 16 : 1;
      setVB([v[0] + (e.deltaX * k * v[2]) / r.width, v[1] + (e.deltaY * k * v[3]) / r.height, v[2], v[3]]);
    };
    p.addEventListener("wheel", onWheel, { passive: false });
    return () => p.removeEventListener("wheel", onWheel);
  });
  const zoomAt = (k: number, cx?: number, cy?: number) => {
    const p = pane.current;
    const v = vb.current;
    if (!p || !v) return;
    const r = p.getBoundingClientRect();
    const px = v[0] + (((cx ?? r.left + r.width / 2) - r.left) / r.width) * v[2];
    const py = v[1] + (((cy ?? r.top + r.height / 2) - r.top) / r.height) * v[3];
    cancelAnimationFrame(raf.current);
    setVB([px - (px - v[0]) * k, py - (py - v[1]) * k, v[2] * k, v[3] * k]);
  };
  const drag = useRef<{ x: number; y: number; v: VB } | null>(null);

  const enter = (b: PlacedBlock, el: SVGGElement) => {
    const keys = refsTarget(b.refs, idx).keys;
    useUI.getState().setHover(keys);
    const p = pane.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!p || !b.refs.length) return setPeek(null);
    const below = r.bottom - p.top < p.height * 0.55;
    setPeek({
      block: b,
      x: Math.max(12, Math.min(r.left - p.left, p.width - 492)),
      y: below ? r.bottom - p.top + 10 : p.bottom - r.top + 10,
      below,
    });
  };
  const leave = () => {
    useUI.getState().setHover([]);
    setPeek(null);
  };

  if (!view || !layout || !stop) return <aside className="guide map" />;
  const lit = stop.overview ? null : new Set(stop.blocks);
  return (
    <aside
      className="guide map"
      ref={pane}
      onPointerDown={(e) => {
        if ((e.target as Element).closest(".m-box, .map-float") || !vb.current) return;
        drag.current = { x: e.clientX, y: e.clientY, v: vb.current };
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        const p = pane.current;
        if (!d || !p) return;
        const r = p.getBoundingClientRect();
        setVB([
          d.v[0] - ((e.clientX - d.x) / r.width) * d.v[2],
          d.v[1] - ((e.clientY - d.y) / r.height) * d.v[3],
          d.v[2],
          d.v[3],
        ]);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
    >
      <MapCanvas
        ref={svg}
        layout={layout}
        idx={idx}
        lit={lit}
        on={on}
        hover={peek?.block.id ?? null}
        viewBox={vb.current?.join(" ")}
        onEnter={enter}
        onLeave={leave}
        onPick={pick}
      />
      {views.length > 1 && (
        <div className="map-float map-tabs" role="tablist">
          {views.map((v, i) => (
            <button
              type="button"
              key={v.id}
              role="tab"
              aria-selected={v === view}
              className={v === view ? "on" : ""}
              onClick={() => setVi(i)}
            >
              {v.title}
            </button>
          ))}
        </div>
      )}
      <div className="map-float map-zoom">
        <button type="button" className="icon-btn sm" title="Zoom in" onClick={() => zoomAt(0.8)}>
          {ic(Plus, 15)}
        </button>
        <button type="button" className="icon-btn sm" title="Zoom out" onClick={() => zoomAt(1.25)}>
          {ic(Minus, 15)}
        </button>
        <button type="button" className="icon-btn sm" title="Fit" onClick={() => frameStop()}>
          {ic(Maximize, 15)}
        </button>
      </div>
      <div className="map-float map-card" ref={card}>
        <div className="map-card-h">
          <span>
            {stops.length > 1 ? `${at === 0 ? "Overview" : `Scene ${at}`} of ${stops.length - 1}` : "Overview"}
          </span>
          <span className="grow" />
          {stops.length > 1 && (
            <>
              <span className="progress">
                <i style={{ width: `${(at / (stops.length - 1)) * 100}%` }} />
              </span>
              <button
                type="button"
                className="icon-btn sm"
                title="Previous (k or ←)"
                disabled={at === 0}
                onClick={() => go(at - 1)}
              >
                {ic(ChevronLeft, 15)}
              </button>
              <button
                type="button"
                className="icon-btn sm"
                title="Next (j or →)"
                disabled={at === stops.length - 1}
                onClick={() => go(at + 1)}
              >
                {ic(ChevronRight, 15)}
              </button>
            </>
          )}
        </div>
        <div className="map-card-t">
          {stop.step != null && <span className="dot">{stop.step}</span>}
          {stop.title}
        </div>
        {stop.text && (
          <p className="map-card-s">
            <Inline text={stop.text} />
          </p>
        )}
      </div>
      {peek && (
        <div
          className="map-peek"
          style={{ left: peek.x, ...(peek.below ? { top: peek.y } : { bottom: peek.y }) } as CSSProperties}
        >
          <BlockPeek block={peek.block} idx={idx} />
        </div>
      )}
    </aside>
  );
}

const MAX_PEEK_LINES = 10;

/** Every range a block cites, with its lines from the diff, like the go-to-definition peek. */
function BlockPeek({ block, idx }: { block: Block; idx: HunkIndex }) {
  return (
    <div className="peek" role="dialog" aria-label={block.label}>
      {block.refs.map((r, k) => {
        const h = idx.byId.get(r.hunk);
        const all = idx.rows.get(r.hunk) ?? [];
        const keep = new Set(rowsForRef(r, idx));
        const lines = all.flatMap((row, i) => (keep.has(row) && h ? [{ row, text: h.lines[i].text }] : []));
        const nums = lines.map((l) => l.row.new ?? l.row.old).filter((n): n is number => n != null);
        const path = h?.file ?? "";
        return (
          <div key={k}>
            <div className={`peek-h${k ? " next" : ""}`}>
              {ic(FileCode, 14)}
              <span className="path" title={path}>
                <span className="dir">{path.slice(0, path.lastIndexOf("/") + 1)}</span>
                {path.slice(path.lastIndexOf("/") + 1)}
              </span>
              {nums.length > 0 && (
                <span className="ln">
                  {Math.min(...nums)}
                  {Math.max(...nums) !== Math.min(...nums) && `–${Math.max(...nums)}`}
                </span>
              )}
            </div>
            <div className="peek-b">
              <table>
                <tbody>
                  {lines.slice(0, MAX_PEEK_LINES).map(({ row, text }, i) => (
                    <tr key={i} className={row.type}>
                      <td className="no">{row.new ?? row.old}</td>
                      <td className="src">{text || " "}</td>
                    </tr>
                  ))}
                  {lines.length > MAX_PEEK_LINES && (
                    <tr className="more">
                      <td className="no" />
                      <td className="src">… {lines.length - MAX_PEEK_LINES} more</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
