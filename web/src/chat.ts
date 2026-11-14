// Chat state: one active chat at a time; each chat owns its questions, anchors, queue, and thread.
import { create } from "zustand";
import type { CodeLoc } from "./lib/cite";
import { errorText, postSSE } from "./lib/sse";
import { storage } from "./lib/storage";
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
  /** Asked of the session somewhere else (its terminal), read from its transcript. */
  fromSession?: boolean;
}

export type TraceItem = { think: string } | { tool: string; id?: string; failed?: boolean };

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
  kind?: ChatKind;
  harness?: string | null;
}

/** "guide": the agent session that wrote the guide, continued. "fork": a read-only branch of it. */
export type ChatKind = "guide" | "fork";

/** Agents whose sessions chat can fork or continue (the engine's FORKABLE). */
const CONTINUABLE = new Set(["claude-code", "codex"]);

/** The session that wrote a guide, if chat can carry it on. */
export function guideSessionOf(meta: { session?: string | null; harness?: string | null } | undefined) {
  return meta?.session && meta.harness && CONTINUABLE.has(meta.harness) ? { harness: meta.harness } : null;
}
const guideSession = () => guideSessionOf(useApp.getState().guide?.meta);

interface Chat {
  key: number; // stable local identity (id is assigned lazily by the engine)
  id: string | null; // engine id once created
  kind: ChatKind;
  /** The agent it runs on, once it has; until then the guide's. */
  harness: string | null;
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
  mode: ChatMode;
  setMode(mode: ChatMode): void;
  /** Tool calls waiting on the reviewer in the running turn. */
  asks: Ask[];
  answer(id: string, decision: Decision): Promise<void>;
  /** End the running turn; anything queued goes out next. */
  stop(): Promise<void>;
  /** The diff should jump to this show: the model's first `show_code` of a turn, if the diff wasn't touched since asking. */
  autoShow: { q: string; i: number; n: number } | null;

  reset(pr: string): void;
  /** Open the guide's own session, continued where it (or this chat) left off. */
  openGuide(): Promise<void>;
  /** Pick up what was said to the guide's session elsewhere (its terminal) since the chat was loaded. */
  syncGuide(): Promise<void>;
  newChat(): void;
  openChat(id: string): Promise<void>;
  loadHistory(): Promise<void>;
  setHistoryOpen(open: boolean): void;

  stage(text: string, anchor: Anchor): Question;
  unstage(id: string): void;
  /** Change a line note's text (same number, same lines); empty removes it. */
  editStaged(id: string, text: string): void;
  clearStaged(): void;
  ask(text: string, anchor?: Anchor | null): void;
  sendStaged(extra?: string): void;
}

/** How much the guide session may do: the harness's own permission modes. Forks are always read-only. */
export type ChatMode = "default" | "acceptEdits" | "plan" | "auto";
/** The reviewer's answer to a tool call; "always" also allows its kind for the rest of the session. */
export type Decision = "allow" | "deny" | "always";
/** The modes an agent has, in the order its own Shift+Tab cycles them. Codex can't stop mid-run to ask, so its
 * modes are its sandboxes: Plan reads, Auto writes in the workspace. */
export const modesFor = (harness: string | null): ChatMode[] =>
  harness === "claude-code" ? ["default", "acceptEdits", "plan", "auto"] : harness === "codex" ? ["plan", "auto"] : [];

/** A tool call the session wants to make that its settings don't already allow. */
export const EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

export interface Ask {
  id: string;
  tool: string;
  summary: string;
  input: Record<string, unknown>;
}

