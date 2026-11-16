// GitHub's side of the open PR (review threads, reviewers, checks), and how its threads are shown.
import { create } from "zustand";
import {
  answerGenerate,
  fetchGenerate,
  fetchInbox,
  fetchReview,
  type ReviewAct,
  reviewAction,
  startGenerate,
  stopGenerate,
  switchGenerateMode,
} from "./api";
import { storage } from "./lib/storage";
import type { FileDiff, GenerateJob, Inbox, InboxPR, ReviewState } from "./types";

/** Whether GitHub takes a comment on these lines: they must all be in one hunk of the PR's diff, on that side.
 *  Files the PR doesn't change, and lines outside its hunks (expanded context), can't be commented on. */
export function commentable(files: FileDiff[], path: string, side: "old" | "new", start: number, end: number) {
  const f = files.find((x) => x.path === path);
  return !!f?.hunks.some((h) => {
    const ns = h.lines.flatMap((l) => {
      const n = side === "new" ? (l.type === "del" ? null : l.new) : l.type === "add" ? null : l.old;
      return n == null ? [] : [n];
    });
    return ns.includes(start) && ns.includes(end);
  });
}

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
  /** What GitHub said when something you did failed, and where: "review", or the thread it was in. */
  error: string | null;
  errorAt: string;
  /** The review's summary, as it's being written (a chat answer can be added to it). */
  summary: string;
  setSummary(s: string): void;
  busy: boolean;
  addPending(c: Omit<PendingComment, "id">): void;
  editPending(id: string, body: string): void;
  /** Do something on GitHub; resolves false (with `error` set at `at`) when GitHub refuses. */
  act(action: ReviewAct, at?: string): Promise<boolean>;
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
const dropComment = (s: ReviewState, id: string): ReviewState => ({
  ...s,
  timeline: s.timeline?.filter((i) => i.id !== id),
  threads: s.threads
    ?.map((t) => ({ ...t, comments: t.comments.filter((c) => c.id !== id) }))
    .filter((t) => t.comments.length),
});
const asComment = ({ id: _, ...c }: PendingComment) => c;

export const useReview = create<Review>((set, get) => ({
  url: "",
  state: null,
  pending: [],
  error: null,
  errorAt: "",
  summary: "",
  setSummary: (summary) => set({ summary }),
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
  async act(action, at = "review") {
    const url = get().url;
    set({ busy: true, error: null });
    try {
      let state = await reviewAction(url, action);
      // GitHub can answer with the comment still there for a moment after deleting it.
      if (action.kind === "delete") state = dropComment(state, action.comment);
      if (get().url === url) set({ state, busy: false });
      return true;
    } catch (e) {
      if (get().url === url) set({ error: String((e as Error).message ?? e), errorAt: at, busy: false });
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
        summary: "",
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
  /** Write a review of a PR from here; the inbox shows its progress until it's saved. */
  generate(url: string): Promise<void>;
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
  async generate(url) {
    const mark = (generating: InboxPR["generating"]) => {
      const inbox = get().inbox;
      if (inbox) set({ inbox: { ...inbox, prs: inbox.prs.map((p) => (p.url === url ? { ...p, generating } : p)) } });
    };
    mark({ state: "running" });
    try {
      mark(await startGenerate(url));
    } catch (e) {
      mark({ state: "failed", error: String((e as Error).message ?? e) });
    }
  },
}));

/** Reviews being written from the review page, by PR URL: shared by its card and the chat, which shows the run. */
interface GenerateStore {
  jobs: Record<string, GenerateJob>;
  load(url: string): Promise<void>;
  /** ``mode``: the chat's permission mode, which the run (the guide chat's session to be) starts in. */
  start(url: string, focus: string, mode?: string): Promise<void>;
  answer(url: string, id: string, decision: string): Promise<void>;
  /** Switch the running review's session to ``mode``; what it now allows that's waiting goes ahead. */
  switchMode(url: string, mode: string): Promise<void>;
  stop(url: string): Promise<void>;
}

export const useGenerate = create<GenerateStore>((set, get) => {
  const put = (url: string, job: GenerateJob) => set({ jobs: { ...get().jobs, [url]: job } });
  const fail = (url: string, e: unknown) => put(url, { state: "failed", error: String((e as Error).message ?? e) });
  return {
    jobs: {},
    async load(url) {
      try {
        put(url, await fetchGenerate(url));
      } catch {
        // the server may be restarting; the next poll tries again
      }
    },
    async start(url, focus, mode) {
      put(url, { state: "running", started_at: Date.now() / 1000, log: [], text: "" });
      try {
        put(url, await startGenerate(url, focus, mode));
      } catch (e) {
        fail(url, e);
      }
    },
    async answer(url, id, decision) {
      const job = get().jobs[url];
      if (job) put(url, { ...job, asks: job.asks?.filter((a) => a.id !== id) });
      try {
        await answerGenerate(id, decision);
      } catch {
        // the run ends on its own if it can't hear back
      }
    },
    async switchMode(url, mode) {
      try {
        const answered = new Set(await switchGenerateMode(url, mode));
        const job = get().jobs[url];
        if (job && answered.size) put(url, { ...job, asks: job.asks?.filter((a) => !answered.has(a.id)) });
      } catch {
        // the next poll shows where it stands
      }
    },
    async stop(url) {
      try {
        put(url, await stopGenerate(url));
      } catch (e) {
        fail(url, e);
      }
    },
  };
});

/** The inbox PR for owner/repo#number, and the stack it's in (top layer first), if any. */
export function inboxStack(prs: InboxPR[], owner: string, repo: string, number: number) {
  const pr = prs.find((p) => p.owner === owner && p.repo === repo && p.number === number);
  const layers = pr?.stack
    ? prs.filter((p) => p.stack?.id === pr.stack!.id).sort((a, b) => b.stack!.index - a.stack!.index)
    : [];
  return { pr, layers: layers.length > 1 ? layers : [] };
}
