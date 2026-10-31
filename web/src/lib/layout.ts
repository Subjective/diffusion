import dagre from "@dagrejs/dagre";
import type { Arrow, Block, View } from "../types";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PlacedBlock extends Block, Box {}
export interface PlacedArrow extends Arrow {
  points: { x: number; y: number }[];
  labelPos?: { x: number; y: number };
}
export interface Layout {
  blocks: PlacedBlock[];
  arrows: PlacedArrow[];
  width: number;
  height: number;
}

const BOX_H = 36;
const CHAR_W = 7.6; // 12.5px mono
const PAD = 28;
const BADGE = 26; // step number
const REGION_LABEL = 22; // room above a region's boxes for its name

export const boxWidth = (b: Block) => Math.round(PAD + (b.step != null ? BADGE : 0) + b.label.length * CHAR_W);

/** Top-to-bottom layered layout; regions are dagre clusters around their boxes. Coordinates are top-left for
 *  blocks, absolute for arrow points. */
export function layoutView(view: View): Layout {
  const g = new dagre.graphlib.Graph({ multigraph: true, compound: true });
  g.setGraph({ rankdir: "TB", nodesep: 28, ranksep: 56, edgesep: 12, marginx: 16, marginy: 16 + REGION_LABEL });
  g.setDefaultEdgeLabel(() => ({}));
  const regions = new Set(view.blocks.filter((b) => b.kind === "region").map((b) => b.id));
  for (const b of view.blocks) {
    if (b.kind === "region") g.setNode(b.id, { paddingTop: REGION_LABEL + 10, paddingBottom: 14, paddingX: 14 });
    else g.setNode(b.id, { width: boxWidth(b), height: BOX_H });
  }
  for (const b of view.blocks) if (b.parent && regions.has(b.parent)) g.setParent(b.id, b.parent);
  view.arrows.forEach((a, i) => {
    // dagre can't route edges to clusters; arrows to a region are drawn but don't shape the layout.
    if (a.from === a.to || regions.has(a.from) || regions.has(a.to)) return;
    g.setEdge(
      a.from,
      a.to,
      { width: a.label ? a.label.length * 6.6 + 8 : 0, height: a.label ? 14 : 0, labelpos: "c" },
      String(i),
    );
  });
  // A region with no boxes would have no size.
  for (const r of regions) if (!g.children(r)?.length) g.setNode(r, { width: 120, height: BOX_H });
  dagre.layout(g);

  const blocks: PlacedBlock[] = view.blocks.map((b) => {
    const d = g.node(b.id);
    if (b.kind === "region" && g.children(b.id)?.length) {
      // dagre fits clusters tightly; make room for the region's name above its boxes.
      return {
        ...b,
        x: d.x - d.width / 2,
        y: d.y - d.height / 2 - REGION_LABEL,
        w: d.width,
        h: d.height + REGION_LABEL,
      };
    }
    return { ...b, x: d.x - d.width / 2, y: d.y - d.height / 2, w: d.width, h: d.height };
  });
  const at = new Map(blocks.map((b) => [b.id, b]));
  const arrows: PlacedArrow[] = [];
  view.arrows.forEach((a, i) => {
    const d = g.edge({ v: a.from, w: a.to, name: String(i) });
    if (d) {
      arrows.push({ ...a, points: d.points, labelPos: a.label && d.x != null ? { x: d.x, y: d.y } : undefined });
      return;
    }
    const s = at.get(a.from);
    const t = at.get(a.to);
    if (s && t && s !== t) arrows.push({ ...a, points: straight(s, t) });
  });
  const graph = g.graph();
  return { blocks, arrows, width: graph.width ?? 0, height: graph.height ?? 0 };
}

/** A straight arrow between two boxes' edges, for arrows dagre didn't route. */
function straight(s: Box, t: Box) {
  const c = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const a = c(s);
  const b = c(t);
  const clip = (from: { x: number; y: number }, to: { x: number; y: number }, box: Box) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const k = Math.min(Math.abs(box.w / 2 / (dx || 1e-9)), Math.abs(box.h / 2 / (dy || 1e-9)));
    return { x: from.x + dx * k, y: from.y + dy * k };
  };
  return [clip(a, b, s), clip(b, a, t)];
}

/** The box around some blocks, with a margin. */
export function boundsOf(blocks: Box[], margin = 0): Box {
  if (!blocks.length) return { x: 0, y: 0, w: 1, h: 1 };
  const x0 = Math.min(...blocks.map((b) => b.x));
  const y0 = Math.min(...blocks.map((b) => b.y));
  const x1 = Math.max(...blocks.map((b) => b.x + b.w));
  const y1 = Math.max(...blocks.map((b) => b.y + b.h));
  return { x: x0 - margin, y: y0 - margin, w: x1 - x0 + 2 * margin, h: y1 - y0 + 2 * margin };
}

/** Smooth path through dagre's control points. */
export function edgePath(points: { x: number; y: number }[]): string {
  if (!points.length) return "";
  if (points.length < 3)
    return `M${points[0].x},${points[0].y} L${points[points.length - 1].x},${points[points.length - 1].y}`;
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i],
      q = points[i + 1];
    const mx = (p.x + q.x) / 2,
      my = (p.y + q.y) / 2;
    d += ` Q${p.x},${p.y} ${i === points.length - 2 ? `${q.x},${q.y}` : `${mx},${my}`}`;
  }
  return d;
}
