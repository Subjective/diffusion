import { forwardRef, type ReactNode, useId } from "react";
import { edgePath, type Layout, type PlacedBlock } from "../lib/layout";
import { type HunkIndex, rowsForRef } from "../lib/refs";
import type { Block } from "../types";

export type Change = "added" | "removed" | "changed" | "context";

/** What a block's refs did, from the diff: never written by the agent. No refs means unchanged context. */
export function changeOf(b: Block, idx: HunkIndex): Change {
  const types = new Set(b.refs.flatMap((r) => rowsForRef(r, idx)).map((r) => r.type));
  if (!types.size) return "context";
  types.delete("ctx");
  if (types.size === 1 && types.has("add")) return "added";
  if (types.size === 1 && types.has("del")) return "removed";
  return "changed";
}

export interface MapCanvasProps {
  layout: Layout;
  idx: HunkIndex;
  /** Blocks the current scene lights; the rest dim. Null lights everything. */
  lit?: Set<string> | null;
  /** The block whose lines are pinned in the diff. */
  on?: string | null;
  hover?: string | null;
  className?: string;
  viewBox?: string;
  onEnter?: (b: PlacedBlock, el: SVGGElement) => void;
  onLeave?: () => void;
  onPick?: (b: PlacedBlock) => void;
  children?: ReactNode;
}

/** A view drawn as SVG: regions, arrows, then boxes with their step number and what changed. */
export const MapCanvas = forwardRef<SVGSVGElement, MapCanvasProps>(function MapCanvas(
  { layout, idx, lit = null, on = null, hover = null, className = "", viewBox, onEnter, onLeave, onPick },
  ref,
) {
  const uid = useId().replace(/:/g, "");
  const isLit = (id: string) => !lit || lit.has(id);
  const marker = (k: string) => (
    <marker
      key={k}
      id={`m${k}${uid}`}
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="6"
      markerHeight="6"
      orient="auto-start-reverse"
    >
      <path className={`mk ${k}`} d="M0 1 L9 5 L0 9z" />
    </marker>
  );
  return (
    <svg
      ref={ref}
      className={`map-svg${lit ? " dim" : ""} ${className}`}
      viewBox={viewBox ?? `0 0 ${Math.max(layout.width, 1)} ${Math.max(layout.height, 1)}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>{["call", "data", "event", "error"].map(marker)}</defs>
      {layout.blocks
        .filter((b) => b.kind === "region")
        .map((b) => (
          <g key={b.id} className={`m-region${isLit(b.id) ? " lit" : ""}`} data-id={b.id}>
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={14} />
            <text x={b.x + 14} y={b.y + 20}>
              {b.label}
            </text>
          </g>
        ))}
      {layout.arrows.map((a, i) => {
        const l = isLit(a.from) && isLit(a.to);
        return (
          <g key={i} className={`m-arrow ${a.kind}${l ? " lit" : ""}`}>
            <path d={edgePath(a.points)} markerEnd={`url(#m${a.kind}${uid})`} />
            {a.label && a.labelPos && (
              <text x={a.labelPos.x} y={a.labelPos.y + 4} textAnchor="middle">
                {a.label}
              </text>
            )}
          </g>
        );
      })}
      {layout.blocks
        .filter((b) => b.kind === "box")
        .map((b) => {
          const change = changeOf(b, idx);
          const cls = ["m-box", change, isLit(b.id) && "lit", on === b.id && "on", hover === b.id && "hover"]
            .filter(Boolean)
            .join(" ");
          const cy = b.y + b.h / 2;
          return (
            <g
              key={b.id}
              className={cls}
              data-id={b.id}
              onMouseEnter={(e) => onEnter?.(b, e.currentTarget)}
              onMouseLeave={() => onLeave?.()}
              onClick={() => onPick?.(b)}
            >
              <title>{b.label}</title>
              <rect className="b" x={b.x} y={b.y} width={b.w} height={b.h} rx={8} />
              {b.step != null && (
                <g className="num">
                  <circle cx={b.x + 18} cy={cy} r={8.5} />
                  <text x={b.x + 18} y={cy + 3.3}>
                    {b.step}
                  </text>
                </g>
              )}
              <text className="lab" x={b.x + (b.step != null ? 34 : 14)} y={cy + 4}>
                {b.label}
              </text>
              {(change === "added" || change === "changed" || change === "removed") && (
                <g className={`chg ${change}`}>
                  <circle cx={b.x + b.w} cy={b.y} r={7.5} />
                  <text x={b.x + b.w} y={b.y + (change === "changed" ? 2.4 : 3.5)}>
                    {change === "added" ? "+" : change === "removed" ? "−" : "●"}
                  </text>
                </g>
              )}
            </g>
          );
        })}
    </svg>
  );
});
