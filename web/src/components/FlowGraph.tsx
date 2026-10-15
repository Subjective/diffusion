import { useId, useMemo } from "react";
import { edgePath, layoutFlow } from "../lib/layout";
import { useStepLinking } from "../lib/linking";
import { useApp } from "../store";
import { useUI } from "../ui";

export function FlowGraph() {
  const uid = useId().replace(/:/g, "");
  const flow = useApp((s) => s.guide?.flow);
  const hoverStep = useUI((s) => s.hoverStep);
  const pinStep = useUI((s) => s.pinStep);
  const hoverSub = useUI((s) => s.hoverSub);
  const pinSub = useUI((s) => s.pinSub);
  const link = useStepLinking();
  const layout = useMemo(() => (flow ? layoutFlow(flow.nodes, flow.edges) : null), [flow]);
  if (!layout?.nodes.length) return null;

  return (
    <div className="flow">
      <svg
        viewBox={`0 0 ${Math.max(layout.width, 1)} ${Math.max(layout.height, 1)}`}
        style={{ maxHeight: 360 }}
        onMouseLeave={() => link.hover(null)}
      >
        <defs>
          <marker
            id={`fa${uid}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path className="mk" d="M0 1 L9 5 L0 9z" />
          </marker>
          <marker
            id={`fae${uid}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path className="mk err" d="M0 1 L9 5 L0 9z" />
          </marker>
        </defs>
        {layout.edges.map((e, i) => {
          const err = e.kind === "error";
          return (
            <g key={i}>
              <path
                className={`fe${err ? " err" : ""}`}
                d={edgePath(e.points)}
                markerEnd={`url(#${err ? "fae" : "fa"}${uid})`}
              />
              {e.label && e.labelPos && (
                <text className={`fl${err ? " err" : ""}`} x={e.labelPos.x} y={e.labelPos.y + 3} textAnchor="middle">
                  {e.label}
                </text>
              )}
            </g>
          );
        })}
        {layout.nodes.map((n) => {
          const sub = n.substep ?? null;
          const match = (st: number | null, sb: number | null) => st === n.step && (sub == null || sb === sub);
          const cls = ["fn", match(hoverStep, hoverSub) && "hover", match(pinStep, pinSub) && "active"]
            .filter(Boolean)
            .join(" ");
          return (
            <g
              key={n.id}
              className={cls}
              data-step={n.step}
              onMouseEnter={() => link.hover(n.step, sub)}
              onClick={() => link.focus(n.step, sub)}
            >
              <title>{n.label}</title>
              <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={8} />
              <g className="num">
                <circle cx={n.x + 15} cy={n.y + 14} r={8} />
                <text x={n.x + 15} y={n.y + 17.5}>
                  {sub == null ? n.step : `${n.step}.${sub}`}
                </text>
              </g>
              <text x={n.x + 29} y={n.y + 18}>
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
