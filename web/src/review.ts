// GitHub's side of the open PR (review threads, reviewers, checks), and how its threads are shown.
import { create } from "zustand";
import { fetchInbox, fetchReview, type ReviewAct, reviewAction } from "./api";
import { storage } from "./lib/storage";
import type { Inbox, InboxPR, ReviewState } from "./types";

/** A comment written for your next review, kept here until it's submitted. */
export interface PendingComment {
  id: string;
  path: string;
  side: "old" | "new";
  start: number;
  end: number;
  body: string;
}

export type Verdict = "comment" | "approve" | "request_changes";

interface Review {
  url: string;
  state: ReviewState | null;
  pending: PendingComment[];
  /** What GitHub said when something you did failed. */
  error: string | null;
  busy: boolean;
  addPending(c: Omit<PendingComment, "id">): void;
  editPending(id: string, body: string): void;
  /** Do something on GitHub; resolves false (with `error` set) when GitHub refuses. */
  act(action: ReviewAct): Promise<boolean>;
  /** Submit the review: the pending comments, a summary and a verdict. */
  submit(event: Verdict, body: string): Promise<boolean>;
  /** Post one comment now, as a review of its own. */
  commentNow(c: Omit<PendingComment, "id">): Promise<boolean>;
  /** Files whose threads are hidden on the diff. */
  hiddenFiles: string[];
  /** Threads opened past their collapsed form (long middles, resolved). */
  expanded: string[];
  load(url: string, refresh?: boolean): Promise<void>;
  toggleFile(path: string): void;
  expand(id: string, on?: boolean): void;
}

const savePending = (url: string, pending: PendingComment[]) => storage.set(`rv-pending:${url}`, pending);
const asComment = ({ id: _, ...c }: PendingComment) => c;

export const useReview = create<Review>((set, get) => ({
  url: "",
  state: null,
  pending: [],
  error: null,
  busy: false,
  hiddenFiles: [],
  expanded: [],
  addPending(c) {
    const { url, pending } = get();
    const next = [...pending, { ...c, id: `p${Date.now().toString(36)}${pending.length}` }];
    savePending(url, next);
    set({ pending: next });
  },
  editPending(id, body) {
    const { url, pending } = get();
    const next = body ? pending.map((p) => (p.id === id ? { ...p, body } : p)) : pending.filter((p) => p.id !== id);
    savePending(url, next);
    set({ pending: next });
  },
  async act(action) {
    const url = get().url;
    set({ busy: true, error: null });
    try {
      const state = await reviewAction(url, action);
      if (get().url === url) set({ state, busy: false });
      return true;
    } catch (e) {
      if (get().url === url) set({ error: String((e as Error).message ?? e), busy: false });
      return false;
    }
  },
  async submit(event, body) {
    const { pending, state, url } = get();
    const ok = await get().act({
      kind: "submit",
      event,
      body,
      commit: state?.head_sha,
      comments: pending.map(asComment),
    });
    if (ok && get().url === url) {
      savePending(url, []);
      set({ pending: [] });
    }
    return ok;
  },
  commentNow(c) {
    return get().act({ kind: "submit", event: "comment", body: "", commit: get().state?.head_sha, comments: [c] });
  },
  async load(url, refresh = false) {
    if (url !== get().url)
      set({
        url,
        state: null,
        error: null,
        expanded: [],
        hiddenFiles: storage.get(`rv-th-hidden:${url}`, []),
        pending: storage.get(`rv-pending:${url}`, []),
      });
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
