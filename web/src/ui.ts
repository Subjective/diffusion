// View state shared across panes: file collapse/viewed, ordering, comments, and line highlight/pin/flash.
import { create } from "zustand";
import { storage } from "./lib/storage";

export type Order = "guide" | "alpha";

/** Last time the reviewer scrolled or clicked in the diff themselves. Chat only auto-jumps the diff if it's older
 *  than the question, so an answer never yanks the view away from what they're reading. */
export const diffActivity = { at: 0 };
export const markDiffActivity = () => {
  diffActivity.at = Date.now();
};

interface UI {
  prKey: string;
  collapsed: Record<string, boolean>;
  viewed: Record<string, boolean>;
  readSteps: Record<number, boolean>;
  order: Order;
  hideSkip: boolean;
  rail: boolean;
  hideComments: boolean;
  /** Comments the reviewer resolved, by title (ids change between guide versions). */
  resolved: Record<string, boolean>;

  hoverRows: Set<string>; // rowKey
  pinRows: Set<string>;
  flash: { keys: Set<string>; n: number };
  scrollTo: { keys: string[]; n: number } | null;
  hoverStep: number | null;
  hoverSub: number | null;
  pinStep: number | null;
  pinSub: number | null;
  /** Which of the pinned step's (or substep's) refs h/l last moved to. */
  refAt: number | null;
  /** Go-to-definition preview under a row. */
  peek: Peek | null;

  init(prKey: string, defaultsCollapsed: Record<string, boolean>): void;
  toggleCollapsed(path: string, value?: boolean): void;
  collapseAll(value: boolean, keepCollapsed: string[]): void;
  toggleViewed(path: string): void;
  toggleRead(step: number): void;
  setOrder(o: Order): void;
  toggleHideSkip(): void;
  toggleRail(): void;
  toggleHideComments(): void;
  /** Resolve a comment, or reopen it with `false`. */
  resolve(title: string, on?: boolean): void;

  setHover(keys: string[], step?: number | null, sub?: number | null): void;
  focus(keys: string[], files: string[], step?: number | null, sub?: number | null): void;
  clearPin(): void;
  /** Scroll to and flash one of the pinned item's refs, keeping the pin. */
  showRef(i: number, keys: string[], files: string[]): void;
  setPeek(p: Peek | null): void;
}

export interface Peek {
  rk: string;
  file: string;
  symbol: string;
}

const persist = (k: string, s: Pick<UI, "viewed" | "readSteps" | "resolved">) =>
  storage.set(`rv-ui:${k}`, { viewed: s.viewed, readSteps: s.readSteps, resolved: s.resolved });

export const useUI = create<UI>((set, get) => ({
  prKey: "",
  collapsed: {},
  viewed: {},
  readSteps: {},
  order: storage.get<Order>("rv-order", "guide"),
  hideSkip: false,
  rail: storage.get("rv-rail", false),
  hideComments: storage.get("rv-hide-comments", false),
  resolved: {},
  hoverRows: new Set(),
  pinRows: new Set(),
  flash: { keys: new Set(), n: 0 },
  scrollTo: null,
  hoverStep: null,
  hoverSub: null,
  pinStep: null,
  pinSub: null,
  refAt: null,
  peek: null,

  init(prKey, defaultsCollapsed) {
    const saved = { viewed: {}, readSteps: {}, resolved: {}, ...storage.get(`rv-ui:${prKey}`, {}) };
    const collapsed = { ...defaultsCollapsed };
    for (const [p, v] of Object.entries(saved.viewed)) if (v) collapsed[p] = true;
    set({
      prKey,
      collapsed,
      viewed: saved.viewed,
      readSteps: saved.readSteps,
      resolved: saved.resolved,
      pinRows: new Set(),
      pinStep: null,
      pinSub: null,
      refAt: null,
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
      persist(s.prKey, { viewed, readSteps: s.readSteps, resolved: s.resolved });
      return { viewed, collapsed: { ...s.collapsed, [path]: on } };
    });
  },
  toggleRead(step) {
    set((s) => {
      const readSteps = { ...s.readSteps, [step]: !s.readSteps[step] };
      persist(s.prKey, { viewed: s.viewed, readSteps, resolved: s.resolved });
      return { readSteps };
    });
  },
  setOrder(order) {
    storage.set("rv-order", order);
    set({ order });
  },
  toggleHideSkip: () => set((s) => ({ hideSkip: !s.hideSkip })),
  toggleHideComments() {
    const hideComments = !get().hideComments;
    storage.set("rv-hide-comments", hideComments);
    set({ hideComments });
  },
  resolve(title, on = true) {
    set((s) => {
      const resolved = { ...s.resolved, [title]: on };
      persist(s.prKey, { viewed: s.viewed, readSteps: s.readSteps, resolved });
      return { resolved };
    });
  },
  toggleRail() {
    const rail = !get().rail;
    storage.set("rv-rail", rail);
    set({ rail });
  },

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
        refAt: step == null ? s.refAt : null,
        pinRows: step == null ? s.pinRows : pinStep == null ? new Set() : new Set(keys),
        flash: { keys: new Set(keys), n: s.flash.n + 1 },
        scrollTo: { keys, n: (s.scrollTo?.n ?? 0) + 1 },
      };
    });
  },
  clearPin: () => set({ pinStep: null, pinSub: null, pinRows: new Set(), refAt: null }),
  showRef(i, keys, files) {
    if (!keys.length) return;
    set((s) => {
      const collapsed = { ...s.collapsed };
      for (const f of files) collapsed[f] = false;
      return {
        collapsed,
        hideSkip: false,
        refAt: i,
        flash: { keys: new Set(keys), n: s.flash.n + 1 },
        scrollTo: { keys, n: (s.scrollTo?.n ?? 0) + 1 },
      };
    });
  },
  setPeek: (peek) => set({ peek }),
}));
