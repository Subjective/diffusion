import {
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleX,
  EyeOff,
  FileCode,
  Pencil,
  Trash2,
  User,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { create } from "zustand";
import { useChat } from "../chat";
import { autosize } from "../lib/autosize";
import { Inline, Markdown } from "../lib/md";
import { type HunkIndex, rowKey } from "../lib/refs";
import { ago, dateText } from "../lib/time";
import { tip } from "../lib/tips";
import { type PendingComment, useReview } from "../review";
import { useApp } from "../store";
import type { Check as CheckRun, Thread, ThreadComment } from "../types";
import { useUI } from "../ui";
import { HarnessMark, harnessName, ic } from "./icons";

/** Where GitHub's review threads sit on the diff: under the last line each covers (`after`), with every covered
 *  line marked (`ranged`), and file-level threads under their file's header (`top`). */
export interface ThreadLayout {
  after: Map<string, ReactNode>;
  ranged: Set<string>;
  top: Map<string, ReactNode>;
  /** The diff rows each thread covers, for hover and jumping to it. */
  keys: Map<string, string[]>;
}

/** The diff rows a thread covers: its lines on its side, among the rows the diff shows. */
export function threadKeys(t: Thread, idx: HunkIndex): string[] {
  if (t.start == null || t.end == null) return [];
  const out: string[] = [];
  for (const [id, rows] of idx.rows) {
    if (idx.byId.get(id)?.file !== t.path) continue;
    for (const r of rows) {
      const n = t.side === "new" ? (r.type === "del" ? null : r.new) : r.type === "add" ? null : r.old;
      if (n != null && n >= t.start && n <= t.end) out.push(rowKey(r.file, r.pos));
    }
  }
  return out;
}

export const avatarOf = (login: string) => `https://avatars.githubusercontent.com/${login}?s=64`;

/** Your pending comments as threads of one comment, so they sit on the diff like the rest. */
export function pendingThreads(pending: PendingComment[], viewer: string): Thread[] {
  return pending.map((p) => ({
    id: p.id,
    path: p.path,
    side: p.side,
    start: p.start,
    end: p.end,
    file_level: false,
    resolved: false,
    outdated: false,
    pending: true,
    comments: [
      { id: p.id, author: viewer, avatar: avatarOf(viewer), bot: false, body: p.body, created_at: 0, url: "" },
    ],
  }));
}

/** A failing check's notes on the code, as threads on the lines they point at. */
export function checkThreads(checks: CheckRun[]): Thread[] {
  return checks.flatMap((c) =>
    c.state !== "failure"
      ? []
      : (c.annotations ?? []).map((a, i) => ({
          id: `ci:${c.name}:${i}`,
          path: a.path,
          side: "new" as const,
          start: a.start ?? a.end,
          end: a.end ?? a.start,
          file_level: a.start == null && a.end == null,
          resolved: false,
          outdated: false,
          ci: { name: c.name, url: c.url },
          comments: [
            {
              id: `ci:${c.name}:${i}`,
              author: c.name,
              avatar: "",
              bot: true,
              body: a.title ? `**${a.title}** ${a.message}` : a.message,
              created_at: 0,
              url: c.url,
            },
          ],
        })),
  );
}

export function threadLayout(threads: Thread[], idx: HunkIndex, hidden: string[]): ThreadLayout {
  const after = new Map<string, Thread[]>();
  const top = new Map<string, Thread[]>();
  const ranged = new Set<string>();
  const keys = new Map<string, string[]>();
  for (const t of threads) {
    if (hidden.includes(t.path) || t.outdated) continue;
    if (t.file_level) {
      top.set(t.path, [...(top.get(t.path) ?? []), t]);
      continue;
    }
    const ks = threadKeys(t, idx);
    if (!ks.length) continue;
    keys.set(t.id, ks);
    if (!t.resolved) for (const k of ks) ranged.add(k);
    const last = ks[ks.length - 1];
    after.set(last, [...(after.get(last) ?? []), t]);
  }
  const rows = (ts: Thread[]) => ts.map((t) => <ThreadRow key={t.id} t={t} keys={keys.get(t.id) ?? []} />);
  return {
    after: new Map([...after].map(([k, ts]) => [k, rows(ts)])),
    top: new Map([...top].map(([p, ts]) => [p, ts.map((t) => <ThreadCard key={t.id} t={t} keys={[]} />)])),
    ranged,
    keys,
  };
}

/** The same for a file tab, which shows the file at the head: threads on its new side, by line number. Threads on
 *  deleted lines have no line there. */
export function fileThreadLayout(threads: Thread[], path: string) {
  const after = new Map<number, ReactNode[]>();
  const ranged = new Set<number>();
  const top: ReactNode[] = [];
  for (const t of threads) {
    if (t.path !== path || t.outdated) continue;
    if (t.file_level) {
      top.push(<ThreadCard key={t.id} t={t} keys={[]} />);
      continue;
    }
    if (t.side !== "new" || t.end == null) continue;
    const start = t.start ?? t.end;
    const keys: string[] = [];
    for (let n = start; n <= t.end; n++) {
      keys.push(`f:${rowKey(path, n)}`);
      if (!t.resolved) ranged.add(n);
    }
    after.set(t.end, [...(after.get(t.end) ?? []), <ThreadRow key={t.id} t={t} keys={keys} />]);
  }
  return { after, ranged, top };
}

/** Where a thread is: its line range, "file", or "outdated". */
export const whereText = (t: Thread) =>
  t.file_level
    ? "file"
    : t.outdated || t.end == null
      ? "outdated"
      : t.start != null && t.start !== t.end
        ? `L${t.start}–${t.end}`
        : `L${t.end}`;

const Avatar = ({ c, size = 20 }: { c: Pick<ThreadComment, "avatar" | "author">; size?: number }) => (
  <img className="av" src={c.avatar} alt={c.author} width={size} height={size} />
);

/** A text box that grows with what's typed: ↵ saves, ⇧↵ is a new line, Esc cancels. */
function Compose({
  initial = "",
  placeholder,
  onSave,
  onCancel,
}: {
  initial?: string;
  placeholder: string;
  onSave: (text: string) => Promise<boolean> | boolean;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await onSave(text.trim());
    setBusy(false);
    if (ok !== false) onCancel();
  };
  return (
    <div className="th-compose">
      <textarea
        // biome-ignore lint/a11y/noAutofocus: opened by a click on Reply or Edit
        autoFocus
        rows={1}
        value={text}
        placeholder={placeholder}
        ref={(el) => {
          if (el) autosize(el, 8);
        }}
        onFocus={(e) => e.currentTarget.setSelectionRange(text.length, text.length)}
        onChange={(e) => {
          setText(e.target.value);
          autosize(e.target, 8);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <button
        type="button"
        className="icon-btn sm solid"
        {...tip("Save")}
        disabled={!text.trim() || busy}
        onClick={save}
      >
        {ic(Check, 14)}
      </button>
    </div>
  );
}

function CommentView({ c, t, mine }: { c: ThreadComment; t: Thread; mine: boolean }) {
  const [editing, setEditing] = useState(false);
  const act = useReview((s) => s.act);
  const editPending = useReview((s) => s.editPending);
  const save = (body: string) => {
    if (!t.pending) return act({ kind: "edit", comment: c.id, body }, t.id);
    editPending(c.id, body);
    return true;
  };
  const remove = () => (t.pending ? editPending(c.id, "") : act({ kind: "delete", comment: c.id }, t.id));
  return (
    <div className="th-c">
      {t.ci ? <span className="av ci">{ic(CircleX, 13)}</span> : <Avatar c={c} />}
      <div className="th-b">
        <div className="th-h">
          <b>{c.author}</b>
          {t.ci ? <span className="th-tag">CI</span> : c.bot && <span className="th-tag">bot</span>}
          {t.pending && <span className="th-tag pend">Pending</span>}
          {c.created_at > 0 && (
            <span className="th-t" data-tip={dateText(c.created_at)}>
              {ago(c.created_at)}
            </span>
          )}
          <span className="grow" />
          {mine && !editing && (
            <span className="th-acts">
              <button type="button" className="icon-btn sm" {...tip("Edit")} onClick={() => setEditing(true)}>
                {ic(Pencil, 13)}
              </button>
              <button type="button" className="icon-btn sm" {...tip("Delete")} onClick={() => void remove()}>
                {ic(Trash2, 13)}
              </button>
            </span>
          )}
          {t.ci?.url && (
            <a className="icon-btn sm" href={t.ci.url} target="_blank" rel="noreferrer" {...tip("Logs")}>
              {ic(ArrowUpRight, 14)}
            </a>
          )}
        </div>
        {editing ? (
          <Compose initial={c.body} placeholder="Comment" onSave={save} onCancel={() => setEditing(false)} />
        ) : (
          <div className="th-x">
            <Markdown text={c.body} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Opens the line popup on a thread's lines with the thread attached, to ask the agent about it (set by App). */
export const useThreadAsk = create<{ ask: ((t: Thread, x: number, y: number) => void) | null }>(() => ({ ask: null }));

/** Under a GitHub thread: a reply box (opened by a click), asking the agent about it, and resolving it. */
function ThreadFoot({ t }: { t: Thread }) {
  const [replying, setReplying] = useState(false);
  const act = useReview((s) => s.act);
  const expand = useReview((s) => s.expand);
  const ask = useThreadAsk((s) => s.ask);
  const chatHarness = useChat((s) => s.chat.harness);
  const guideHarness = useApp((s) => s.guide?.meta?.harness);
  const harness = chatHarness ?? guideHarness ?? null;
  return (
    <div className="th-foot">
      {replying ? (
        <Compose
          placeholder="Reply"
          onSave={(body) => act({ kind: "reply", thread: t.id, body }, t.id)}
          onCancel={() => setReplying(false)}
        />
      ) : (
        <button type="button" className="th-reply" onClick={() => setReplying(true)}>
          Reply
        </button>
      )}
      {ask && t.start != null && !replying && (
        <button
          type="button"
          className="icon-btn sm th-ask"
          {...tip(`Ask ${harnessName(harness)}`)}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            ask(t, r.right - 360, r.bottom);
          }}
        >
          <HarnessMark harness={harness} size={15} />
        </button>
      )}
      <button
        type="button"
        className="th-res"
        onClick={() => void act({ kind: t.resolved ? "unresolve" : "resolve", thread: t.id }, t.id)}
      >
        {ic(Check, 13)}
        {t.resolved ? "Unresolve" : "Resolve"}
      </button>
      {t.resolved && (
        <button type="button" className="icon-btn sm" {...tip("Collapse")} onClick={() => expand(t.id, false)}>
          {ic(ChevronDown, 14)}
        </button>
      )}
    </div>
  );
}

/** A thread: the first comment and the latest, with the ones between folded into "N more replies" until opened.
 *  A resolved thread is one quiet line until opened. Your own comments can be edited or deleted. */
export function ThreadCard({ t, keys }: { t: Thread; keys: string[] }) {
  const open = useReview((s) => s.expanded.includes(t.id));
  const expand = useReview((s) => s.expand);
  const viewer = useReview((s) => s.state?.viewer ?? "");
  const error = useReview((s) => (s.errorAt === t.id ? s.error : null));
  const setHover = useUI((s) => s.setHover);
  const hoverProps = keys.length ? { onMouseEnter: () => setHover(keys), onMouseLeave: () => setHover([]) } : {};
  const people = [...new Map(t.comments.map((c) => [c.author, c])).values()];
  if (t.resolved && !open)
    return (
      <button type="button" className="th-closed" data-thread={t.id} onClick={() => expand(t.id)} {...hoverProps}>
        {ic(Check, 13)}
        <span className="avs">
          {people.slice(0, 3).map((c) => (
            <Avatar key={c.author} c={c} size={18} />
          ))}
        </span>
        <span className="th-first">
          <Inline text={t.comments[0].body.split("\n")[0]} />
        </span>
        <span className="th-meta">
          Resolved · {t.comments.length} comment{t.comments.length === 1 ? "" : "s"}
        </span>
      </button>
    );
  const cs = t.comments;
  const folded = !open && cs.length > 3;
  const between = cs.slice(1, -1);
  const view = (c: ThreadComment) => (
    <CommentView key={c.id} c={c} t={t} mine={!t.ci && !!viewer && c.author === viewer} />
  );
  return (
    <div
      className={`th${t.resolved ? " resolved" : ""}${t.pending ? " pending" : ""}${t.ci ? " ci" : ""}`}
      data-thread={t.id}
      {...hoverProps}
    >
      {view(cs[0])}
      {folded ? (
        <>
          <button type="button" className="th-more" onClick={() => expand(t.id)}>
            <span className="avs">
              {[...new Map(between.map((c) => [c.author, c])).values()].slice(0, 3).map((c) => (
                <Avatar key={c.author} c={c} size={18} />
              ))}
            </span>
            {between.length} more {between.length === 1 ? "reply" : "replies"}
          </button>
          {view(cs[cs.length - 1])}
        </>
      ) : (
        cs.slice(1).map(view)
      )}
      {error && <div className="rv-err th-err">{error}</div>}
      {!t.pending && !t.ci && <ThreadFoot t={t} />}
    </div>
  );
}

function ThreadRow({ t, keys }: { t: Thread; keys: string[] }) {
  return (
    <tr className="th-row">
      <td colSpan={4}>
        <ThreadCard t={t} keys={keys} />
      </td>
    </tr>
  );
}

interface PopoverProps {
  threads: Thread[];
  viewer: string;
  idx: HunkIndex;
  onJump: (t: Thread, keys: string[]) => void;
}

/** Every thread on the PR, by file: open or resolved, optionally only the ones you're in. A file folds, and its
 *  threads can be hidden on the diff. */
export function ThreadsPopover({ threads, viewer, idx, onJump }: PopoverProps) {
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const [mine, setMine] = useState(false);
  const [folded, setFolded] = useState<string[]>([]);
  const { hiddenFiles, toggleFile } = useReview();
  const hideAll = useUI((s) => s.hideComments);
  const toggleHideAll = useUI((s) => s.toggleHideComments);
  const counts = {
    open: threads.filter((t) => !t.resolved).length,
    resolved: threads.filter((t) => t.resolved).length,
  };
  const byFile = useMemo(() => {
    const out = new Map<string, Thread[]>();
    for (const t of threads) {
      if (t.resolved !== (tab === "resolved")) continue;
      if (mine && !t.comments.some((c) => c.author === viewer)) continue;
      out.set(t.path, [...(out.get(t.path) ?? []), t]);
    }
    return [...out];
  }, [threads, tab, mine, viewer]);

  return (
    <div className="th-pop" role="dialog" aria-label="Comments">
      <div className="th-pop-h">
        <div className="seg th-seg">
          {(["open", "resolved"] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={tab === k ? "on" : ""}
              aria-pressed={tab === k}
              onClick={() => setTab(k)}
            >
              {k === "open" ? "Open" : "Resolved"} <span className="n">{counts[k]}</span>
            </button>
          ))}
        </div>
        <span className="grow" />
        {viewer && (
          <button
            type="button"
            className={`icon-btn sm${mine ? " on" : ""}`}
            {...tip("Only mine")}
            aria-pressed={mine}
            onClick={() => setMine(!mine)}
          >
            {ic(User, 15)}
          </button>
        )}
        <button
          type="button"
          className={`icon-btn sm${hideAll ? " on" : ""}`}
          {...tip(hideAll ? "Show comments on the diff" : "Hide comments on the diff")}
          aria-pressed={hideAll}
          onClick={toggleHideAll}
        >
          {ic(EyeOff, 15)}
        </button>
      </div>
      <div className="th-pop-b">
        {byFile.map(([path, ts]) => {
          const shut = folded.includes(path);
          const hidden = hiddenFiles.includes(path);
          return (
            <div key={path} className="tl-g">
              <div className={`tl-f${shut ? " shut" : ""}`}>
                <button
                  type="button"
                  className="tl-fold"
                  aria-expanded={!shut}
                  onClick={() => setFolded(shut ? folded.filter((p) => p !== path) : [...folded, path])}
                >
                  {ic(shut ? ChevronRight : ChevronDown, 13)}
                  {ic(FileCode, 13)}
                  <span className="nm" data-tip={path}>
                    {path.split("/").pop()}
                  </span>
                </button>
                {shut && <span className="n">{ts.length}</span>}
                <button
                  type="button"
                  className={`icon-btn sm tl-hide${hidden ? " on" : ""}`}
                  {...tip(hidden ? "Show this file's comments on the diff" : "Hide this file's comments on the diff")}
                  aria-pressed={hidden}
                  onClick={() => toggleFile(path)}
                >
                  {ic(EyeOff, 14)}
                </button>
              </div>
              {!shut &&
                ts.map((t) => {
                  const c = t.comments[0];
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className="tl-t"
                      disabled={t.outdated}
                      onClick={() => onJump(t, threadKeys(t, idx))}
                    >
                      <div className="h">
                        <Avatar c={c} />
                        <b>{c.author}</b>
                        {c.bot && ic(Bot, 13)}
                        {t.pending && <span className="th-tag pend">Pending</span>}
                        <span className="grow" />
                        <span className="where">
                          {whereText(t)}
                          {t.comments.length > 1 && ` · ${t.comments.length}`}
                        </span>
                      </div>
                      <div className="x">
                        <Inline text={c.body.split("\n").find((l) => l.trim()) ?? ""} />
                      </div>
                    </button>
                  );
                })}
            </div>
          );
        })}
        {!byFile.length && <div className="th-none">{tab === "open" ? "No open comments" : "None resolved"}</div>}
      </div>
    </div>
  );
}
