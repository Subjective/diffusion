import { create } from "zustand";
import { fetchPR, streamGuide } from "./api";
import { storage } from "./lib/storage";
import type { FileDiff, Guide, PRMeta, Stage } from "./types";

export type StageStatus = "pending" | "active" | "done";
export interface ToolActivity {
  name: string;
  summary: string;
}

interface State {
  url: string;
  theme: "light" | "dark";
  chatOpen: boolean;

  loading: boolean;
  error: string | null;
  pr: PRMeta | null;
  files: FileDiff[];
  guide: Guide | null;
  generating: boolean;
  stages: Record<Stage, StageStatus>;
  tools: ToolActivity[];

  setUrl(url: string): void;
  toggleTheme(): void;
  toggleChat(open?: boolean): void;
  load(url?: string): Promise<void>;
  generate(force?: boolean): Promise<void>;
}

const initialStages = (): Record<Stage, StageStatus> => ({
  fetch: "pending",
  hunks: "pending",
  explore: "pending",
  validate: "pending",
});
let abort: AbortController | null = null;

const urlParam = () => new URLSearchParams(location.search).get("pr") ?? "";

export const useApp = create<State>((set, get) => ({
  url: urlParam() || storage.get("rv-url", ""),
  theme: storage.get("rv-theme", matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  chatOpen: storage.get("rv-chat-open", true),

  loading: false,
  error: null,
  pr: null,
  files: [],
  guide: null,
  generating: false,
  stages: initialStages(),
  tools: [],

  setUrl: (url) => set({ url }),
  toggleTheme: () => {
    const theme = get().theme === "dark" ? "light" : "dark";
    storage.set("rv-theme", theme);
    set({ theme });
  },
  toggleChat: (open) => {
    const chatOpen = open ?? !get().chatOpen;
    storage.set("rv-chat-open", chatOpen);
    set({ chatOpen });
  },

  async load(url) {
    url = (url ?? get().url).trim();
    if (!url) return;
    abort?.abort();
    set({ url, loading: true, error: null, guide: null, generating: false, stages: initialStages(), tools: [] });
    storage.set("rv-url", url);
    const q = new URLSearchParams(location.search);
    q.set("pr", url);
    history.replaceState(null, "", `?${q}`);
    try {
      const data = await fetchPR(url);
      set({ pr: data.pr, files: data.files, guide: data.guide, loading: false });
      if (!data.guide) void get().generate();
    } catch (e) {
      set({ loading: false, error: String((e as Error).message ?? e) });
    }
  },

  async generate(force = false) {
    const { url } = get();
    abort?.abort();
    abort = new AbortController();
    set({ generating: true, error: null, stages: { ...initialStages(), fetch: "active" }, tools: [] });
    try {
      await streamGuide(
        url,
        force,
        ({ event, data }) => {
          const d = data as Record<string, unknown>;
          if (event === "stage") {
            const stage = d.stage as Stage;
            set((s) => {
              const stages = { ...s.stages, [stage]: d.status as StageStatus };
              const order: Stage[] = ["fetch", "hunks", "explore", "validate"];
              const next = order[order.indexOf(stage) + 1];
              if (d.status === "done" && next && stages[next] === "pending") stages[next] = "active";
              return { stages };
            });
          } else if (event === "tool") {
            set((s) => ({ tools: [...s.tools, d as unknown as ToolActivity] }));
          } else if (event === "guide") {
            set({ guide: d as unknown as Guide, generating: false });
          } else if (event === "error") {
            set({ error: String(d.message), generating: false });
          }
        },
        abort.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") set({ error: String((e as Error).message ?? e) });
    } finally {
      set({ generating: false });
    }
  },
}));
