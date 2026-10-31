// Chat state: one active chat at a time; each chat owns its questions, anchors, queue, and thread.
import { create } from "zustand";
import type { CodeLoc } from "./lib/cite";
import { errorText, postSSE } from "./lib/sse";
import { useApp } from "./store";
import type { Ref } from "./types";
import { diffActivity } from "./ui";

export interface Anchor {
  file: string;
  start: number;
  end: number;
  side: "new" | "old";
  code: string;
  /** Row positions in the diff (for highlight/scroll), first..last inclusive. */
  pfrom?: number;
  pto?: number;
  step?: number;
  stepTitle?: string;
  stepKind?: string;
  refs?: Ref[];
  /** The guide comment being asked about: its title and text, and the title alone for display. */
  comment?: string;
  commentTitle?: string;
}

// staged: queued line comment (tray) · waiting: sent while a turn was running; goes out with the next turn
export type QStatus = "staged" | "waiting" | "pending" | "answered" | "error";
export interface Question {
  id: string; // local id
  n: number | null; // number shown in UI/sent to engine; null for plain composer messages
  text: string;
  anchor: Anchor | null;
  status: QStatus;
  answer: string;
  tools: string[];
  turn: number | null;
  /** Diff regions the model chose to show for this question (`show_code`). */
  shows: Show[];
  /** What the agent did this turn, in order: reasoning as its CLI reports it, and tool calls (shared by the turn's
   * questions). */
  trace?: TraceItem[];
  /** How long the turn took, once it's done. */
  seconds?: number;
  /** The guide version this answer saved, when it was asked to change the guide. */
  guideVersion?: number;
}

export type TraceItem = { think: string } | { tool: string };

/** Add a tool call, or a piece of streamed reasoning (joined to the reasoning just before it). */
export function extendTrace(trace: TraceItem[] = [], item: TraceItem): TraceItem[] {
  const last = trace.at(-1);
  if ("think" in item && last && "think" in last) return [...trace.slice(0, -1), { think: last.think + item.think }];
  return [...trace, item];
}

export interface Show extends CodeLoc {
  label: string;
}

export interface ChatSummary {
  id: string;
  title: string;
  questions: number;
  anchored: number;
  updated_at: number;
}

interface Chat {
  key: number; // stable local identity (id is assigned lazily by the engine)
  id: string | null; // engine id once created
  questions: Question[];
  turns: number;
  nextN: number;
  busy: boolean; // a turn is streaming; new questions wait and go out together afterwards
}

interface State {
  pr: string; // PR url
  chat: Chat;
  history: ChatSummary[];
  historyOpen: boolean;
  error: string | null;
  /** The diff should jump to this show: the model's first `show_code` of a turn, if the diff wasn't touched since asking. */
  autoShow: { q: string; i: number; n: number } | null;

  reset(pr: string): void;
  newChat(): void;
  openChat(id: string): Promise<void>;
  loadHistory(): Promise<void>;
  setHistoryOpen(open: boolean): void;

  stage(text: string, anchor: Anchor): Question;
  unstage(id: string): void;
  clearStaged(): void;
  ask(text: string, anchor?: Anchor | null): void;
  sendStaged(extra?: string): void;
}

let chatSeq = 0;
const emptyChat = (): Chat => ({ key: ++chatSeq, id: null, questions: [], turns: 0, nextN: 1, busy: false });
let qSeq = 0;
const qid = () => `q${++qSeq}`;
const ctrls = new Set<AbortController>();

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

