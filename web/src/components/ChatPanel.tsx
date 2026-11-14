import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  FileCode,
  FilePen,
  FileText,
  FlaskConical,
  GitFork,
  Hand,
  History,
  Layers,
  ListChecks,
  LocateFixed,
  Lock,
  MessageCircle,
  Search,
  ShieldAlert,
  Sparkles,
  Square,
  SquarePen,
  SquareTerminal,
  Workflow,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Anchor,
  type Ask,
  type ChatMode,
  EDIT_TOOLS,
  guideSessionOf,
  modesFor,
  type Question,
  type Show,
  useChat,
} from "../chat";
import { autosize } from "../lib/autosize";
import { type CodeLoc, expandCites, parseCites, parsePath, type Resolved, repoPath, resolveLoc } from "../lib/cite";
import { useHunkIndex } from "../lib/linking";
import { InlineCodeContext, Markdown } from "../lib/md";
import { CHAT_W, startResize } from "../lib/panes";
import { storage } from "../lib/storage";
import { ago } from "../lib/time";
import { cachedTree } from "../lib/tree";
import { useApp } from "../store";
import type { StepKind } from "../types";
import { useUI } from "../ui";
import { HarnessMark, harnessName, ic, STEP_ICON } from "./icons";

export interface ChatLinkProps {
  /** Hover a question (by local id) to highlight its lines; null clears. */
  onHoverQ: (id: string | null) => void;
  /** Click a question to scroll to + flash its lines. */
  onFocusQ: (q: Question) => void;
  hoverQ: string | null;
  flashQ: { id: string; n: number } | null;
}