let chatSeq = 0;
const emptyChat = (kind: ChatKind = "fork"): Chat => ({
  key: ++chatSeq,
  id: null,
  kind,
  harness: null,
  questions: [],
  turns: 0,
  nextN: 1,
  busy: false,
});
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
    // No session to continue (an agent that can't, or a guide written by hand): it's a fresh chat after all.
    const kind = chat.kind === "guide" && guideSession() ? "guide" : "fork";
    const c = await json<{ id: string }>(
      await fetch("/api/chats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: pr, kind }),
      }),
    );
    set((s) => ({ chat: { ...s.chat, id: c.id, kind } }));
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
        {
          url: get().pr,
          questions: wire,
          version: useApp.getState().guide?.version ?? null,
          mode: chatRef.kind === "guide" ? get().mode : "read-only",
        },
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
                    trace: extendTrace(q.trace, { tool: d.summary as string, ...(d.id ? { id: String(d.id) } : {}) }),
                  }
                : {},
            );
          } else if (event === "approval") {
            set((s) => ({ asks: [...s.asks, d as unknown as Ask] }));
          } else if (event === "tool_failed") {
            patch(get().chat, ids, (q) => ({
              trace: q.trace?.map((t) => ("tool" in t && t.id === d.id ? { ...t, failed: true } : t)),
            }));
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
      set({ asks: [] });
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
    mode: ((m) => (modesFor("claude-code").includes(m) ? m : "default"))(
      storage.get<ChatMode>("rv-chat-mode", "default"),
    ),
    asks: [],

    setMode(mode) {
      storage.set("rv-chat-mode", mode);
      set({ mode });
    },
    async answer(id, decision) {
      const ask = get().asks.find((a) => a.id === id);
      set((s) => ({ asks: s.asks.filter((a) => a.id !== id) }));
      // "Allow edits this session" is the terminal's switch to accepting edits: show it in the mode too.
      if (decision === "always" && ask && EDIT_TOOLS.includes(ask.tool)) get().setMode("acceptEdits");
      // Approving a plan leaves plan mode, as the terminal does.
      if (decision !== "deny" && ask?.tool === "ExitPlanMode")
        get().setMode(decision === "always" ? "acceptEdits" : "default");
      const chat = get().chat.id;
      if (!chat) return;
      try {
        await fetch(`/api/chats/${chat}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, decision }),
        });
      } catch {
        // the turn ends on its own if it can't hear back
      }
    },

    async stop() {
      const chat = get().chat;
      if (!chat.busy || !chat.id) return;
      try {
        await fetch(`/api/chats/${chat.id}/stop`, { method: "POST" });
      } catch {
        // offline: the turn ends on its own
      }
    },

    reset(pr) {
      if (pr === get().pr) return;
      for (const c of ctrls) c.abort();
      // Chat starts in the guide's own session, picking up any earlier turns in it.
      set({ pr, chat: emptyChat("guide"), history: [], historyOpen: false, error: null });
      void get().openGuide();
    },
    async openGuide() {
      const from = get().chat.key;
      let chat = emptyChat("guide");
      try {
        const res = await fetch(`/api/chats/guide?url=${encodeURIComponent(get().pr)}`);
        if (res.ok) chat = fromWire(await res.json());
      } catch {
        // no earlier turns: start it fresh
      }
      // Don't swap out a chat the reviewer moved to meanwhile.
      if (get().chat.key !== from) return;
      set({ chat, historyOpen: false, error: null });
    },
    async syncGuide() {
      const { chat, pr } = get();
      const settled = (c: Chat) => !c.busy && c.questions.every((q) => q.status === "answered" || q.status === "error");
      if (chat.kind !== "guide" || !settled(chat)) return;
      try {
        const res = await fetch(`/api/chats/guide?url=${encodeURIComponent(pr)}`);
        if (!res.ok) return;
        const next = fromWire(await res.json());
        const now = get().chat;
        if (now.key !== chat.key || !settled(now) || next.questions.length === now.questions.length) return;
        set({ chat: { ...next, key: now.key } });
      } catch {
        // offline: keep what's on screen
      }
    },
    newChat() {
      const { chat } = get();
      if (!chat.questions.length && chat.kind === "fork") return set({ historyOpen: false });
      set({ chat: emptyChat("fork"), historyOpen: false, error: null });
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
    editStaged(id, text) {
      if (!text) return get().unstage(id);
      set((s) => ({ chat: { ...s.chat, questions: s.chat.questions.map((q) => (q.id === id ? { ...q, text } : q)) } }));
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
  kind?: ChatKind;
  harness?: string | null;
  turns: {
    questions: { n: number; text: string; anchor: (WireAnchor & { ui?: Partial<Anchor> }) | null }[];
    answers: Record<string, string>;
    tools: string[];
    shows?: (Show & { n: number })[];
    guide_version?: number;
    source?: string;
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
        fromSession: t.source === "session",
        trace: t.trace ?? t.tools.map((tool) => ({ tool })),
        seconds: t.seconds,
      });
    });
  });
  return {
    key: ++chatSeq,
    id: c.id,
    kind: c.kind ?? "fork",
    harness: c.harness ?? null,
    questions,
    turns: c.turns.length,
    nextN,
    busy: false,
  };
}