export const useChat = create<State>((set, get) => {
  const patch = (chatRef: Chat, ids: string[], fn: (q: Question) => Partial<Question>) =>
    set((s) => {
      if (s.chat.key !== chatRef.key) return {};
      const chat = { ...s.chat, questions: s.chat.questions.map((q) => (ids.includes(q.id) ? { ...q, ...fn(q) } : q)) };
      return { chat };
    });

  async function ensureChat(): Promise<string> {
    const { chat, pr } = get();
    if (chat.id) return chat.id;
    const c = await json<{ id: string }>(
      await fetch("/api/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: pr }),
      }),
    );
    set((s) => ({ chat: { ...s.chat, id: c.id } }));
    return c.id;
  }

  async function send(qs: Question[]) {
    if (!qs.length) return;
    const ids0 = new Set(qs.map((q) => q.id));
    if (get().chat.busy) {
      // One turn at a time: hold these and send them all as the next turn.
      set((s) => ({
        chat: {
          ...s.chat,
          questions: [
            ...s.chat.questions.filter((q) => !ids0.has(q.id)),
            ...qs.map((q) => ({ ...q, status: "waiting" as const, turn: null })),
          ],
        },
      }));
      return;
    }
    const multi = qs.length > 1;
    set((s) => {
      let nextN = s.chat.nextN;
      const turn = s.chat.turns;
      const numbered = new Map(qs.map((q) => [q.id, q.n ?? (multi ? nextN++ : null)]));
      const ids = new Set(qs.map((q) => q.id));
      const existing = s.chat.questions.filter((q) => !ids.has(q.id));
      const sent = qs.map((q) => ({ ...q, n: numbered.get(q.id)!, status: "pending" as const, turn }));
      return { chat: { ...s.chat, questions: [...existing, ...sent], turns: turn + 1, nextN, busy: true } };
    });
    const sent = get().chat.questions.filter((q) => qs.some((x) => x.id === q.id));
    const chatRef = get().chat;
    const ids = sent.map((q) => q.id);
    // engine needs unique numbers per turn; unnumbered single questions use 0
    const wire = sent.map((q) => ({ n: q.n ?? 0, text: q.text, anchor: q.anchor ? toWire(q.anchor) : null }));
    const byN = new Map(sent.map((q) => [q.n ?? 0, q.id]));
    const ctrl = new AbortController();
    ctrls.add(ctrl);
    const askedAt = Date.now();
    let autoShown = false;
    try {
      const id = await ensureChat();
      await postSSE(
        `/api/chats/${id}/turn`,
        { url: get().pr, questions: wire, version: useApp.getState().guide?.version ?? null },
        ({ event, data }) => {
          const d = data as Record<string, unknown>;
          if (event === "delta") {
            const target = byN.get(d.n as number);
            if (target) patch(get().chat, [target], (q) => ({ answer: q.answer + (d.text as string) }));
          } else if (event === "focus") {
            const target = byN.get(d.n as number);
            if (!target) return;
            const show: Show = {
              file: String(d.file),
              start: Number(d.start),
              end: Number(d.end),
              side: d.side === "old" ? "old" : "new",
              label: String(d.label ?? ""),
            };
            const i = get().chat.questions.find((q) => q.id === target)?.shows.length ?? 0;
            patch(get().chat, [target], (q) => ({ shows: [...q.shows, show] }));
            if (!autoShown && diffActivity.at < askedAt && get().chat.key === chatRef.key) {
              autoShown = true;
              set((s) => ({ autoShow: { q: target, i, n: (s.autoShow?.n ?? 0) + 1 } }));
            }
          } else if (event === "guide") {
            const target = byN.get(d.n as number);
            const v = Number(d.version);
            if (target) patch(get().chat, [target], () => ({ guideVersion: v }));
            void useApp
              .getState()
              .refresh()
              .then(() => useApp.getState().showVersion(v));
          } else if (event === "tool") {
            patch(get().chat, ids, (q) =>
              q.status === "pending"
                ? {
                    tools: [...q.tools, d.summary as string],
                    trace: extendTrace(q.trace, { tool: d.summary as string }),
                  }
                : {},
            );
          } else if (event === "thinking") {
            patch(get().chat, ids, (q) => ({ trace: extendTrace(q.trace, { think: d.text as string }) }));
          } else if (event === "done") {
            const seconds = typeof d.seconds === "number" ? d.seconds : undefined;
            patch(get().chat, ids, () => ({ status: "answered", seconds }));
          } else if (event === "error") {
            patch(get().chat, ids, (q) => ({ status: "error", answer: q.answer || "" }));
            set({ error: String(d.message) });
          }
        },
        ctrl.signal,
      );
      patch(get().chat, ids, (q) => (q.status === "pending" ? { status: "answered" } : {}));
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        patch(chatRef, ids, () => ({ status: "error" }));
        set({ error: String((e as Error).message ?? e) });
      }
    } finally {
      ctrls.delete(ctrl);
      if (get().chat.key === chatRef.key) {
        set((s) => ({ chat: { ...s.chat, busy: false } }));
        const waiting = get().chat.questions.filter((q) => q.status === "waiting");
        if (waiting.length) void send(waiting);
      }
      if (get().historyOpen) void get().loadHistory();
    }
  }

  return {
    pr: "",
    chat: emptyChat(),
    history: [],
    historyOpen: false,
    error: null,
    autoShow: null,

    reset(pr) {
      if (pr === get().pr) return;
      for (const c of ctrls) c.abort();
      set({ pr, chat: emptyChat(), history: [], historyOpen: false, error: null });
    },
    newChat() {
      const { chat } = get();
      if (!chat.questions.length) return set({ historyOpen: false });
      set({ chat: emptyChat(), historyOpen: false, error: null });
    },
    async openChat(id) {
      const raw = await json<WireChat>(await fetch(`/api/chats/${id}?url=${encodeURIComponent(get().pr)}`));
      set({ chat: fromWire(raw), historyOpen: false, error: null });
    },
    async loadHistory() {
      const { pr } = get();
      if (!pr) return;
      try {
        const history = await json<ChatSummary[]>(await fetch(`/api/chats?url=${encodeURIComponent(pr)}`));
        set({ history });
      } catch (e) {
        set({ error: String((e as Error).message ?? e) });
      }
    },
    setHistoryOpen(open) {
      set({ historyOpen: open });
      if (open) void get().loadHistory();
    },

    stage(text, anchor) {
      const q: Question = {
        id: qid(),
        n: get().chat.nextN,
        text,
        anchor,
        status: "staged",
        answer: "",
        tools: [],
        turn: null,
        shows: [],
      };
      set((s) => ({ chat: { ...s.chat, questions: [...s.chat.questions, q], nextN: s.chat.nextN + 1 } }));
      return q;
    },
    unstage(id) {
      set((s) => ({ chat: { ...s.chat, questions: s.chat.questions.filter((q) => q.id !== id) } }));
    },
    clearStaged() {
      set((s) => ({ chat: { ...s.chat, questions: s.chat.questions.filter((q) => q.status !== "staged") } }));
    },
    ask(text, anchor = null) {
      const n = anchor ? get().chat.nextN : null;
      if (anchor) set((s) => ({ chat: { ...s.chat, nextN: s.chat.nextN + 1 } }));
      void send([{ id: qid(), n, text, anchor, status: "pending", answer: "", tools: [], turn: null, shows: [] }]);
    },
    sendStaged(extra) {
      const staged = get().chat.questions.filter((q) => q.status === "staged");
      const qs = [...staged];
      if (extra?.trim())
        qs.push({
          id: qid(),
          n: null,
          text: extra.trim(),
          anchor: null,
          status: "pending",
          answer: "",
          tools: [],
          turn: null,
          shows: [],
        });
      void send(qs);
    },
  };
});

