import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  GitPullRequest,
  GitPullRequestDraft,
  Layers2,
  LoaderCircle,
  MessageSquare,
  X,
} from "lucide-react";
import { type MouseEvent, useMemo, useState } from "react";
import { storage } from "../lib/storage";
import { ago, dateText } from "../lib/time";
import type { InboxPR, Reviewer } from "../types";
import { GithubIcon, ic } from "./icons";

const GROUPS = [
  ["review", "Needs your review"],
  ["yours", "Yours"],
  ["drafts", "Drafts"],
] as const;
type Group = (typeof GROUPS)[number][0];

const REVIEW_TITLE: Record<Reviewer["state"], string> = {
  approved: "approved",
  changes: "requested changes",
  commented: "commented",
  requested: "requested",
};

/** A row is one PR, or a stack of PRs that build on each other (top layer first). */
type Row = { pr: InboxPR } | { stack: InboxPR[] };

export const searchText = (p: InboxPR) => `${p.owner}/${p.repo} #${p.number} ${p.title} ${p.author}`.toLowerCase();

/** Rows per group. A stack sits in the group of its first PR there, in GitHub's group order, and takes its other
 *  layers along, so a 3-PR stack is one row wherever its layers came from. */
export function inboxRows(prs: InboxPR[]): [Group, Row[]][] {
  const stacks = new Map<string, InboxPR[]>();
  for (const p of prs) if (p.stack) stacks.set(p.stack.id, [...(stacks.get(p.stack.id) ?? []), p]);
  const placed = new Set<string>();
  const out: [Group, Row[]][] = [];
  for (const [g] of GROUPS) {
    const rows: Row[] = [];
    for (const p of prs) {
      if (p.group !== g) continue;
      const layers = p.stack && stacks.get(p.stack.id);
      if (!p.stack || !layers || layers.length < 2) rows.push({ pr: p });
      else if (!placed.has(p.stack.id)) {
        placed.add(p.stack.id);
        rows.push({ stack: [...layers].sort((a, b) => b.stack!.index - a.stack!.index) });
      }
    }
    if (rows.length) out.push([g, rows]);
  }
  return out;
}

const WORST = ["failure", "pending", "success", "none"] as const;

/** The stack's checks: its worst layer's, with the failures added up. */
const stackChecks = (prs: InboxPR[]): InboxPR["checks"] => ({
  state: WORST.find((s) => prs.some((p) => p.checks.state === s)) ?? "none",
  failing: prs.reduce((n, p) => n + p.checks.failing, 0),
});

/** Everyone on any layer, each once (an approval or change request outranks a pending request or a comment). */
function stackReviewers(prs: InboxPR[]): Reviewer[] {
  const rank = { changes: 0, approved: 1, requested: 2, commented: 3 };
  const by = new Map<string, Reviewer>();
  for (const r of prs.flatMap((p) => p.reviewers)) {
    const had = by.get(r.login);
    if (!had || rank[r.state] < rank[had.state]) by.set(r.login, r);
  }
  return [...by.values()];
}

function Reviewers({ list }: { list: Reviewer[] }) {
  return (
    <span className="rvs">
      {list.slice(0, 3).map((r) => (
        <span key={r.login} className="rv" data-tip={`${r.login} ${REVIEW_TITLE[r.state]}`}>
          <img className="av" src={r.avatar} alt={r.login} />
          {r.state === "approved" && <span className="st ok">{ic(CircleCheck, 10)}</span>}
          {r.state === "changes" && <span className="st bad">{ic(CircleX, 10)}</span>}
        </span>
      ))}
    </span>
  );
}

function Checks({ c }: { c: InboxPR["checks"] }) {
  return (
    <span className="cic">
      {c.state === "success" && (
        <span className="ci ok" data-tip="Checks passed">
          {ic(Check, 14)}
        </span>
      )}
      {c.state === "pending" && (
        <span className="ci wait" data-tip="Checks running">
          {ic(LoaderCircle, 14)}
        </span>
      )}
      {c.state === "failure" && (
        <span
          className="ci bad"
          data-tip={c.failing === 1 ? "1 check failing" : `${c.failing || "Some"} checks failing`}
        >
          {ic(X, 13)}
          {c.failing > 0 && c.failing}
        </span>
      )}
    </span>
  );
}

const Comments = ({ n }: { n: number }) => (
  <span className="m" data-tip={n ? `${n} comment${n === 1 ? "" : "s"}` : undefined}>
    {n > 0 && (
      <>
        {ic(MessageSquare, 13)}
        {n}
      </>
    )}
  </span>
);

/** The age, and in its place on hover a button that opens the PR on GitHub (so it costs the row no room). */
const Age = ({ t, url }: { t: number; url?: string }) => (
  <span className="age">
    <span className="ago" data-tip={`Updated ${dateText(t)}`}>
      {t ? ago(t) : ""}
    </span>
    {url && (
      <button
        type="button"
        className="icon-btn sm on-gh"
        data-tip="Open on GitHub"
        aria-label="Open on GitHub"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          window.open(url, "_blank", "noopener");
        }}
      >
        <GithubIcon size={14} />
      </button>
    )}
  </span>
);

const GuideMark = ({ p }: { p: InboxPR }) => (
  <span className="gd">{p.guides > 0 && <span data-tip="Review ready">{ic(BookOpen, 15)}</span>}</span>
);

interface Props {
  prs: InboxPR[];
  q: string;
  onOpen: (url: string) => void;
}