export function ChatPanel({ onWidth, link }: { onWidth: (w: number) => void; link: ChatLinkProps }) {
  const { chat, historyOpen, setHistoryOpen, newChat, error } = useChat();
  const toggleChat = useApp((s) => s.toggleChat);
  const meta = useApp((s) => s.guide?.meta);
  const guideHarness = meta?.harness ?? null;
  // Back from the terminal: show what was said to the guide's session there.
  useEffect(() => {
    const sync = () => document.visibilityState === "visible" && void useChat.getState().syncGuide();
    addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  // The guide session, unless it can't be continued (then the first question starts a fork).
  const isGuide = chat.kind === "guide" && (chat.id != null || !!guideSessionOf(meta));
  const msgs = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const sent = chat.questions.filter((q) => q.turn != null);
  const title = chatTitle(sent);

  useEffect(() => {
    const el = msgs.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const turns = groupTurns(sent);
  const asks = useChat((s) => s.asks);
  // The conversation the session had in the terminal before this chat: folded to one line until opened.
  let earlier = turns.findIndex((qs) => !qs.every((q) => q.fromSession));
  if (earlier < 0) earlier = turns.length;
  const [showEarlier, setShowEarlier] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fold again whenever another chat opens
  useEffect(() => setShowEarlier(false), [chat.key]);

  // The model's first show_code of a turn jumps the diff (chat.ts decides whether the reviewer was busy there).
  const autoShow = useChat((s) => s.autoShow);
  const resolve = useResolveLoc();
  useEffect(() => {
    if (!autoShow) return;
    const show = useChat.getState().chat.questions.find((q) => q.id === autoShow.q)?.shows[autoShow.i];
    const r = show && resolve(show);
    if (r) useUI.getState().focus(r.keys, r.files);
  }, [autoShow, resolve]);

  return (
    <aside className="chat">
      <Resizer onWidth={onWidth} />
      <div className="chat-h">
        <span className="chat-mark" title={harnessName(chat.harness ?? guideHarness)}>
          <HarnessMark harness={chat.harness ?? guideHarness} size={15} />
        </span>
        {historyOpen ? (
          <span className="chat-title">History</span>
        ) : isGuide ? (
          <span className="chat-title" title="The session that wrote the guide, continued">
            Guide session
          </span>
        ) : (
          <span className={`chat-title${title ? "" : " none"}`} title={title || undefined}>
            <span className="kind" title="A fork of the guide session">
              {ic(GitFork, 13)}
            </span>
            {title || "New chat"}
          </span>
        )}
        <button
          type="button"
          className={`icon-btn sm${historyOpen ? " on" : ""}`}
          title="History"
          onClick={() => setHistoryOpen(!historyOpen)}
        >
          {ic(History, 15)}
        </button>
        <button type="button" className="icon-btn sm" title="New chat" onClick={newChat}>
          {ic(SquarePen, 15)}
        </button>
        <button type="button" className="icon-btn sm" title="Close" onClick={() => toggleChat(false)}>
          {ic(X, 15)}
        </button>
      </div>
      {historyOpen && <HistoryList />}
      <div
        className="msgs"
        ref={msgs}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {!turns.length ? (
          <Empty />
        ) : (
          <InlineCodeContext.Provider value={Cite}>
            <div className="thread">
              {earlier > 0 && (
                <button
                  type="button"
                  className={`earlier${showEarlier ? " open" : ""}`}
                  aria-expanded={showEarlier}
                  onClick={() => setShowEarlier(!showEarlier)}
                >
                  {ic(SquareTerminal, 14)}
                  <span>
                    {earlier} {earlier === 1 ? "turn" : "turns"} in the terminal
                  </span>
                  <span className="grow" />
                  {ic(ChevronDown, 14)}
                </button>
              )}
              {turns.map((qs, i) => (i < earlier && !showEarlier ? null : <Turn key={i} qs={qs} link={link} />))}
              {asks.map((a, i) => (
                <AskCard key={a.id} a={a} first={i === 0} />
              ))}
            </div>
          </InlineCodeContext.Provider>
        )}
        {error && <div className="chat-err">{error}</div>}
      </div>
      <Composer link={link} />
    </aside>
  );
}

/** Same rule as the engine's history title: the first question asked. */
const chatTitle = (sent: Question[]) => [...sent].sort((a, b) => a.turn! - b.turn!)[0]?.text.trim() ?? "";

function useResolveLoc(): (loc: CodeLoc) => Resolved | null {
  const files = useApp((s) => s.files);
  const idx = useHunkIndex();
  return useCallback((loc: CodeLoc) => resolveLoc(loc, files, idx), [files, idx]);
}

/** Hover highlights the rows; click scrolls to and flashes them. */
const locLink = (r: Resolved) => ({
  onMouseEnter: () => useUI.getState().setHover(r.keys),
  onMouseLeave: () => useUI.getState().setHover([]),
  onClick: (e: React.MouseEvent) => {
    e.stopPropagation();
    useUI.getState().focus(r.keys, r.files);
  },
});

/** Inline code in answers: `path:line` citations of diff lines become links (shown by file name; full path on
 *  hover); others stay plain code. A list on one file (`a.ts:3, 8–10`) links each range. */
function Cite({ text }: { text: string }) {
  const cites = useMemo(() => parseCites(text), [text]);
  const path = useMemo(() => (cites ? null : parsePath(text)), [cites, text]);
  if (path) return <PathLink path={path} label={text.trim()} />;
  if (!cites) return <code>{text}</code>;
  if (cites.length === 1) return <CiteLink {...cites[0]} />;
  return (
    <span className="cite-list">
      {cites.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && ", "}
          <CiteLink {...c} />
        </Fragment>
      ))}
    </span>
  );
}

function CiteLink({ loc, text }: { loc: CodeLoc; text: string }) {
  const resolve = useResolveLoc();
  const r = useMemo(() => resolve(loc), [loc, resolve]);
  if (!r)
    return (
      <button
        type="button"
        className="cite"
        title={`${loc.file} · Open in a tab`}
        onClick={(e) => {
          e.stopPropagation();
          useUI.getState().openFile(loc.file, { line: loc.start, end: loc.end });
        }}
      >
        <code>{text.trim().replace(/^.*\//, "")}</code>
      </button>
    );
  return (
    <button type="button" className="cite" title={`${r.file} · Show in diff`} {...locLink(r)}>
      <code>{text.trim().replace(/^.*\//, "")}</code>
    </button>
  );
}

/** Every file the reviewer can open: the diff's, and (once loaded) the rest of the repository's. */
function useKnownFiles(): string[] {
  const files = useApp((s) => s.files);
  const url = useApp((s) => s.pr?.url ?? s.url);
  const [tree, setTree] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    if (url) void cachedTree(url).then((t) => live && setTree(t));
    return () => {
      live = false;
    };
  }, [url]);
  return useMemo(() => [...new Set([...files.map((f) => f.path), ...tree])], [files, tree]);
}

/** A file named without a line (in an answer, or an approval card): opens it in the diff when it's changed, else in
 *  a tab; ⌘-click always opens a tab. Shown by `label`, else by its path in the repository. */
function PathLink({ path, label }: { path: string; label?: string }) {
  const known = useKnownFiles();
  const files = useApp((s) => s.files);
  const resolve = useResolveLoc();
  const repo = useMemo(() => repoPath(path, known), [path, known]);
  if (!repo) return <code>{label ?? path}</code>;
  const inDiff = files.some((f) => f.path === repo);
  return (
    <button
      type="button"
      className="cite"
      title={`${repo} · ${inDiff ? "Show in diff" : "Open in a tab"}`}
      onClick={(e) => {
        e.stopPropagation();
        const r = inDiff && !(e.metaKey || e.ctrlKey) ? resolve({ file: repo, start: 1, end: 1e9, side: "new" }) : null;
        if (r) {
          useUI.getState().showTab(null);
          useUI.getState().focus(r.keys.slice(0, 1), r.files);
        } else useUI.getState().openFile(repo, undefined, e.metaKey || e.ctrlKey);
      }}
    >
      <code>{label ? label.replace(/^.*\//, "") : repo}</code>
    </button>
  );
}

const locText = (s: CodeLoc) => `${s.file.split("/").pop()}:${s.start}${s.end !== s.start ? `–${s.end}` : ""}`;

/** Regions the model pointed at with show_code. */
function Shows({ shows }: { shows: Show[] }) {
  const resolve = useResolveLoc();
  return (
    <div className="shows">
      {shows.map((s, i) => {
        const r = resolve(s);
        return (
          <button
            key={i}
            className="show-chip"
            disabled={!r}
            title={r ? "Show in diff" : "No longer in this diff"}
            {...(r ? locLink(r) : {})}
          >
            {ic(LocateFixed, 13)}
            {s.label && <span className="lbl">{s.label}</span>}
            <span className="loc">{locText(s)}</span>
          </button>
        );
      })}
    </div>
  );
}

function groupTurns(qs: Question[]): Question[][] {
  const by = new Map<number, Question[]>();
  for (const q of qs) by.set(q.turn!, [...(by.get(q.turn!) ?? []), q]);
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

function Resizer({ onWidth }: { onWidth: (w: number) => void }) {
  return (
    <div
      className="resizer"
      title="Drag to resize · double-click to reset"
      onDoubleClick={() => {
        onWidth(CHAT_W);
        storage.set("rv-chat-w", CHAT_W);
      }}
      onMouseDown={(e) => startResize(e, (x) => innerWidth - x, onWidth, "rv-chat-w")}
    />
  );
}

function HistoryList() {
  const { history, chat, openChat, openGuide } = useChat();
  const meta = useApp((s) => s.guide?.meta);
  const live = guideSessionOf(meta);
  const guide = history.find((c) => c.kind === "guide");
  const forks = history.filter((c) => c.kind !== "guide");
  return (
    <div className="hist">
      {(live || guide) && (
        <>
          <div
            className={`h-item guide${chat.kind === "guide" ? " active" : ""}`}
            onClick={() => void openGuide()}
            title="The session that wrote the guide, continued"
          >
            <span className="h-ic">
              <HarnessMark harness={guide?.harness ?? meta?.harness} size={15} />
            </span>
            <div className="h-body">
              <div className="h-t">Guide session</div>
              <div className="h-m">
                <span>{harnessName(guide?.harness ?? meta?.harness)}</span>
                {guide && (
                  <span>
                    {ic(MessageCircle, 12)}
                    {guide.questions}
                  </span>
                )}
                <span className="grow" />
                {guide && <span>{ago(guide.updated_at)}</span>}
              </div>
            </div>
          </div>
          {forks.length > 0 && <div className="h-div" />}
        </>
      )}
      {!forks.length && !live && !guide && <div className="h-empty">{ic(History, 18)}</div>}
      {forks.map((c) => (
        <div key={c.id} className={`h-item${c.id === chat.id ? " active" : ""}`} onClick={() => void openChat(c.id)}>
          <span className="h-ic" title="A fork of the guide session">
            {ic(GitFork, 15)}
          </span>
          <div className="h-body">
            <div className="h-t">{c.title || "Chat"}</div>
            <div className="h-m">
              <span>
                {ic(MessageCircle, 12)}
                {c.questions}
              </span>
              {c.anchored > 0 && (
                <span>
                  {ic(FileCode, 12)}
                  {c.anchored}
                </span>
              )}
              <span className="grow" />
              <span>{ago(c.updated_at)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

const SUGG = [
  { icon: ShieldAlert, label: "Risks", q: "What are the risks in this PR?" },
  { icon: FlaskConical, label: "Test gaps", q: "What isn't tested?" },
  { icon: Workflow, label: "Flow", q: "Explain the flow end to end." },
];

function Empty() {
  const ask = useChat((s) => s.ask);
  return (
    <div className="empty">
      <div className="big">{ic(Sparkles, 20)}</div>
      <div className="sugg">
        {SUGG.map((s) => (
          <button type="button" key={s.label} onClick={() => ask(s.q)}>
            {ic(s.icon, 14)}
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export const rangeTxt = (a: number, b: number) => (a === b ? `L${a}` : `L${a}–${b}`);
export const anchorLabel = (a: Anchor) =>
  a.step != null ? `Step ${a.step}` : `${a.file.split("/").pop()}:${a.start}${a.end !== a.start ? `–${a.end}` : ""}`;

function CtxCard({ a }: { a: Anchor }) {
  if (a.step != null) {
    const Kind = STEP_ICON[(a.stepKind as StepKind) ?? "core"] ?? Layers;
    return (
      <div className="ctx-card">
        <div className="h">
          {ic(Kind, 13)}Step {a.step} · {a.stepTitle}
        </div>
      </div>
    );
  }
  return (
    <div className="ctx-card">
      <div className="h">
        {ic(FileCode, 13)}
        {a.file.split("/").pop()}
        <span>{rangeTxt(a.start, a.end)}</span>
      </div>
      <pre>{a.code}</pre>
    </div>
  );
}

export const Qn = ({ q }: { q: Question }) =>
  q.n ? <span className={`qn${q.status === "staged" ? " staged" : ""}`}>{q.n}</span> : null;

function Turn({ qs, link }: { qs: Question[]; link: ChatLinkProps }) {
  const multi = qs.length > 1 || qs.some((q) => q.n);
  const pending = qs.some((q) => q.status === "pending");
  const linked = (q: Question) =>
    q.anchor
      ? {
          "data-q": q.id,
          onMouseEnter: () => link.onHoverQ(q.id),
          onMouseLeave: () => link.onHoverQ(null),
          onClick: () => link.onFocusQ(q),
        }
      : {};
  return (
    <>
      <div className="msg user">
        {qs.map((q) => (
          <div key={q.id} className={`q-item${link.hoverQ === q.id ? " hover" : ""}`} {...linked(q)}>
            {q.anchor && <CtxCard a={q.anchor} />}
            <div className="bubble">
              <Qn q={q} />
              {q.text}
            </div>
          </div>
        ))}
      </div>
      <div className="msg ai">
        <div className="ai-body">
          <Trace q={qs[0]} pending={pending} />
          {qs.map((q) => (
            <div
              key={q.id}
              className={`ans${link.flashQ?.id === q.id ? ` qflash f${link.flashQ.n % 2}` : ""}`}
              data-ans={q.id}
            >
              {multi && (
                <div className={`ans-h${link.hoverQ === q.id ? " hover" : ""}`} {...linked(q)}>
                  <Qn q={q} />
                  {q.anchor ? anchorLabel(q.anchor) : q.text.slice(0, 28)}
                </div>
              )}
              <div className="ans-t">
                {q.answer ? (
                  // While streaming, the cursor sits at the end of the last line, so nothing moves when it goes.
                  <div className={q.status === "pending" ? "streaming" : undefined}>
                    <Markdown text={expandCites(q.answer)} />
                  </div>
                ) : (
                  q.status === "pending" && <span className="cursor" />
                )}
                {q.status === "error" && !q.answer && <span className="ans-err">—</span>}
              </div>
              {q.shows.length > 0 && <Shows shows={q.shows} />}
              {q.guideVersion != null && <GuideUpdated v={q.guideVersion} />}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

const secs = (s: number) => (s < 60 ? `${Math.max(1, Math.round(s))}s` : `${Math.round(s / 60)}m`);

/** A reasoning summary's headline: its first bold phrase, else its first sentence. */
export const headline = (think: string) => {
  const bold = think.match(/\*\*(.+?)\*\*/);
  const first = (bold ? bold[1] : think.trim().split(/(?<=[.!?])\s|\n/)[0]).trim();
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
};

const TOOL_ICONS: Partial<Record<string, typeof Wrench>> = {
  Ran: SquareTerminal,
  Read: FileText,
  Grep: Search,
  Glob: Search,
  Search: Search,
  Diff: FileCode,
  Show: FileCode,
};

/** One tool call as a quiet line, the way chat apps show them: an icon, a verb, and what it acted on. */
function ToolRow({ summary, failed }: { summary: string; failed?: boolean }) {
  const sp = summary.indexOf(" ");
  const verb = sp < 0 ? summary : summary.slice(0, sp);
  const Icon = TOOL_ICONS[verb];
  return (
    <li className={`trace-tool${failed ? " failed" : ""}`} title={failed ? `${summary} · failed` : summary}>
      {ic(Icon ?? Wrench, 12)}
      {Icon ? (
        <>
          <span className="verb">{verb}</span>
          <code>{summary.slice(sp + 1)}</code>
        </>
      ) : (
        <span className="arg">{summary}</span>
      )}
      {failed && <span className="fail">Failed</span>}
    </li>
  );
}

/** What the agent did for a turn, folded into one quiet line that opens to a timeline: reasoning and tool calls in
 * the order they happened. While it runs, the line shows the latest step. */
function Trace({ q, pending }: { q: Question; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const trace = q.trace ?? [];
  if (!trace.length) return null;
  const thought = trace.some((t) => "think" in t);
  const tools = trace.filter((t) => "tool" in t).length;
  let label: string;
  if (pending) {
    const last = trace.at(-1)!;
    label = "tool" in last ? last.tool : headline(last.think) || "Thinking";
  } else {
    const verb = thought ? "Thought" : "Worked";
    label = [
      q.seconds != null ? `${verb} for ${secs(q.seconds)}` : verb,
      tools ? `${tools} tool${tools === 1 ? "" : "s"}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return (
    <div className={`trace${open ? " open" : ""}`}>
      <button type="button" className="trace-h" title={label} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span key={pending ? label : undefined} className={`trace-l${pending ? " trace-live" : ""}`}>
          {label}
        </span>
        {ic(ChevronRight, 12)}
      </button>
      {open && (
        <ol className="trace-b">
          {trace.map((t, i) =>
            "think" in t ? (
              <li key={i} className="trace-think">
                <Markdown text={t.think} />
              </li>
            ) : (
              <ToolRow key={i} summary={t.tool} failed={t.failed} />
            ),
          )}
        </ol>
      )}
    </div>
  );
}

/** An answer that changed the guide links to the version it saved. */
function GuideUpdated({ v }: { v: number }) {
  const current = useApp((s) => s.guide?.version);
  return (
    <button
      type="button"
      className={`guide-upd${current === v ? " on" : ""}`}
      title={current === v ? "Showing this version" : "Show this version"}
      onClick={() => void useApp.getState().showVersion(v)}
    >
      {ic(History, 13)}
      Updated the guide
      <span>v{v}</span>
    </button>
  );
}

const MODE_UI: Record<ChatMode, { icon: typeof Lock; label: string; hint: string }> = {
  default: { icon: Hand, label: "Manual", hint: "Asks before anything the session's settings don't allow" },
  acceptEdits: { icon: FilePen, label: "Accept edits", hint: "Edits files without asking; asks before commands" },
  plan: { icon: ListChecks, label: "Plan", hint: "Reads and plans; changes nothing until you approve" },
  auto: { icon: Zap, label: "Auto", hint: "Acts without asking; a safety check blocks risky actions" },
};

/** The guide session's permission mode, as in the harness. New chats fork the session and can only read. */
function ModeMenu() {
  const { chat, mode, setMode } = useChat();
  const guideHarness = useApp((s) => s.guide?.meta?.harness ?? null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const modes = chat.kind === "guide" ? modesFor(chat.harness ?? guideHarness) : [];
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("mousedown", away);
    addEventListener("keydown", esc);
    return () => {
      removeEventListener("mousedown", away);
      removeEventListener("keydown", esc);
    };
  }, [open]);
  if (!modes.length) {
    return (
      <span className="mode ro" title="New chats fork the guide session and can only read">
        {ic(Lock, 13)}
        <span>Read-only</span>
      </span>
    );
  }
  const cur = modes.includes(mode) ? mode : modes[0];
  const ui = MODE_UI[cur];
  return (
    <div className="mode-box" ref={box}>
      {open && (
        <div className="mode-menu" role="menu">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              role="menuitemradio"
              aria-checked={m === cur}
              className={`mode-item${m === cur ? " on" : ""}`}
              title={MODE_UI[m].hint}
              onClick={() => {
                setMode(m);
                setOpen(false);
              }}
            >
              {ic(MODE_UI[m].icon, 14)}
              <span>{MODE_UI[m].label}</span>
              <span className="grow" />
              {m === cur && ic(Check, 14)}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className={`mode m-${cur}`}
        title={ui.hint}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {ic(ui.icon, 13)}
        <span>{ui.label}</span>
        {ic(ChevronsUpDown, 12)}
      </button>
    </div>
  );
}

/** An edit as -/+ lines: Edit's old and new text, each of MultiEdit's, or a new file's contents. */
function editLines(a: Ask): { t: "add" | "del"; s: string }[] {
  const lines = (v: unknown) => (typeof v === "string" && v ? v.split("\n") : []);
  const pair = (e: Record<string, unknown>) => [
    ...lines(e.old_string).map((s) => ({ t: "del" as const, s })),
    ...lines(e.new_string).map((s) => ({ t: "add" as const, s })),
  ];
  if (a.tool === "Write") return lines(a.input.content).map((s) => ({ t: "add" as const, s }));
  if (a.tool === "MultiEdit" && Array.isArray(a.input.edits))
    return (a.input.edits as Record<string, unknown>[]).flatMap(pair);
  return pair(a.input);
}

/** A tool call the session's settings don't allow, put to the reviewer in the conversation, as the terminal does.
 * ↵ allows, Esc denies (the first card, while the composer is empty). */
function AskCard({ a, first }: { a: Ask; first: boolean }) {
  const answer = useChat((s) => s.answer);
  const edit = EDIT_TOOLS.includes(a.tool);
  const plan = a.tool === "ExitPlanMode" && typeof a.input.plan === "string" ? a.input.plan : null;
  const path = typeof a.input.file_path === "string" ? a.input.file_path : null;
  const diff = edit ? editLines(a) : [];
  const adds = diff.filter((l) => l.t === "add").length;
  const dels = diff.length - adds;
  useEffect(() => {
    if (!first) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLTextAreaElement && e.target.value.trim();
      if (typing || e.isComposing) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void answer(a.id, "allow");
      } else if (e.key === "Escape") void answer(a.id, "deny");
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [first, a.id, answer]);
  return (
    <div className="ask-card" role="alertdialog" aria-label={`Allow ${a.summary}?`}>
      <div className="ask-h">
        {ic(plan !== null ? ListChecks : edit ? FilePen : a.tool === "Bash" ? SquareTerminal : Wrench, 14)}
        <span className="verb">
          {plan !== null
            ? "Ready to code?"
            : edit
              ? a.tool === "Write"
                ? "Write"
                : "Edit"
              : a.tool === "Bash"
                ? "Run"
                : a.tool}
        </span>
        {edit && path && <PathLink path={path} />}
        <span className="grow" />
        {edit && diff.length > 0 && (
          <span className="cnt">
            <span className="a">+{adds}</span> <span className="d">−{dels}</span>
          </span>
        )}
      </div>
      {plan !== null ? (
        <div className="ask-plan">
          <Markdown text={plan} />
        </div>
      ) : edit && diff.length > 0 ? (
        <pre className="ask-diff">
          {diff.slice(0, 200).map((l, i) => (
            <span key={i} className={l.t}>
              {l.t === "add" ? "+ " : "− "}
              {l.s}
              {"\n"}
            </span>
          ))}
        </pre>
      ) : (
        <pre className="ask-d">
          {typeof a.input.command === "string" ? a.input.command : (path ?? JSON.stringify(a.input, null, 2))}
        </pre>
      )}
      <div className="ask-b">
        <button type="button" className="ask-act ghost" title="Deny (Esc)" onClick={() => void answer(a.id, "deny")}>
          {plan !== null ? "Keep planning" : "Deny"}
        </button>
        <span className="grow" />
        <button type="button" className="ask-act" onClick={() => void answer(a.id, "always")}>
          {plan !== null ? "Approve, accept edits" : edit ? "Allow edits this session" : "Allow this session"}
        </button>
        <button type="button" className="ask-act primary" title="Allow (↵)" onClick={() => void answer(a.id, "allow")}>
          {plan !== null ? "Approve" : "Allow"} <span className="k">↵</span>
        </button>
      </div>
    </div>
  );
}

/** For tests: the card for a waiting ask, by id. */
export function AskCardForTest({ id }: { id: string }) {
  const a = useChat((s) => s.asks.find((x) => x.id === id));
  return a ? <AskCard a={a} first /> : null;
}

/** A line note (attached, or queued): hover lights its lines, click goes to them. */
const noteLink = (q: Question, link: ChatLinkProps) =>
  q.anchor
    ? {
        "data-q": q.id,
        onMouseEnter: () => link.onHoverQ(q.id),
        onMouseLeave: () => link.onHoverQ(null),
        onClick: () => link.onFocusQ(q),
      }
    : {};

function RemoveBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn sm x"
      title="Remove"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {ic(X, 12)}
    </button>
  );
}

function Composer({ link }: { link: ChatLinkProps }) {
  const { chat, unstage, ask, sendStaged, stop } = useChat();

  const [text, setText] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const staged = chat.questions.filter((q) => q.status === "staged");
  const waiting = chat.questions.filter((q) => q.status === "waiting");
  // Queuing a line comment puts you here, so ↵ sends the batch (the popup that queued it has just closed).
  const queued = useRef(staged.length);
  useEffect(() => {
    if (staged.length > queued.current) requestAnimationFrame(() => ta.current?.focus());
    queued.current = staged.length;
  }, [staged.length]);

  const send = () => {
    if (staged.length) sendStaged(text);
    else if (text.trim()) ask(text.trim());
    else return;
    setText("");
    requestAnimationFrame(() => autosize(ta.current, 12));
  };

  return (
    <div className="composer-wrap">
      {waiting.length > 0 && (
        <div className="queue">
          {waiting.map((q) => (
            <div key={q.id} className="queue-row" {...noteLink(q, link)}>
              {ic(Clock, 13)}
              {q.anchor && <Qn q={q} />}
              <span className="qt">{q.text}</span>
              <button
                type="button"
                className="icon-btn sm"
                title="Send now"
                onClick={(e) => {
                  e.stopPropagation();
                  void stop();
                }}
              >
                {ic(ArrowUp, 13)}
              </button>
              <RemoveBtn onClick={() => unstage(q.id)} />
            </div>
          ))}
        </div>
      )}
      <div className="composer stack">
        {staged.length > 0 && (
          <div className="notes">
            {staged.map((q) => (
              <div
                key={q.id}
                title={q.text}
                className={`note${link.hoverQ === q.id || link.flashQ?.id === q.id ? " hover" : ""}${link.flashQ?.id === q.id ? ` qflash f${link.flashQ.n % 2}` : ""}`}
                {...noteLink(q, link)}
              >
                <Qn q={q} />
                <span className="ref">{q.anchor ? anchorLabel(q.anchor) : ""}</span>
                <RemoveBtn onClick={() => unstage(q.id)} />
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder="Ask anything"
          onChange={(e) => {
            setText(e.target.value);
            autosize(e.target, 12);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="c-row">
          <ModeMenu />
          <span className="grow" />
          {chat.busy && !text.trim() && !staged.length ? (
            <button
              type="button"
              id="chatSend"
              className="icon-btn solid stop"
              title="Stop"
              onClick={() => void stop()}
            >
              {ic(Square, 12)}
            </button>
          ) : (
            <button type="button" id="chatSend" className="icon-btn solid" title="Send" onClick={send}>
              {ic(ArrowUp, 16)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
