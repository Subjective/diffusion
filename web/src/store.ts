import { create } from "zustand";
import { fetchGuide, fetchPR, fetchVersions } from "./api";
import { storage } from "./lib/storage";
import type { FileDiff, Guide, GuideVersion, PRMeta } from "./types";

interface State {
  /** The review target: a PR URL or a `local:` target, from the link `diffusion open` prints. */
  url: string;
  theme: "light" | "dark";
  chatOpen: boolean;

  loading: boolean;
  error: string | null;
  pr: PRMeta | null;
  files: FileDiff[];
  guide: Guide | null;
  versions: GuideVersion[];
  /** Show new versions as they arrive; off while an earlier version is picked from history. */
  following: boolean;

  toggleTheme(): void;
  toggleChat(open?: boolean): void;
  load(url?: string): Promise<void>;
  showVersion(v: number): Promise<void>;
  /** Pick up versions saved since the page loaded (a resubmit, or an edit from chat). */
  refresh(): Promise<void>;
}

const params = () => new URLSearchParams(location.search);
const versionParam = () => Number(params().get("v")) || null;

function setParams(url: string, v: number | null) {
  const q = params();
  q.set("pr", url);
  if (v) q.set("v", String(v));
  else q.delete("v");
  history.replaceState(null, "", `?${q}`);
}

const latest = (vs: GuideVersion[]) => vs.at(-1)?.version ?? null;

export const useApp = create<State>((set, get) => ({
  url: params().get("pr") ?? storage.get("rv-url", ""),
  theme: storage.get("rv-theme", matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  chatOpen: storage.get("rv-chat-open", true),

  loading: false,
  error: null,
  pr: null,
  files: [],
  guide: null,
  versions: [],
  following: true,

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
    const v = url === get().url ? versionParam() : null;
    set({ url, loading: true, error: null });
    storage.set("rv-url", url);
    try {
      let data = await fetchPR(url, v);
      if (!data.guide && v && data.versions.length) data = await fetchPR(url); // a version of an older head
      const shown = data.guide?.version ?? null;
      set({
        pr: data.pr,
        files: data.files,
        guide: data.guide,
        versions: data.versions,
        following: shown === latest(data.versions),
        loading: false,
      });
      setParams(url, shown);
    } catch (e) {
      set({ loading: false, error: String((e as Error).message ?? e) });
    }
  },

  async showVersion(v) {
    const { url, guide, versions } = get();
    if (guide?.version === v) return;
    try {
      const g = await fetchGuide(url, v);
      set({ guide: g, following: v === latest(versions), error: null });
      setParams(url, v);
    } catch (e) {
      set({ error: String((e as Error).message ?? e) });
    }
  },

  async refresh() {
    const { url, pr, versions, following } = get();
    if (!url || !pr) return;
    let next: Awaited<ReturnType<typeof fetchVersions>>;
    try {
      next = await fetchVersions(url);
    } catch {
      return; // the server may be restarting; try again on the next tick
    }
    if (next.head_sha !== pr.head_sha) {
      // A guide arrived for a new head (a push, or new uncommitted work): the diff changed too.
      if (next.versions.length) {
        setParams(url, null);
        await get().load();
      }
      return;
    }
    if (latest(next.versions) === latest(versions)) return;
    set({ versions: next.versions });
    const v = latest(next.versions);
    if (v && following) await get().showVersion(v);
  },
}));
