import type { View } from "../types";
import { boundsOf, boxWidth, edgePath, layoutView } from "./layout";

const view: View = {
  id: 1,
  title: "Overview",
  layout: "flow",
  blocks: [
    { id: "session", label: "session.ts", kind: "region", refs: [] },
    { id: "start", label: "start()", kind: "box", parent: "session", step: 1, refs: [] },
    { id: "sched", label: "scheduleRefresh()", kind: "box", parent: "session", step: 2, refs: [] },
    { id: "refresh", label: "refresh()", kind: "box", parent: "session", step: 2, refs: [] },
    { id: "end", label: "end()", kind: "box", refs: [] },
  ],
  arrows: [
    { from: "start", to: "sched", label: null, kind: "call" },
    { from: "sched", to: "refresh", label: "timer", kind: "event" },
    { from: "refresh", to: "end", label: "err", kind: "error" },
    { from: "end", to: "session", label: null, kind: "data" },
  ],
  scenes: [],
};

test("layout ranks boxes top-to-bottom, wraps regions around their boxes, and routes arrows", () => {
  const l = layoutView(view);
  const at = Object.fromEntries(l.blocks.map((b) => [b.id, b]));
  expect(at.start.y).toBeLessThan(at.sched.y);
  expect(at.sched.y).toBeLessThan(at.refresh.y);
  expect(at.refresh.y).toBeLessThan(at.end.y);
  for (const id of ["start", "sched", "refresh"]) {
    const b = at[id];
    const r = at.session;
    expect(b.x >= r.x && b.y >= r.y + 20 && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h).toBe(true);
  }
  expect(at.end.y).toBeGreaterThanOrEqual(at.session.y + at.session.h);
  expect(l.arrows).toHaveLength(4); // the arrow to a region is drawn straight
  expect(l.arrows.every((a) => a.points.length >= 2)).toBe(true);
  expect(l.arrows.find((a) => a.label === "err")!.labelPos).toBeDefined();
  expect(at.sched.w).toBe(boxWidth(view.blocks[2]));
  expect(boundsOf(l.blocks).w).toBeLessThanOrEqual(l.width);
});

test("edge path", () => {
  expect(
    edgePath([
      { x: 0, y: 0 },
      { x: 0, y: 10 },
    ]),
  ).toBe("M0,0 L0,10");
  expect(
    edgePath([
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 10 },
    ]),
  ).toMatch(/^M0,0 Q5,5 10,10$/);
});
