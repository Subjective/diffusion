import { GitBranch, History, MessageCircle, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fetchTargets } from "../api";
import { ago } from "../lib/time";
import { useApp } from "../store";
import type { Target } from "../types";
import { NoGuide } from "./GuidePane";
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

/** Past reviews, newest first, when no review is open. */
export function Home() {
  const open = useApp((s) => s.open);
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    fetchTargets()
      .then(setTargets)
      .catch(() => setTargets([]));
  }, []);

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

  if (!targets) return <main className="landing" />;
  if (!targets.length)
    return (
      <main className="landing">
        <NoGuide landing />
      </main>
    );
  return (
    <main className="home">
      <div className="home-in">
        <label className="home-search">
          {ic(Search, 15)}
          <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter" spellCheck={false} />
        </label>
        {groups.map(([g, ts]) => (
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
                  <b>{name(t)}</b>
                  <span className="ref">{ref(t)}</span>
                  <span className="ttl">{title(t)}</span>
                </span>
                <span className="m">
                  {t.chats > 0 && (
                    <span title="Chats">
                      {ic(MessageCircle, 13)}
                      {t.chats}
                    </span>
                  )}
                  {t.versions > 1 && (
                    <span title="Versions">
                      {ic(History, 13)}
                      {t.versions}
                    </span>
                  )}
                  <span className="age">{ago(t.updated_at)}</span>
                </span>
              </a>
            ))}
          </section>
        ))}
      </div>
    </main>
  );
}
