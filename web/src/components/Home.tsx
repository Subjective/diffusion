import { BookOpen, GitBranch, GitPullRequest, History, MessageCircle, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchInbox, fetchTargets } from "../api";
import { storage } from "../lib/storage";
import { ago } from "../lib/time";
import { useApp } from "../store";
import type { Inbox as InboxData, Target } from "../types";
import { NoGuide } from "./GuidePane";
import { Inbox } from "./Inbox";
import { GithubIcon, ic } from "./icons";
import { localName } from "./TopBar";

const DAY = 86400;

/** Day buckets like a chat history: Today, Yesterday, Previous 7 days, Previous 30 days, Older. */
export function bucket(t: number, now = Date.now() / 1000): string {
  const midnight = new Date(now * 1000).setHours(0, 0, 0, 0) / 1000;
  if (t >= midnight) return "Today";
  if (t >= midnight - DAY) return "Yesterday";
  if (t >= midnight - 7 * DAY) return "Previous 7 days";
  if (t >= midnight - 30 * DAY) return "Previous 30 days";
  return "Older";
}

const name = (t: Target) => (t.local ? localName(t.url) : `${t.owner}/${t.repo}`);
const ref = (t: Target) => (t.local ? t.head_ref : `#${t.number}`);
const title = (t: Target) => t.title || t.label;

type View = "guides" | "prs";

/** Past reviews, newest first, or your open PRs on GitHub, when no review is open. */
export function Home() {
  const open = useApp((s) => s.open);
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [inbox, setInbox] = useState<InboxData | null>(null);
  const [view, setView] = useState<View>(() => storage.get<View>("rv-home-view", "guides"));
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);

  // "/" jumps to the search field, as on GitHub.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || el.closest("input, textarea, [contenteditable]"))
        return;
      e.preventDefault();
      input.current?.focus();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    fetchTargets()
      .then(setTargets)
      .catch(() => setTargets([]));
    fetchInbox()
      .then(setInbox)
      .catch((e) => setInbox({ login: "", prs: [], error: String(e.message ?? e) }));
  }, []);

  const show = (v: View) => {
    setView(v);
    storage.set("rv-home-view", v);
  };

  const groups = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out = new Map<string, Target[]>();
    for (const t of targets ?? []) {
      const hay = `${name(t)} ${ref(t)} ${title(t)}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
      const b = bucket(t.updated_at);
      out.set(b, [...(out.get(b) ?? []), t]);
    }
    return [...out];
  }, [targets, q]);

  // A count column shows only if some review has a count for it.
  const anyChats = targets?.some((t) => t.chats > 0);
  const anyVersions = targets?.some((t) => t.versions > 1);

  if (!targets || !inbox) return <main className="landing" />;
  // Nothing reviewed and no PRs to show: just how to start one.
  if (!targets.length && !inbox.prs.length)
    return (
      <main className="landing">
        <NoGuide landing />
      </main>
    );
  return (
    <main className="home">
      <div className="home-in">
        <div className="home-bar">
          <div className="seg home-seg">
            <button
              type="button"
              className={`icon-btn${view === "guides" ? " on" : ""}`}
              title="Reviews"
              aria-pressed={view === "guides"}
              onClick={() => show("guides")}
            >
              {ic(BookOpen, 16)}
            </button>
            <button
              type="button"
              className={`icon-btn${view === "prs" ? " on" : ""}`}
              title="Pull requests"
              aria-pressed={view === "prs"}
              onClick={() => show("prs")}
            >
              {ic(GitPullRequest, 16)}
            </button>
          </div>
          <label className="home-search">
            {ic(Search, 15)}
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                setQ("");
                e.currentTarget.blur();
              }}
              placeholder="Search"
              spellCheck={false}
            />
            <kbd>/</kbd>
          </label>
        </div>
        {view === "prs" ? (
          inbox.error && !inbox.prs.length ? (
            <div className="home-empty">{inbox.error}</div>
          ) : (
            <Inbox prs={inbox.prs} q={q} onOpen={open} />
          )
        ) : !targets.length ? (
          <div className="home-empty">
            <NoGuide landing />
          </div>
        ) : null}
        {view === "guides" &&
          groups.map(([g, ts]) => (
            <section key={g}>
              <div className="home-g">{g}</div>
              {ts.map((t) => (
                <a
                  key={t.url}
                  className="home-r"
                  href={`?${new URLSearchParams({ pr: t.url })}`}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    open(t.url);
                  }}
                >
                  {t.local ? ic(GitBranch, 15) : <GithubIcon size={15} />}
                  <span className="t">
                    <span title={title(t)}>{title(t)}</span>
                    <span className="w">
                      {name(t)} · {ref(t)}
                    </span>
                  </span>
                  {anyChats && (
                    <span className="m" title={t.chats > 0 ? "Chats" : undefined}>
                      {t.chats > 0 && (
                        <>
                          {ic(MessageCircle, 13)}
                          {t.chats}
                        </>
                      )}
                    </span>
                  )}
                  {anyVersions && (
                    <span className="m" title={t.versions > 1 ? "Versions" : undefined}>
                      {t.versions > 1 && (
                        <>
                          {ic(History, 13)}
                          {t.versions}
                        </>
                      )}
                    </span>
                  )}
                  <span className="age">{ago(t.updated_at)}</span>
                </a>
              ))}
            </section>
          ))}
      </div>
    </main>
  );
}
