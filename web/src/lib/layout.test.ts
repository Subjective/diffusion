import { edgePath, layoutFlow, nodeWidth } from "./layout";

test("layout ranks nodes top-to-bottom and routes edges", () => {
  const l = layoutFlow(
    [
      { id: "start", label: "start()", step: 1 },
      { id: "sched", label: "scheduleRefresh()", step: 2 },
      { id: "refresh", label: "refresh()", step: 2 },
      { id: "end", label: "end()", step: 5 },
    ],
    [
      { from: "start", to: "sched", label: null, kind: "normal" },
      { from: "sched", to: "refresh", label: "timer", kind: "normal" },
      { from: "refresh", to: "sched", label: "ok", kind: "normal" },
      { from: "refresh", to: "end", label: "err", kind: "error" },
      { from: "refresh", to: "ghost", label: null, kind: "normal" },
    ],
  );
  const y = Object.fromEntries(l.nodes.map((n) => [n.id, n.y]));
  expect(y.start).toBeLessThan(y.sched);
  expect(y.sched).toBeLessThan(y.refresh);
  expect(y.refresh).toBeLessThan(y.end);
  expect(l.edges).toHaveLength(4); // dangling edge to "ghost" dropped
  expect(l.edges.every((e) => e.points.length >= 2)).toBe(true);
  expect(l.edges.find((e) => e.label === "err")!.labelPos).toBeDefined();
  expect(l.nodes.find((n) => n.id === "sched")!.w).toBe(nodeWidth("scheduleRefresh()"));
  expect(l.width).toBeGreaterThan(0);
});

test("edge path", () => {
  expect(edgePath([{ x: 0, y: 0 }, { x: 0, y: 10 }])).toBe("M0,0 L0,10");
  expect(edgePath([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }])).toMatch(/^M0,0 Q5,5 10,10$/);
});
