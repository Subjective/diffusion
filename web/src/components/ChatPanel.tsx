import {
  ArrowUp,
  Clock,
  FileCode,
  FlaskConical,
  History,
  Layers,
  LoaderCircle,
  MessageCircle,
  ShieldAlert,
  Sparkles,
  SquarePen,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type Anchor, type Question, useChat } from "../chat";
import { Markdown } from "../lib/md";
import { CHAT_W, startResize } from "../lib/panes";
import { storage } from "../lib/storage";
import { useApp } from "../store";
import type { StepKind } from "../types";
import { ic, STEP_ICON } from "./icons";

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
  const msgs = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const sent = chat.questions.filter((q) => q.turn != null);
  const title = chatTitle(sent);

  useEffect(() => {
    const el = msgs.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const turns = groupTurns(sent);
  const waiting = chat.questions.filter((q) => q.status === "waiting");

  return (
    <aside className="chat">
      <Resizer onWidth={onWidth} />
      <div className="chat-h">
        {ic(MessageCircle, 16)}
        <span className={`chat-title${title ? "" : " none"}`} title={title || undefined}>
          {title || "New chat"}
        </span>
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
          <div className="thread">
            {turns.map((qs, i) => (
              <Turn key={i} qs={qs} link={link} />
            ))}
            {waiting.length > 0 && <Waiting qs={waiting} link={link} />}
          </div>
        )}
        {error && <div className="chat-err">{error}</div>}
      </div>
      <Composer link={link} />
    </aside>
  );
}

/** Same rule as the engine's history title: the first question asked. */
const chatTitle = (sent: Question[]) => [...sent].sort((a, b) => a.turn! - b.turn!)[0]?.text.trim() ?? "";

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

const ago = (t: number) => {
  const m = Math.round((Date.now() / 1000 - t) / 60);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

function HistoryList() {
  const { history, chat, openChat } = useChat();
  return (
    <div className="hist">
      {!history.length && <div className="h-empty">{ic(History, 18)}</div>}
      {history.map((c) => (
        <div key={c.id} className={`h-item${c.id === chat.id ? " active" : ""}`} onClick={() => void openChat(c.id)}>
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
  const tools = pending ? qs[0].tools : [];
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
        <div className="ai-av">{ic(Sparkles, 14)}</div>
        <div className="ai-body">
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
                {q.answer ? <Markdown text={q.answer} /> : null}
                {q.status === "pending" && <span className="cursor" />}
                {q.status === "error" && !q.answer && <span className="ans-err">—</span>}
              </div>
            </div>
          ))}
          {tools.length > 0 && (
            <div className="tool-log in-chat">
              {tools.slice(-4).map((t, i) => (
                <span key={i} className="tool-chip">
                  {t}
                </span>
              ))}
              <span className="spin">{ic(LoaderCircle, 12)}</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** Questions asked while an answer was streaming; they go out together as the next turn. */
function Waiting({ qs, link }: { qs: Question[]; link: ChatLinkProps }) {
  return (
    <div className="msg user waiting">
      {qs.map((q) => (
        <div
          key={q.id}
          className={`q-item${link.hoverQ === q.id ? " hover" : ""}`}
          {...(q.anchor
            ? {
                "data-q": q.id,
                onMouseEnter: () => link.onHoverQ(q.id),
                onMouseLeave: () => link.onHoverQ(null),
                onClick: () => link.onFocusQ(q),
              }
            : {})}
        >
          {q.anchor && <CtxCard a={q.anchor} />}
          <div className="bubble">
            <Qn q={q} />
            {q.text}
          </div>
        </div>
      ))}
      <div className="wait-note" title="Sends when the current answer finishes">
        {ic(Clock, 12)}
        {qs.length}
      </div>
    </div>
  );
}

function Composer({ link }: { link: ChatLinkProps }) {
  const { chat, unstage, clearStaged, ask, sendStaged } = useChat();
  const [text, setText] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const staged = chat.questions.filter((q) => q.status === "staged");

  const send = () => {
    if (staged.length) sendStaged(text);
    else if (text.trim()) ask(text.trim());
    else return;
    setText("");
    if (ta.current) ta.current.style.height = "";
  };

  return (
    <div className="composer-wrap">
      {staged.length > 0 && (
        <div className="tray">
          <div className="tray-h">
            {ic(Layers, 13)}
            <span>{staged.length}</span>
            <span className="grow" />
            <button type="button" className="icon-btn sm" title="Clear queue" onClick={clearStaged}>
              {ic(Trash2, 14)}
            </button>
          </div>
          {staged.map((q) => (
            <div
              key={q.id}
              className={`q-row${link.hoverQ === q.id || link.flashQ?.id === q.id ? " hover" : ""}${link.flashQ?.id === q.id ? ` qflash f${link.flashQ.n % 2}` : ""}`}
              data-q={q.id}
              onMouseEnter={() => link.onHoverQ(q.id)}
              onMouseLeave={() => link.onHoverQ(null)}
              onClick={() => link.onFocusQ(q)}
            >
              <Qn q={q} />
              <span className="ref">{q.anchor ? anchorLabel(q.anchor) : ""}</span>
              <span className="qt">{q.text}</span>
              <button
                type="button"
                className="icon-btn sm x"
                title="Remove"
                onClick={(e) => {
                  e.stopPropagation();
                  unstage(q.id);
                }}
              >
                {ic(X, 13)}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer">
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={
            staged.length
              ? "Add a message, or send"
              : chat.busy
                ? "Ask another — sends after this answer"
                : "Ask anything"
          }
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "";
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          type="button"
          id="chatSend"
          className="icon-btn solid"
          title={staged.length ? `Send ${staged.length}` : "Send (↵)"}
          onClick={send}
        >
          {ic(ArrowUp, 16)}
          {staged.length > 0 && <span className="send-n">{staged.length}</span>}
        </button>
      </div>
    </div>
  );
}
