// View state shared across panes: file collapse/viewed, ordering, and line highlight/pin/flash.
import { create } from "zustand";
import { storage } from "./lib/storage";

export type Order = "guide" | "alpha";

interface UI {
  prKey: string;
  collapsed: Record<string, boolean>;
  viewed: Record<string, boolean>;
  readSteps: Record<number, boolean>;
  order: Order;
  hideSkip: boolean;

  hoverRows: Set<string>; // rowKey
  pinRows: Set<string>;
  flash: { keys: Set<string>; n: number };
  scrollTo: { key: string; n: number } | null;
  hoverStep: number | null;
  hoverSub: number | null;
  pinStep: number | null;
  pinSub: number | null;

  init(prKey: string, defaultsCollapsed: Record<string, boolean>): void;
  toggleCollapsed(path: string, value?: boolean): void;
  collapseAll(value: boolean, keepCollapsed: string[]): void;
  toggleViewed(path: string): void;
  toggleRead(step: number): void;
  setOrder(o: Order): void;
  toggleHideSkip(): void;

  setHover(keys: string[], step?: number | null, sub?: number | null): void;
  focus(keys: string[], files: string[], step?: number | null, sub?: number | null): void;
  clearPin(): void;
}

const persist = (k: string, s: Pick<UI, "viewed" | "readSteps">) =>
  storage.set(`rv-ui:${k}`, { viewed: s.viewed, readSteps: s.readSteps });

export const useUI = create<UI>((set, get) => ({
  prKey: "",
  collapsed: {},
  viewed: {},
  readSteps: {},
  order: storage.get<Order>("rv-order", "guide"),
  hideSkip: false,
  hoverRows: new Set(),
  pinRows: new Set(),
  flash: { keys: new Set(), n: 0 },
  scrollTo: null,
  hoverStep: null,
  hoverSub: null,
  pinStep: null,
  pinSub: null,

  init(prKey, defaultsCollapsed) {
    const saved = storage.get(`rv-ui:${prKey}`, { viewed: {}, readSteps: {} });
    const collapsed = { ...defaultsCollapsed };
    for (const [p, v] of Object.entries(saved.viewed)) if (v) collapsed[p] = true;
    set({
      prKey,
      collapsed,
      viewed: saved.viewed,
      readSteps: saved.readSteps,
      pinRows: new Set(),
      pinStep: null,
      pinSub: null,
    });
  },
  toggleCollapsed(path, value) {
    set((s) => ({ collapsed: { ...s.collapsed, [path]: value ?? !s.collapsed[path] } }));
  },
  collapseAll(value, keepCollapsed) {
    set((s) => {
      const collapsed: Record<string, boolean> = {};
      for (const p of Object.keys(s.collapsed)) collapsed[p] = value;
      if (!value) for (const p of keepCollapsed) collapsed[p] = true;
      return { collapsed };
    });
  },
  toggleViewed(path) {
    set((s) => {
      const on = !s.viewed[path];
      const viewed = { ...s.viewed, [path]: on };
      persist(s.prKey, { viewed, readSteps: s.readSteps });
      return { viewed, collapsed: { ...s.collapsed, [path]: on } };
    });
  },
  toggleRead(step) {
    set((s) => {
      const readSteps = { ...s.readSteps, [step]: !s.readSteps[step] };
      persist(s.prKey, { viewed: s.viewed, readSteps });
      return { readSteps };
    });
  },
  setOrder(order) {
    storage.set("rv-order", order);
    set({ order });
  },
  toggleHideSkip: () => set((s) => ({ hideSkip: !s.hideSkip })),

  setHover(keys, step = null, sub = null) {
    const s = get();
    if (
      s.hoverStep === step &&
      s.hoverSub === sub &&
      keys.length === s.hoverRows.size &&
      keys.every((k) => s.hoverRows.has(k))
    )
      return;
    set({ hoverRows: new Set(keys), hoverStep: step, hoverSub: sub });
  },
  focus(keys, files, step = null, sub = null) {
    if (!keys.length) return;
    set((s) => {
      const collapsed = { ...s.collapsed };
      for (const f of files) collapsed[f] = false;
      const same = step != null && s.pinStep === step && s.pinSub === sub;
      const pinStep = same ? null : step;
      return {
        collapsed,
        hideSkip: false,
        pinStep,
        pinSub: same ? null : sub,
        pinRows: step == null ? s.pinRows : pinStep == null ? new Set() : new Set(keys),
        flash: { keys: new Set(keys), n: s.flash.n + 1 },
        scrollTo: { key: keys[0], n: (s.scrollTo?.n ?? 0) + 1 },
      };
    });
  },
  clearPin: () => set({ pinStep: null, pinSub: null, pinRows: new Set() }),
}));
