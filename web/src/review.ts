// GitHub's side of the open PR (review threads, reviewers, checks), and how its threads are shown.
import { create } from "zustand";
import { fetchInbox, fetchReview } from "./api";
import { storage } from "./lib/storage";
import type { Inbox, InboxPR, ReviewState } from "./types";

interface Review {
  url: string;
  state: ReviewState | null;
  /** Files whose threads are hidden on the diff. */
  hiddenFiles: string[];
  /** Threads opened past their collapsed form (long middles, resolved). */
  expanded: string[];
  load(url: string, refresh?: boolean): Promise<void>;
  toggleFile(path: string): void;
  expand(id: string, on?: boolean): void;
}

export const useReview = create<Review>((set, get) => ({
  url: "",
  state: null,
  hiddenFiles: [],
  expanded: [],
  async load(url, refresh = false) {
    if (url !== get().url) set({ url, state: null, expanded: [], hiddenFiles: storage.get(`rv-th-hidden:${url}`, []) });
    try {
      const state = await fetchReview(url, refresh);
      if (get().url === url) set({ state });
    } catch (e) {
      if (get().url === url) set({ state: { available: true, error: String((e as Error).message ?? e), threads: [] } });
    }
  },
  toggleFile(path) {
    const { hiddenFiles, url } = get();
    const next = hiddenFiles.includes(path) ? hiddenFiles.filter((p) => p !== path) : [...hiddenFiles, path];
    storage.set(`rv-th-hidden:${url}`, next);
    set({ hiddenFiles: next });
  },
  expand(id, on = true) {
    const { expanded } = get();
    set({ expanded: on ? [...new Set([...expanded, id])] : expanded.filter((x) => x !== id) });
  },
}));

interface InboxStore {
  /** The last inbox fetched, kept so going home or opening the switcher shows it at once. */
  inbox: Inbox | null;
  load(refresh?: boolean): Promise<void>;
}

export const useInbox = create<InboxStore>((set, get) => ({
  inbox: null,
  async load(refresh = false) {
    try {
      set({ inbox: await fetchInbox(refresh) });
    } catch (e) {
      set({ inbox: get().inbox ?? { login: "", prs: [], error: String((e as Error).message ?? e) } });
    }
  },
}));

/** The inbox PR for owner/repo#number, and the stack it's in (top layer first), if any. */
export function inboxStack(prs: InboxPR[], owner: string, repo: string, number: number) {
  const pr = prs.find((p) => p.owner === owner && p.repo === repo && p.number === number);
  const layers = pr?.stack
    ? prs.filter((p) => p.stack?.id === pr.stack!.id).sort((a, b) => b.stack!.index - a.stack!.index)
    : [];
  return { pr, layers: layers.length > 1 ? layers : [] };
}