// ---------- wire format ----------

interface WireAnchor {
  file: string;
  start: number;
  end: number;
  side: string;
  code: string;
  step: number | null;
}
interface WireChat {
  id: string;
  turns: {
    questions: { n: number; text: string; anchor: (WireAnchor & { ui?: Partial<Anchor> }) | null }[];
    answers: Record<string, string>;
    tools: string[];
    shows?: (Show & { n: number })[];
    guide_version?: number;
    trace?: TraceItem[];
    seconds?: number;
    status: string;
  }[];
}

function toWire(a: Anchor) {
  return {
    file: a.file,
    start: a.start,
    end: a.end,
    side: a.side,
    code: a.code,
    step: a.step ?? null,
    comment: a.comment ?? null,
    ui: a,
  };
}

export function fromWire(c: WireChat): Chat {
  const questions: Question[] = [];
  let nextN = 1;
  c.turns.forEach((t, turn) => {
    t.questions.forEach((q) => {
      const anchor = q.anchor ? ({ ...q.anchor, ...(q.anchor.ui ?? {}) } as Anchor) : null;
      const n = q.n > 0 ? q.n : null;
      if (n) nextN = Math.max(nextN, n + 1);
      questions.push({
        id: qid(),
        n,
        text: q.text,
        anchor,
        turn,
        status: t.status === "error" ? "error" : t.status === "done" ? "answered" : "answered",
        answer: t.answers[String(q.n)] ?? "",
        tools: t.tools,
        shows: (t.shows ?? []).filter((x) => x.n === q.n).map(({ n: _, ...x }) => x),
        guideVersion: q === t.questions.at(-1) ? t.guide_version : undefined,
        trace: t.trace ?? t.tools.map((tool) => ({ tool })),
        seconds: t.seconds,
      });
    });
  });
  return { key: ++chatSeq, id: c.id, questions, turns: c.turns.length, nextN, busy: false };
}