/** The signed-in user's open PRs, grouped as on GitHub's dashboard. */
export function Inbox({ prs, q, onOpen }: Props) {
  const [closed, setClosed] = useState<Group[]>(() => storage.get("rv-inbox-closed", []));
  // Stacks start expanded; the ones you fold stay folded.
  const [folded, setFolded] = useState<string[]>(() => storage.get("rv-inbox-folded-stacks", []));
  const foldStack = (id: string, on: boolean) => {
    const next = on ? [...folded, id] : folded.filter((x) => x !== id);
    setFolded(next);
    storage.set("rv-inbox-folded-stacks", next);
  };
  // A column shows only if some PR has something in it, so rows don't carry empty slots.
  const cols = useMemo(
    () => ({
      rv: prs.some((p) => p.reviewers.length),
      ci: prs.some((p) => p.checks.state !== "none"),
      cm: prs.some((p) => p.comments > 0),
      gd: prs.some((p) => p.guides > 0),
    }),
    [prs],
  );
  const groups = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return inboxRows(prs.filter((p) => words.every((w) => searchText(p).includes(w))));
  }, [prs, q]);

  const toggleGroup = (g: Group) => {
    const next = closed.includes(g) ? closed.filter((x) => x !== g) : [...closed, g];
    setClosed(next);
    storage.set("rv-inbox-closed", next);
  };
  const link = (url: string) => ({
    href: `?${new URLSearchParams({ pr: url })}`,
    onClick: (e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      onOpen(url);
    },
  });

  return (
    <>
      {groups.map(([g, rows]) => (
        <section key={g}>
          <button type="button" className="home-g ib-g" onClick={() => toggleGroup(g)}>
            {ic(closed.includes(g) ? ChevronRight : ChevronDown, 13)}
            {GROUPS.find(([k]) => k === g)![1]}
            <span className="n">{rows.reduce((n, r) => n + ("pr" in r ? 1 : r.stack.length), 0)}</span>
          </button>
          {!closed.includes(g) &&
            rows.map((r) => {
              if ("pr" in r) {
                const p = r.pr;
                return (
                  <a key={p.url} className="home-r ib-r" {...link(p.url)}>
                    {ic(p.draft ? GitPullRequestDraft : GitPullRequest, 16)}
                    <span className="t">
                      <span title={p.title}>{p.title}</span>
                      <span className="w">
                        {p.repo} #{p.number}
                        {p.group === "review" && ` · ${p.author}`}
                      </span>
                    </span>
                    {cols.rv && <Reviewers list={p.reviewers} />}
                    {cols.ci && <Checks c={p.checks} />}
                    {cols.cm && <Comments n={p.comments} />}
                    <Age t={p.updated_at} url={p.url} />
                    {cols.gd && <GuideMark p={p} />}
                  </a>
                );
              }
              const s = r.stack;
              const [top, bottom] = [s[0], s[s.length - 1]];
              const expanded = !folded.includes(bottom.stack!.id);
              return (
                <div key={bottom.stack!.id} className="ib-stack">
                  <button
                    type="button"
                    className="home-r ib-r"
                    aria-expanded={expanded}
                    onClick={() => foldStack(bottom.stack!.id, expanded)}
                  >
                    {ic(Layers2, 16)}
                    <span className="t">
                      <span title={bottom.title}>
                        {bottom.title}
                        <span className="chev">{ic(expanded ? ChevronDown : ChevronRight, 13)}</span>
                      </span>
                      <span className="w">
                        {top.repo} #{bottom.number} → #{top.number} · {s.length} PRs
                        {g === "review" && ` · ${top.author}`}
                      </span>
                    </span>
                    {cols.rv && <Reviewers list={stackReviewers(s)} />}
                    {cols.ci && <Checks c={stackChecks(s)} />}
                    {cols.cm && <Comments n={s.reduce((n, p) => n + p.comments, 0)} />}
                    <Age t={Math.max(...s.map((p) => p.updated_at))} />
                    {cols.gd && <span className="gd" />}
                  </button>
                  {expanded && (
                    <div className="kids">
                      {s.map((p) => (
                        <a key={p.url} className="home-r ib-r kid" {...link(p.url)}>
                          <span className="lvl">{p.stack!.index}</span>
                          <span className="t">
                            <span title={p.title}>{p.title}</span>
                            <span className="w">#{p.number}</span>
                          </span>
                          {cols.rv && <Reviewers list={p.reviewers} />}
                          {cols.ci && <Checks c={p.checks} />}
                          {cols.cm && <Comments n={p.comments} />}
                          <Age t={0} url={p.url} />
                          {cols.gd && <GuideMark p={p} />}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
        </section>
      ))}
    </>
  );
}

/** Placeholder rows while GitHub answers (the first load can take a few seconds). */
export function InboxSkeleton() {
  return (
    <section className="ib-skel" aria-busy="true" aria-label="Loading pull requests">
      <div className="home-g">
        <span className="sk" style={{ width: 110 }} />
      </div>
      {[62, 48, 70, 54].map((w) => (
        <div key={w} className="home-r">
          <span className="sk dot" />
          <span className="t">
            <span className="sk" style={{ width: `${w}%` }} />
            <span className="sk sm" style={{ width: 90 }} />
          </span>
          <span className="sk" style={{ width: 40 }} />
          <span className="sk" style={{ width: 28 }} />
        </div>
      ))}
    </section>
  );
}
