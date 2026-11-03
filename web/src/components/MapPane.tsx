import { ChevronLeft, ChevronRight, FileCode, Maximize, Minus, Plus } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { easeInOut, easeOut, fromTrackpad, lerpVB, type VB, zoomVB } from "../lib/camera";
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
  /** Where the camera is easing to, while it moves; wheel zooms add to it so fast notches stay smooth. */
  const goal = useRef<VB | null>(null);
  /** Whether the reader has panned or zoomed since the camera last framed the stop. */
  const moved = useRef(false);
  const raf = useRef(0);

  const setVB = useCallback((v: VB) => {
    vb.current = v;
    svg.current?.setAttribute("viewBox", v.join(" "));
  }, []);
  const halt = useCallback(() => {
    cancelAnimationFrame(raf.current);
    goal.current = null;
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
  /** Ease the camera to `to` over `ms`, or jump there when there's nowhere to ease from. */
  const camera = useCallback(
    (to: VB | null, ms = 650, ease = easeInOut) => {
      if (!to) return;
      halt();
      const from = vb.current;
      if (!ms || !from || reduceMotion()) return setVB(to);
      goal.current = to;
      const t0 = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - t0) / ms);
        setVB(lerpVB(from, to, ease(t)));
        if (t < 1) raf.current = requestAnimationFrame(tick);
        else goal.current = null;
      };
      raf.current = requestAnimationFrame(tick);
    },
    [setVB, halt],
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
    (ms?: number) => {
      const b = stopBox(stop);
      if (!b) return;
      moved.current = false;
      camera(frame(b), ms);
    },
    [stop, stopBox, camera, frame],
  );
  const frameNow = useRef(frameStop);
  frameNow.current = frameStop;

  // A view opens on the scene for the step pinned in the steps, if it has one, else on its overview.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the view changes.
  useEffect(() => {
    const step = useUI.getState().pinStep;
    const i = step == null ? 0 : stops.findIndex((s) => !s.overview && s.step === step);
    setAt(Math.max(0, i));
    setOn(null);
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
  // Frame the stop, easing from wherever the camera is; the first paint just lands there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-frame only when the stop changes.
  useLayoutEffect(() => {
    frameStop(vb.current ? undefined : 0);
  }, [stop, layout]);
  // When the pane resizes (the diff opens beside it, or a splitter drags), keep what's on screen where it is,
  // then ease to a fresh framing of the stop unless the reader has moved the camera themselves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pane mounts with the first layout.
  useEffect(() => {
    const p = pane.current;
    if (!p || typeof ResizeObserver === "undefined") return;
    let size = [p.clientWidth, p.clientHeight];
    let later = 0;
    const ro = new ResizeObserver(() => {
      const [w, h] = [p.clientWidth, p.clientHeight];
      const v = vb.current;
      if (!w || !h || (w === size[0] && h === size[1])) return;
      if (v && size[0] && size[1]) {
        halt();
        setVB([v[0], v[1], (v[2] * w) / size[0], (v[3] * h) / size[1]]);
      }
      size = [w, h];
      clearTimeout(later);
      if (!moved.current) later = window.setTimeout(() => frameNow.current(vb.current ? 450 : 0), 120);
    });
    ro.observe(p);
    return () => {
      ro.disconnect();
      clearTimeout(later);
    };
  }, [halt, setVB, !layout]);

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
    if (b.refs.length) useUI.getState().openDiff(true);
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

  // A mouse wheel zooms about the pointer, a trackpad pinch zooms (it arrives as a wheel event with ctrlKey), and
  // two fingers on a trackpad pan. Dragging anywhere pans.
  const trackpad = useRef({ on: false, t: 0 });
  useEffect(() => {
    const p = pane.current;
    if (!p) return;
    const onWheel = (e: WheelEvent) => {
      const v = vb.current;
      if (!v) return;
      e.preventDefault();
      setPeek(null);
      moved.current = true;
      // A gesture keeps the device it started with, so a trackpad's momentum never turns into zooming.
      const g = trackpad.current;
      const now = performance.now();
      g.on = (now - g.t < 300 && g.on) || fromTrackpad(e as WheelEvent & { wheelDeltaY?: number });
      g.t = now;
      const r = p.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const fy = (e.clientY - r.top) / r.height;
      // A pinch is a ctrl-wheel with small pixel deltas, whatever the device check says; ctrl + a mouse wheel
      // notch is far bigger and eases like any other notch below.
      if (e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaY) < 50) {
        halt();
        return setVB(zoomVB(v, Math.exp(e.deltaY * 0.01), fx, fy, ...zoomRange()));
      }
      if (g.on && !e.metaKey) {
        halt();
        return setVB([v[0] + (e.deltaX * v[2]) / r.width, v[1] + (e.deltaY * v[3]) / r.height, v[2], v[3]]);
      }
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * r.height : e.deltaY;
      zoomBy(Math.exp(Math.max(-250, Math.min(250, dy)) * 0.0018), fx, fy, 200);
    };
    // Safari reports a pinch as gesture events instead of ctrl-wheels.
    let scale = 1;
    const onGesture = (e: Event) => {
      const ge = e as Event & { scale: number; clientX: number; clientY: number };
      const v = vb.current;
      e.preventDefault();
      if (e.type === "gesturestart") scale = 1;
      if (!v || !ge.scale) return;
      halt();
      moved.current = true;
      const r = p.getBoundingClientRect();
      setVB(
        zoomVB(v, scale / ge.scale, (ge.clientX - r.left) / r.width, (ge.clientY - r.top) / r.height, ...zoomRange()),
      );
      scale = ge.scale;
    };
    p.addEventListener("wheel", onWheel, { passive: false });
    for (const t of ["gesturestart", "gesturechange"]) p.addEventListener(t, onGesture, { passive: false });
    return () => {
      p.removeEventListener("wheel", onWheel);
      for (const t of ["gesturestart", "gesturechange"]) p.removeEventListener(t, onGesture);
    };
  });
  /** How far the camera may zoom: from a tenth of the view's width (close) to four times it, or three pane-widths
   *  of a small view on a big screen (far). */
  const zoomRange = (): [number, number] => {
    const w = Math.max(layout?.width ?? 0, layout?.height ?? 0, 400);
    return [w / 10, Math.max(w * 4, (pane.current?.clientWidth ?? 0) * 3)];
  };
  /** Zoom by `k` about a point given as fractions of the pane, easing over `ms`. */
  const zoomBy = (k: number, fx = 0.5, fy = 0.5, ms = 260) => {
    const from = goal.current ?? vb.current;
    if (!from) return;
    moved.current = true;
    camera(zoomVB(from, k, fx, fy, ...zoomRange()), ms, easeOut);
  };
  const drag = useRef<{ x: number; y: number; v: VB; id: number; on: boolean } | null>(null);
  const dragged = useRef(false);
  const endDrag = () => {
    if (drag.current?.on) {
      dragged.current = true;
      setTimeout(() => {
        dragged.current = false;
      });
    }
    drag.current = null;
    document.body.classList.remove("map-panning");
  };

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
      onMouseDown={(e) => {
        // Pressing the map never starts a text selection; it still takes focus from an input, like a click would.
        if ((e.target as Element).closest(".map-float")) return;
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.();
      }}
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as Element).closest(".map-float") || !vb.current) return;
        drag.current = { x: e.clientX, y: e.clientY, v: vb.current, id: e.pointerId, on: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        const p = pane.current;
        if (!d || !p) return;
        // A press on a box only becomes a drag once it moves a few pixels, so clicks still pick the box.
        if (!d.on) {
          if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
          d.on = true;
          halt();
          d.v = vb.current ?? d.v;
          d.x = e.clientX;
          d.y = e.clientY;
          moved.current = true;
          setPeek(null);
          document.body.classList.add("map-panning");
          p.setPointerCapture?.(d.id);
        }
        const r = p.getBoundingClientRect();
        setVB([
          d.v[0] - ((e.clientX - d.x) / r.width) * d.v[2],
          d.v[1] - ((e.clientY - d.y) / r.height) * d.v[3],
          d.v[2],
          d.v[3],
        ]);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClickCapture={(e) => {
        if (dragged.current) e.stopPropagation();
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
        <button type="button" className="icon-btn sm" title="Zoom in" onClick={() => zoomBy(0.75)}>
          {ic(Plus, 15)}
        </button>
        <button type="button" className="icon-btn sm" title="Zoom out" onClick={() => zoomBy(1 / 0.75)}>
          {ic(Minus, 15)}
        </button>
        <button type="button" className="icon-btn sm" title="Fit" onClick={() => frameStop()}>
          {ic(Maximize, 15)}
        </button>
      </div>
      <div className="map-float map-card" ref={card}>
        {stops.length > 1 && (
          <div className="map-card-h">
            <span className="map-count">
              {at}/{stops.length - 1}
            </span>
            <span className="progress">
              <i style={{ width: `${(at / (stops.length - 1)) * 100}%` }} />
            </span>
            <span className="grow" />
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
          </div>
        )}
        <div className="map-card-b" key={`${vi}:${at}`}>
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
