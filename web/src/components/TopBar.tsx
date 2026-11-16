import {
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleX,
  GitBranch,
  GitMerge,
  History,
  Layers2,
  ListOrdered,
  LoaderCircle,
  Map as MapIcon,
  Moon,
  Search,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../chat";
import { ago } from "../lib/time";
import { usePopover } from "../lib/usePopover";
import { inboxStack, useInbox, useReview, type Verdict } from "../review";
import { useApp } from "../store";
import type { Check as CheckRun, InboxPR, PRMeta } from "../types";
import { useUI } from "../ui";
import { Reviewers } from "./Inbox";
import { GithubIcon, HarnessMark, harnessName, ic, Logo } from "./icons";

export function TopBar() {
  const { theme, toggleTheme, chatOpen, toggleChat, url, home } = useApp();
  const chatHarness = useChat((s) => s.chat.harness);
  const guideHarness = useApp((s) => s.guide?.meta?.harness);
  const harness = chatHarness ?? guideHarness ?? null;
  return (
    <header className="top">
      {url ? (
        <button type="button" className="brand" title="Home" onClick={home}>
          <Logo />
        </button>
      ) : (
        <div className="brand">
          <Logo />
        </div>
      )}
      <Target />
      <div className="top-r">
        <ReviewChip />
        <ModeToggle />
        <Versions />
        <button type="button" className="icon-btn" title="Theme" onClick={toggleTheme}>
          {ic(theme === "dark" ? Sun : Moon, 17)}
        </button>
        <button
          type="button"
          className={`icon-btn${chatOpen ? " on" : ""}`}
          title={harnessName(harness)}
          onClick={() => toggleChat()}
        >
          <HarnessMark harness={harness} size={16} />
        </button>
      </div>
    </header>
  );
}

/** Steps or map in the left pane; shown once the guide has a view to map. */
function ModeToggle() {
  const hasMap = useApp((s) => !!s.guide?.views?.length);
  const { mode, setMode } = useUI();
  if (!hasMap) return null;
  return (
    <div className="seg">
      <button
        type="button"
        className={`icon-btn${mode !== "map" ? " on" : ""}`}
        title="Steps"
        aria-pressed={mode !== "map"}
        onClick={() => setMode("guide")}
      >
        {ic(ListOrdered, 16)}
      </button>
      <button
        type="button"
        className={`icon-btn${mode === "map" ? " on" : ""}`}
        title="Map"
        aria-pressed={mode === "map"}
        onClick={() => setMode("map")}
      >
        {ic(MapIcon, 16)}
      </button>
    </div>
  );
}

/** What's under review: the PR (with a switcher, its stack, checks and reviewers), or the local repository and branch. */
function Target() {
  const pr = useApp((s) => s.pr);
  if (!pr) return <div className="target" />;
  if (pr.local)
    return (
      <div className="target">
        <span title={pr.url}>
          {ic(GitBranch, 15)}
          <b>{localName(pr.url)}</b>
          <span className="target-ref">{pr.head_ref}</span>
        </span>
      </div>
    );
  return <PRTarget pr={pr} />;
}

function PRTarget({ pr }: { pr: PRMeta }) {
  const prs = useInbox((s) => s.inbox?.prs);
  const review = useReview((s) => s.state);
  useEffect(() => {
    if (!useInbox.getState().inbox) void useInbox.getState().load();
  }, []);
  const { layers } = useMemo(() => inboxStack(prs ?? [], pr.owner, pr.repo, pr.number), [prs, pr]);
  const at = layers.findIndex((p) => p.number === pr.number);
  return (
    <div className="target">
      <a className="icon-btn sm gh-link" href={pr.url} target="_blank" rel="noreferrer" data-tip="Open on GitHub">
        <GithubIcon size={15} />
      </a>
      <b>{pr.repo}</b>
      <Switcher pr={pr} layers={layers} />
      {layers.length > 0 && (
        <span className="stk" data-tip={`Stack: ${layers.length - at} of ${layers.length}`}>
          {ic(Layers2, 13)}
          {layers.length - at}/{layers.length}
        </span>
      )}
      {review?.checks && review.checks.state !== "none" && (
        <ChecksChip checks={review.checks} mergeable={review.mergeable} base={review.base_ref ?? pr.base_ref} />
      )}
      {review?.reviewers?.length ? <Reviewers list={review.reviewers} /> : null}
    </div>
  );
}

const CHECK_ICON = {
  success: <span className="ck ok">{ic(CircleCheck, 15)}</span>,
  failure: <span className="ck bad">{ic(CircleX, 15)}</span>,
  pending: <span className="ck wait">{ic(LoaderCircle, 15)}</span>,
  skipped: <span className="ck">{ic(CircleDashed, 15)}</span>,
};

/** The PR's checks at a glance, and each one (linking to its run) in a popover. */
function ChecksChip({
  checks,
  mergeable,
  base,
}: {
  checks: { state: string; failing: number; list: CheckRun[] };
  mergeable?: string;
  base: string;
}) {
  const [open, setOpen, ref] = usePopover();
  const tip =
    checks.state === "success"
      ? "Checks passed"
      : checks.state === "pending"
        ? "Checks running"
        : checks.failing === 1
          ? "1 check failing"
          : `${checks.failing} checks failing`;
  return (
    <div className="pop-anchor" ref={ref}>
      <button
        type="button"
        className={`ci-chip ${checks.state}${open ? " on" : ""}`}
        data-tip={open ? undefined : tip}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {checks.state === "success" && ic(Check, 14)}
        {checks.state === "pending" && ic(LoaderCircle, 14)}
        {checks.state === "failure" && (
          <>
            {ic(X, 13)}
            {checks.failing > 0 && <span>{checks.failing}</span>}
          </>
        )}
      </button>
      {open && (
        <div className="ci-pop" role="menu">
          {checks.list.map((c) => (
            <a key={`${c.name}-${c.url}`} className="r" role="menuitem" href={c.url} target="_blank" rel="noreferrer">
              {CHECK_ICON[c.state]}
              <span className="n">{c.name}</span>
              {ic(ArrowUpRight, 14)}
            </a>
          ))}
          {mergeable && mergeable !== "unknown" && (
            <>
              <div className="sep" />
              <div className={`mg${mergeable === "conflicting" ? " bad" : ""}`}>
                {ic(GitMerge, 14)}
                {mergeable === "conflicting" ? `Conflicts with ${base}` : `No conflicts with ${base}`}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const VERDICTS: [Verdict, string][] = [
  ["comment", "Comment"],
  ["approve", "Approve"],
  ["request_changes", "Request changes"],
];

/** Your review: the comments waiting in it, a summary and a verdict, submitted to GitHub together. */
function ReviewChip() {
  const state = useReview((s) => s.state);
  const pending = useReview((s) => s.pending);
  const { submit, editPending, busy } = useReview();
  const error = useReview((s) => (s.errorAt === "review" ? s.error : null));
  const [open, setOpen, ref] = usePopover();
  const [body, setBody] = useState("");
  const [verdict, setVerdict] = useState<Verdict>("comment");
  if (!state?.available || state.error || !state.viewer) return null;
  // GitHub doesn't let you approve or request changes on your own PR.
  const own = state.viewer === state.author;
  const verdicts = own ? VERDICTS.slice(0, 1) : VERDICTS;
  const can = !busy && (pending.length > 0 || body.trim() !== "" || verdict === "approve");
  const go = async () => {
    if (await submit(own ? "comment" : verdict, body.trim())) {
      setBody("");
      setVerdict("comment");
      setOpen(false);
    }
  };
  const jump = (p: (typeof pending)[number]) => {
    setOpen(false);
    const rows = [...document.querySelectorAll<HTMLElement>(`tr.ln[data-file="${CSS.escape(p.path)}"]`)].filter((r) => {
      const n = Number(p.side === "new" ? r.dataset.new : r.dataset.old);
      return n >= p.start && n <= p.end;
    });
    useUI.getState().focus(
      rows.map((r) => r.dataset.rk!),
      [p.path],
    );
  };
  return (
    <div className="pop-anchor" ref={ref}>
      <button
        type="button"
        className={`rv-btn${open ? " on" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Review
        {pending.length > 0 && <span className="n">{pending.length}</span>}
      </button>
      {open && (
        <div className="rv-pop" role="dialog" aria-label="Review">
          {pending.length > 0 && (
            <div className="rv-list">
              {pending.map((p) => (
                <div key={p.id} className="rv-i">
                  <button type="button" className="rv-go" onClick={() => jump(p)}>
                    <span className="where">
                      {p.path.split("/").pop()}:{p.start === p.end ? p.end : `${p.start}–${p.end}`}
                    </span>
                    <span className="x">{p.body}</span>
                  </button>
                  <button type="button" className="icon-btn sm" data-tip="Remove" onClick={() => editPending(p.id, "")}>
                    {ic(X, 13)}
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            className="rv-body"
            rows={3}
            value={body}
            placeholder="Leave a comment"
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && can) {
                e.preventDefault();
                void go();
              }
            }}
          />
          {error && <div className="rv-err">{error}</div>}
          <div className="rv-f">
            {verdicts.length > 1 && (
              <div className="seg th-seg">
                {verdicts.map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    className={verdict === v ? "on" : ""}
                    aria-pressed={verdict === v}
                    onClick={() => setVerdict(v)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <span className="grow" />
            <button type="button" className="rv-submit" disabled={!can} onClick={go}>
              Submit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const SWITCH_GROUPS = [
  ["review", "Needs your review"],
  ["yours", "Yours"],
  ["drafts", "Drafts"],
] as const;

const NO_PRS: InboxPR[] = [];

/** "#42", opening the other PRs you're on: this one's stack first, then the inbox's groups, with a filter. */
function Switcher({ pr, layers }: { pr: PRMeta; layers: InboxPR[] }) {
  const prs = useInbox((s) => s.inbox?.prs) ?? NO_PRS;
  const go = useApp((s) => s.open);
  const [open, setOpen, ref] = usePopover();
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!open) return;
    setQ("");
    void useInbox.getState().load();
  }, [open]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const match = (p: InboxPR) =>
    words.every((w) => `${p.repo} #${p.number} ${p.title} ${p.author}`.toLowerCase().includes(w));
  const inStack = new Set(layers.map((p) => p.url));
  const item = (p: InboxPR, lvl?: number) => (
    <button
      key={p.url}
      type="button"
      role="menuitem"
      className={`sw-i${p.number === pr.number && p.repo === pr.repo ? " cur" : ""}`}
      onClick={() => {
        setOpen(false);
        if (!(p.number === pr.number && p.repo === pr.repo)) go(p.url);
      }}
    >
      {lvl != null && <span className="lvl">{lvl}</span>}
      <span className="t">{p.title}</span>
      <span className="n">#{p.number}</span>
      <span className={`m ${p.checks.state}`}>
        {p.checks.state === "success" && ic(Check, 13)}
        {p.checks.state === "failure" && ic(X, 12)}
        {p.checks.state === "pending" && ic(LoaderCircle, 13)}
      </span>
    </button>
  );
  const stack = layers.filter(match);
  return (
    <div className="pop-anchor" ref={ref}>
      <button
        type="button"
        className={`target-ref sw-btn${open ? " on" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        #{pr.number}
        {ic(ChevronDown, 12)}
      </button>
      {open && (
        <div className="sw-pop" role="menu">
          <label className="sw-q">
            {ic(Search, 14)}
            <input
              // biome-ignore lint/a11y/noAutofocus: the filter is what the popover opens for
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter"
              spellCheck={false}
            />
          </label>
          <div className="sw-b">
            {stack.length > 0 && (
              <>
                <div className="sw-h">
                  {ic(Layers2, 12)}
                  Stack
                </div>
                <div className="sw-stack">
                  {stack.map((p) => item(p, p.stack!.index))}
                  <div className="sw-base">
                    {ic(GitBranch, 12)}
                    <span>{layers[layers.length - 1].base_ref}</span>
                  </div>
                </div>
              </>
            )}
            {SWITCH_GROUPS.map(([g, label]) => {
              const ps = prs.filter((p) => p.group === g && !inStack.has(p.url) && match(p));
              if (!ps.length) return null;
              return (
                <div key={g}>
                  <div className="sw-h">{label}</div>
                  {ps.map((p) => item(p))}
                </div>
              );
            })}
            {!stack.length && !prs.some((p) => !inStack.has(p.url) && match(p)) && (
              <div className="sw-none">{prs.length ? "No matches" : "No open pull requests"}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** `local:/path/to/repo#base..head` → `repo`. */
export const localName = (target: string) =>
  target
    .replace(/^local:/, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "")
    .split("/")
    .pop() || target;

/** Earlier versions of the guide (each submit, and each edit from chat); shown once there is more than one. */
function Versions() {
  const { versions, guide, showVersion } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", close);
    };
  }, [open]);
  if (versions.length < 2) return null;
  const current = guide?.version;
  return (
    <div className="versions" ref={ref}>
      <button
        type="button"
        className={`icon-btn ver-btn${open ? " on" : ""}`}
        title="Guide versions"
        onClick={() => setOpen(!open)}
      >
        {ic(History, 16)}
        <span>v{current}</span>
      </button>
      {open && (
        <div className="ver-menu" role="menu">
          {[...versions].reverse().map((v) => (
            <button
              type="button"
              key={v.version}
              role="menuitem"
              className={`h-item${v.version === current ? " active" : ""}`}
              onClick={() => {
                setOpen(false);
                void showVersion(v.version);
              }}
            >
              <div className="h-t">
                <span className="ver-n">v{v.version}</span>
                {v.label || (v.source === "chat" ? "Edited in chat" : "Guide")}
                {v.version === current && ic(Check, 13)}
              </div>
              <div className="h-m">
                <span>{v.source === "chat" ? "chat" : "agent"}</span>
                {v.scope?.files.length ? (
                  <span title={v.scope.files.join("\n")}>{v.scope.note || "scoped"}</span>
                ) : null}
                <span className="grow" />
                {v.created_at != null && <span>{ago(v.created_at)}</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
