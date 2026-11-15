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
import { ago } from "../lib/time";
import type { InboxPR, Reviewer } from "../types";
import { ic } from "./icons";

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
  requested: "review requested",
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
        <span key={r.login} className="rv" title={`${r.login} · ${REVIEW_TITLE[r.state]}`}>
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
        <span className="ci ok" title="Checks passed">
          {ic(Check, 14)}
        </span>
      )}
      {c.state === "pending" && (
        <span className="ci wait" title="Checks running">
          {ic(LoaderCircle, 14)}
        </span>
      )}
      {c.state === "failure" && (
        <span className="ci bad" title={`${c.failing || "Some"} failing`}>
          {ic(X, 13)}
          {c.failing > 0 && c.failing}
        </span>
      )}
    </span>
  );
}

const Comments = ({ n }: { n: number }) => (
  <span className="m" title={n ? "Comments" : undefined}>
    {n > 0 && (
      <>
        {ic(MessageSquare, 13)}
        {n}
      </>
    )}
  </span>
);

const GuideMark = ({ p }: { p: InboxPR }) => (
  <span className="gd">{p.guides > 0 && <span title="Review ready">{ic(BookOpen, 15)}</span>}</span>
);

interface Props {
  prs: InboxPR[];
  q: string;
  onOpen: (url: string) => void;
}

/** The signed-in user's open PRs, grouped as on GitHub's dashboard. */
export function Inbox({ prs, q, onOpen }: Props) {
  const [closed, setClosed] = useState<Group[]>(() => storage.get("rv-inbox-closed", []));
  const [open, setOpen] = useState<string[]>([]); // expanded stacks
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
                    <Reviewers list={p.reviewers} />
                    <Checks c={p.checks} />
                    <Comments n={p.comments} />
                    <span className="age">{ago(p.updated_at)}</span>
                    <GuideMark p={p} />
                  </a>
                );
              }
              const s = r.stack;
              const [top, bottom] = [s[0], s[s.length - 1]];
              const expanded = open.includes(bottom.stack!.id);
              return (
                <div key={bottom.stack!.id} className="ib-stack">
                  <button
                    type="button"
                    className="home-r ib-r"
                    aria-expanded={expanded}
                    onClick={() =>
                      setOpen(expanded ? open.filter((x) => x !== bottom.stack!.id) : [...open, bottom.stack!.id])
                    }
                  >
                    {ic(Layers2, 16)}
                    <span className="t">
                      <span>
                        Stack of {s.length}
                        <span className="chev">{ic(expanded ? ChevronDown : ChevronRight, 13)}</span>
                      </span>
                      <span className="w">
                        {top.repo} #{bottom.number} → #{top.number}
                        {g === "review" && ` · ${top.author}`}
                      </span>
                    </span>
                    <Reviewers list={stackReviewers(s)} />
                    <Checks c={stackChecks(s)} />
                    <Comments n={s.reduce((n, p) => n + p.comments, 0)} />
                    <span className="age">{ago(Math.max(...s.map((p) => p.updated_at)))}</span>
                    <span className="gd" />
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
                          <Reviewers list={p.reviewers} />
                          <Checks c={p.checks} />
                          <Comments n={p.comments} />
                          <span className="age" />
                          <GuideMark p={p} />
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
