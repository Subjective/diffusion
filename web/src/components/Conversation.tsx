import { CircleCheck, CircleX, FileCode, GitCommitHorizontal, MessageSquare } from "lucide-react";
import { useMemo, useState } from "react";
import { autosize } from "../lib/autosize";
import { Inline, Markdown } from "../lib/md";
import { indexFiles } from "../lib/refs";
import { ago, dateText } from "../lib/time";
import { useReview } from "../review";
import { useApp } from "../store";
import type { Thread, TimelineItem } from "../types";
import { useUI } from "../ui";
import { Header } from "./GuidePane";
import { HarnessMark, ic } from "./icons";
import { threadKeys, whereText } from "./Threads";

const STATE: Record<NonNullable<TimelineItem["state"]>, [string, string]> = {
  approved: ["Approved", "ok"],
  changes: ["Changes requested", "bad"],
  commented: ["Reviewed", ""],
  dismissed: ["Review dismissed", ""],
};

type Entry =
  | { kind: "item"; at: number; item: TimelineItem }
  | { kind: "commits"; at: number; author: string; commits: TimelineItem[] }
  | { kind: "guide"; at: number; version: number; label: string };

/** The timeline in order, with each run of commits by one author as one entry, and Diffusion's own reviews of the
 *  PR (its saved versions) where they happened. */
export function conversation(items: TimelineItem[], versions: { version: number; label: string; at: number }[]) {
  const out: Entry[] = [];
  const all = [...items.map((item) => ({ at: item.created_at, item })), ...versions.map((v) => ({ at: v.at, v }))].sort(
    (a, b) => a.at - b.at,
  );
  for (const e of all) {
    if ("v" in e) {
      out.push({ kind: "guide", at: e.at, version: e.v.version, label: e.v.label });
      continue;
    }
    const last = out[out.length - 1];
    if (e.item.kind === "commit" && last?.kind === "commits" && last.author === e.item.author)
      last.commits.push(e.item);
    else if (e.item.kind === "commit")
      out.push({ kind: "commits", at: e.at, author: e.item.author, commits: [e.item] });
    else out.push({ kind: "item", at: e.at, item: e.item });
  }
  return out;
}

/** The PR as GitHub shows it: its description, then comments, reviews (with the threads each one started),
 *  commits and Diffusion's reviews, oldest first, and a box to comment. */
export function ConversationPane() {
  const pr = useApp((s) => s.pr);
  const files = useApp((s) => s.files);
  const versions = useApp((s) => s.versions);
  const harness = useApp((s) => s.guide?.meta?.harness);
  const state = useReview((s) => s.state);
  const idx = useMemo(() => indexFiles(files), [files]);
  const entries = useMemo(
    () =>
      conversation(
        state?.timeline ?? [],
        versions
          .filter((v) => v.created_at != null)
          .map((v) => ({ version: v.version, label: v.label, at: v.created_at! })),
      ),
    [state, versions],
  );
  // The threads each review started, by review id.
  const started = useMemo(() => {
    const m = new Map<string, Thread[]>();
    for (const t of state?.threads ?? []) {
      const r = t.comments[0]?.review;
      if (r) m.set(r, [...(m.get(r) ?? []), t]);
    }
    return m;
  }, [state]);
  if (!pr) return <aside className="guide" />;
  const jump = (t: Thread) => {
    const keys = threadKeys(t, idx);
    useReview.getState().expand(t.id);
    if (keys.length) useUI.getState().focus(keys, [t.path]);
  };
  return (
    <aside className="guide conv">
      <Header />
      {pr.body.trim() && (
        <section className="sec conv-desc">
          <Markdown text={pr.body} />
        </section>
      )}
      <div className="conv-tl">
        {entries.map((e) =>
          e.kind === "guide" ? (
            <div key={`g${e.version}`} className="conv-ev">
              <HarnessMark harness={harness} size={14} />
              <span>
                Review v{e.version}
                {e.label ? ` · ${e.label}` : ""}
              </span>
              <span className="t" data-tip={dateText(e.at)}>
                {ago(e.at)}
              </span>
            </div>
          ) : e.kind === "commits" ? (
            <div key={e.commits[0].id} className="conv-ev">
              {ic(GitCommitHorizontal, 14)}
              <span>
                {e.author} pushed {e.commits.length === 1 ? "a commit" : `${e.commits.length} commits`}
                {e.commits.map((c) => (
                  <span key={c.id} className="conv-commit">
                    <code>{c.sha?.slice(0, 7)}</code> <Inline text={c.body} />
                  </span>
                ))}
              </span>
              <span className="t" data-tip={dateText(e.at)}>
                {ago(e.at)}
              </span>
            </div>
          ) : (
            <Item key={e.item.id} item={e.item} threads={started.get(e.item.id) ?? []} onJump={jump} />
          ),
        )}
      </div>
      {state?.id && <CommentBox pr={state.id} />}
    </aside>
  );
}

function Item({ item, threads, onJump }: { item: TimelineItem; threads: Thread[]; onJump: (t: Thread) => void }) {
  const [label, tone] = item.state ? STATE[item.state] : ["", ""];
  return (
    <div className="conv-c">
      <img className="av" src={item.avatar || undefined} alt={item.author} width={24} height={24} />
      <div className="b">
        <div className="h">
          <b>{item.author}</b>
          {item.bot && <span className="th-tag">bot</span>}
          {label && (
            <span className={`conv-state ${tone}`}>
              {tone === "ok" && ic(CircleCheck, 12)}
              {tone === "bad" && ic(CircleX, 12)}
              {label}
            </span>
          )}
          <span className="t" data-tip={dateText(item.created_at)}>
            {ago(item.created_at)}
          </span>
        </div>
        {item.body.trim() && (
          <div className="x">
            <Markdown text={item.body} />
          </div>
        )}
        {threads.map((t) => (
          <button key={t.id} type="button" className="conv-th" disabled={t.outdated} onClick={() => onJump(t)}>
            {ic(FileCode, 13)}
            <span className="where">
              {t.path.split("/").pop()} {whereText(t)}
            </span>
            <span className="x">
              <Inline text={t.comments[0].body.split("\n").find((l) => l.trim()) ?? ""} />
            </span>
            {t.comments.length > 1 && (
              <span className="n">
                {ic(MessageSquare, 12)}
                {t.comments.length}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function CommentBox({ pr }: { pr: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    if (await useReview.getState().act({ kind: "comment", pr, body: text.trim() })) setText("");
    setBusy(false);
  };
  return (
    <div className="conv-box">
      <textarea
        rows={1}
        value={text}
        placeholder="Comment"
        onChange={(e) => {
          setText(e.target.value);
          autosize(e.target, 10);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <button type="button" className="rv-submit" disabled={!text.trim() || busy} onClick={send}>
        Comment
      </button>
    </div>
  );
}
