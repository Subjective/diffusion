// View state shared across panes: file collapse/viewed, ordering, comments, and line highlight/pin/flash.
import { create } from "zustand";
import { storage } from "./lib/storage";

export type Order = "guide" | "alpha";
/** What the left pane shows: the guide's steps, or the map of the change. */
export type Mode = "guide" | "map";

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
  mode: Mode;
  /** Whether the diff pane is open. It starts open with the steps and closed on the map; closed, the left pane fills the space. */
  diffOpen: boolean;
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
  /** Files open in tabs beside the diff. One unpinned tab is a preview: the next file opened replaces it. */
  tabs: FileTab[];
  /** The tab in front: a file's path, or null for the diff. */
  tab: string | null;
  /** Lines to scroll to and flash in a file tab. */
  fileAt: { path: string; line: number; end: number; n: number } | null;
  /** What the file navigator lists: the changed files, or every file at the head. */
  railMode: RailMode;

  init(prKey: string, defaultsCollapsed: Record<string, boolean>): void;
  toggleCollapsed(path: string, value?: boolean): void;
  collapseAll(value: boolean, keepCollapsed: string[]): void;
  toggleViewed(path: string): void;
  toggleRead(step: number): void;
  setOrder(o: Order): void;
  setMode(m: Mode): void;
  openDiff(on: boolean): void;
  toggleHideSkip(): void;
  toggleRail(): void;
  toggleHideComments(): void;
  /** Resolve a comment, or reopen it with `false`. */
  resolve(title: string, on?: boolean): void;

  setHover(keys: string[], step?: number | null, sub?: number | null): void;
  /** Scroll to, flash and (given a step) pin lines, opening the diff. `pin` pins them without a step and leaves the
   *  diff as it is, as the map's blocks and scenes do. */
  focus(keys: string[], files: string[], step?: number | null, sub?: number | null, pin?: boolean): void;
  clearPin(): void;
  /** Scroll to and flash one of the pinned item's refs, keeping the pin. */
  showRef(i: number, keys: string[], files: string[]): void;
  setPeek(p: Peek | null): void;
  /** Open a file in a tab (a preview unless pinned), optionally at some lines. */
  openFile(path: string, at?: { line: number; end?: number }, pin?: boolean): void;
  closeTab(path: string): void;
  pinTab(path: string): void;
  /** Bring a tab to the front, or the diff with null. */
  showTab(path: string | null): void;
  setRailMode(m: RailMode): void;
}

export interface FileTab {
  path: string;
  pinned: boolean;
}
export type RailMode = "diff" | "all";

export interface Peek {
  rk: string;
  file: string;
  symbol: string;
  /** Open on the name's uses (⇧⌘-click). */
  refs?: boolean;
}

const persist = (k: string, s: Pick<UI, "viewed" | "readSteps" | "resolved">) =>
  storage.set(`rv-ui:${k}`, { viewed: s.viewed, readSteps: s.readSteps, resolved: s.resolved });

export const useUI = create<UI>((set, get) => ({
  prKey: "",
  collapsed: {},
  viewed: {},
  readSteps: {},
  order: storage.get<Order>("rv-order", "guide"),
  mode: storage.get<Mode>("rv-mode", "guide"),
  diffOpen: storage.get<Mode>("rv-mode", "guide") !== "map",
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
  tabs: [],
  tab: null,
  fileAt: null,
  railMode: storage.get<RailMode>("rv-rail-mode", "diff"),

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
      tabs: prKey === get().prKey ? get().tabs : [],
      tab: prKey === get().prKey ? get().tab : null,
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
  setMode(mode) {
    storage.set("rv-mode", mode);
    set({ mode, diffOpen: mode !== "map" });
  },
  openDiff: (diffOpen) => set({ diffOpen }),
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
  focus(keys, files, step = null, sub = null, pin = false) {
    if (!keys.length) return;
    set((s) => {
      const collapsed = { ...s.collapsed };
      for (const f of files) collapsed[f] = false;
      const same = step != null && s.pinStep === step && s.pinSub === sub;
      const pinStep = same ? null : step;
      return {
        collapsed,
        hideSkip: false,
        // Going to lines opens the diff; the map's scenes (which pin) don't, so the map can stay full size.
        diffOpen: s.diffOpen || !pin,
        tab: pin ? s.tab : null,
        pinStep,
        pinSub: same ? null : sub,
        refAt: step == null && !pin ? s.refAt : null,
        pinRows: pin ? new Set(keys) : step == null ? s.pinRows : pinStep == null ? new Set() : new Set(keys),
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
        diffOpen: true,
        tab: null,
        refAt: i,
        flash: { keys: new Set(keys), n: s.flash.n + 1 },
        scrollTo: { keys, n: (s.scrollTo?.n ?? 0) + 1 },
      };
    });
  },
  setPeek: (peek) => set({ peek }),
  openFile(path, at, pin = false) {
    set((s) => {
      const open = s.tabs.find((t) => t.path === path);
      let tabs: FileTab[];
      if (open) tabs = s.tabs.map((t) => (t.path === path ? { ...t, pinned: t.pinned || pin } : t));
      else {
        // The preview tab gives its place to the next preview, so browsing doesn't pile up tabs.
        const i = pin ? -1 : s.tabs.findIndex((t) => !t.pinned);
        const tab = { path, pinned: pin };
        tabs = i < 0 ? [...s.tabs, tab] : s.tabs.map((t, j) => (j === i ? tab : t));
      }
      const line = at?.line ?? 0;
      return {
        tabs,
        tab: path,
        diffOpen: true,
        peek: null,
        fileAt: line ? { path, line, end: at?.end ?? line, n: (s.fileAt?.n ?? 0) + 1 } : s.fileAt,
      };
    });
  },
  closeTab(path) {
    set((s) => {
      const i = s.tabs.findIndex((t) => t.path === path);
      const tabs = s.tabs.filter((t) => t.path !== path);
      // Closing the tab in front shows its neighbour, else the diff.
      const tab = s.tab !== path ? s.tab : (tabs[Math.min(i, tabs.length - 1)]?.path ?? null);
      return { tabs, tab };
    });
  },
  pinTab: (path) => set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, pinned: true } : t)) })),
  showTab: (tab) => set({ tab, peek: null }),
  setRailMode(railMode) {
    storage.set("rv-rail-mode", railMode);
    set({ railMode });
  },
}));
