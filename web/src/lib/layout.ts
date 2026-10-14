import dagre from "@dagrejs/dagre";
import type { FlowEdge, FlowNode } from "../types";

export interface PlacedNode extends FlowNode {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PlacedEdge extends FlowEdge {
  points: { x: number; y: number }[];
  labelPos?: { x: number; y: number };
}
export interface Layout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

const NODE_H = 28;
const CHAR_W = 6.9; // 11.5px mono
const PAD = 40; // number badge + padding

export const nodeWidth = (label: string) => Math.round(PAD + label.length * CHAR_W);

/** Top-to-bottom layered layout. Coordinates are top-left for nodes, absolute for edge points. */
export function layoutFlow(nodes: FlowNode[], edges: FlowEdge[]): Layout {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "TB", nodesep: 18, ranksep: 30, edgesep: 10, marginx: 8, marginy: 6 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: nodeWidth(n.label), height: NODE_H });
  edges.forEach((e, i) => {
    if (g.hasNode(e.from) && g.hasNode(e.to) && e.from !== e.to)
      g.setEdge(e.from, e.to, { width: e.label ? e.label.length * 6 + 6 : 0, height: e.label ? 12 : 0, labelpos: "c" }, String(i));
  });
  dagre.layout(g);

  const placed: PlacedNode[] = nodes.map((n) => {
    const d = g.node(n.id);
    return { ...n, x: d.x - d.width / 2, y: d.y - d.height / 2, w: d.width, h: d.height };
  });
  const placedEdges: PlacedEdge[] = [];
  edges.forEach((e, i) => {
    const d = g.edge({ v: e.from, w: e.to, name: String(i) });
    if (!d) return;
    placedEdges.push({ ...e, points: d.points, labelPos: e.label && d.x != null ? { x: d.x, y: d.y } : undefined });
  });
  const graph = g.graph();
  return { nodes: placed, edges: placedEdges, width: graph.width ?? 0, height: graph.height ?? 0 };
}

/** Smooth path through dagre's control points. */
export function edgePath(points: { x: number; y: number }[]): string {
  if (!points.length) return "";
  if (points.length < 3) return `M${points[0].x},${points[0].y} L${points[points.length - 1].x},${points[points.length - 1].y}`;
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], q = points[i + 1];
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
    d += ` Q${p.x},${p.y} ${i === points.length - 2 ? `${q.x},${q.y}` : `${mx},${my}`}`;
  }
  return d;
}
