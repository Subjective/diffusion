import { useEffect } from "react";
import {
  Check, Circle, CircleAlert, CircleCheck, EyeOff, GitPullRequest, Info, Layers, ListOrdered, LoaderCircle,
  MessageCircle, ShieldCheck, Sparkles, Workflow, Zap, type LucideIcon,
} from "lucide-react";
import { inline } from "../lib/md";
import { refLabel } from "../lib/refs";
import { readingOrder, useHunkIndex, useStepLinking } from "../lib/linking";
import { useApp } from "../store";
import type { Stage, Step } from "../types";
import { useUI } from "../ui";
import { CONTEXT_ICON, SKIP_ICON, STEP_ICON, ic } from "./icons";
import { FlowGraph } from "./FlowGraph";
import { GUIDE_W, startResize } from "../lib/panes";
import { storage } from "../lib/storage";
import { refsTarget } from "../lib/linking";

export interface GuidePaneProps {
  onAskStep?: (step: Step) => void;
  onWidth?: (w: number) => void;
}

export function GuidePane({ onAskStep, onWidth }: GuidePaneProps) {
  return (
    <div className="guide-wrap">
      <GuideBody onAskStep={onAskStep} />
      {onWidth && (
        <div
          className="resizer right"
          title="Drag to resize · double-click to reset"
          onDoubleClick={() => {
            onWidth(GUIDE_W);
            storage.set("rv-guide-w", GUIDE_W);
          }}
          onMouseDown={(e) => {
            // Read the pane's left edge now: React clears currentTarget after the handler returns.
            const left = e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
            startResize(e, (x) => x - left, onWidth, "rv-guide-w");
          }}
        />
      )}
    </div>
  );
}

function GuideBody({ onAskStep }: GuidePaneProps) {
  const { pr, guide, generating, error } = useApp();
  if (!pr) return <aside className="guide" />;
  return (
    <aside className="guide">
      {generating || (!guide && !error) ? (
        <Generating />
      ) : guide ? (
        <div className="fade-in">
          <Header />
          <section className="sec">
            <div className="sec-h">{ic(Zap, 13)}TL;DR</div>
            <p className="tldr">{inline(guide.tldr)}</p>
          </section>
          <Notes />
          {guide.flow.nodes.length > 0 && (
            <section className="sec">
              <div className="sec-h">{ic(Workflow, 13)}Flow</div>
              <FlowGraph />
            </section>
          )}
          <Steps onAskStep={onAskStep} />
          <Skippable />
          <Uncovered />
        </div>
      ) : (
        <Header />
      )}
    </aside>
  );
}

/** Things a reviewer should know that the diff doesn't show. Risks first; items with refs link to code. */
function Notes() {
  const context = useApp((s) => s.guide!.context);
  const idx = useHunkIndex();
  if (!context.length) return null;
  const items = [...context].sort((a, b) => Number(b.icon === "risk" || b.icon === "security") - Number(a.icon === "risk" || a.icon === "security"));
  return (
    <section className="sec">
      <div className="sec-h">{ic(Info, 13)}Notes</div>
      <ul className="notes" onMouseLeave={() => useUI.getState().setHover([])}>
        {items.map((c, i) => {
          const warn = c.icon === "risk" || c.icon === "security";
          const t = c.refs?.length ? refsTarget(c.refs, idx) : null;
          return (
            <li
              key={i}
              className={`note${warn ? " warn" : ""}${t?.keys.length ? " linked" : ""}`}
              title={c.icon}
              onMouseEnter={() => useUI.getState().setHover(t?.keys ?? [])}
              onClick={() => t?.keys.length && useUI.getState().focus(t.keys, t.files)}
            >
              {ic(CONTEXT_ICON[c.icon] ?? Info, 14)}
              <span>{inline(c.text)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Header() {
  const pr = useApp((s) => s.pr)!;
  return (
    <div className="pr">
      <h1>{pr.title}</h1>
      <div className="meta">
        {ic(GitPullRequest, 14)}
        {pr.local ? (
          <span title={pr.url}>
            {pr.head_ref} → {pr.base_ref}
          </span>
        ) : (
          <a href={pr.url} target="_blank" rel="noreferrer">
            {pr.repo} #{pr.number}
          </a>
        )}
        <span className="sep" />
        <span className="avatar" title={pr.author}>
          {pr.author.slice(0, 2).toUpperCase()}
        </span>
        <span className="sep" />
        <span className="n-add">+{pr.additions}</span>
        <span className="n-del">−{pr.deletions}</span>
      </div>
    </div>
  );
}

const PIPE: [Stage, LucideIcon, string][] = [
  ["fetch", GitPullRequest, "Fetch PR"],
  ["hunks", Layers, "Split hunks"],
  ["explore", Sparkles, "Read & plan"],
  ["validate", ShieldCheck, "Validate refs"],
];

function Generating() {
  const { stages, tools } = useApp();
  const recent = tools.slice(-6);
  return (
    <div className="gen">
      {PIPE.map(([stage, Icon, label]) => {
        const st = stages[stage];
        return (
          <div key={stage} className={`gen-row${st === "done" ? " done" : st === "active" ? " cur" : ""}`}>
            <span className="dot-i">{ic(st === "done" ? Check : Icon, 15)}</span>
            {label}
            {st === "active" && <span className="spin">{ic(LoaderCircle, 15)}</span>}
          </div>
        );
      })}
      {recent.length > 0 && (
        <div className="tool-log">
          {recent.map((t, i) => (
            <span key={tools.length - recent.length + i} className="tool-chip">
              {t.summary}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Steps({ onAskStep }: GuidePaneProps) {
  const guide = useApp((s) => s.guide!);
  const steps = guide.steps;
  const idx = useHunkIndex();
  const { readSteps, toggleRead, hoverStep, hoverSub, pinStep, pinSub, clearPin } = useUI();
  const link = useStepLinking();
  const done = steps.filter((s) => readSteps[s.id]).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        clearPin();
        return;
      }
      if (/input|textarea/i.test((document.activeElement as HTMLElement)?.tagName ?? "")) return;
      if (e.key !== "j" && e.key !== "k") return;
      // Walk steps and substeps in reading order.
      const order = readingOrder(guide);
      const ui = useUI.getState();
      const cur = order.findIndex((t) => t.step === ui.pinStep && t.sub === ui.pinSub);
      const i = Math.min(order.length - 1, Math.max(0, cur + (e.key === "j" ? 1 : -1)));
      if (i === cur || !order[i]) return;
      const t = order[i];
      link.focus(t.step, t.sub);
      const sel = t.sub == null ? `.step[data-step="${t.step}"]` : `.sub[data-step="${t.step}"][data-sub="${t.sub}"]`;
      document.querySelector(sel)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [guide, link, clearPin]);

  return (
    <section className="sec">
      <div className="sec-h">
        {ic(ListOrdered, 13)}Steps
        <span className="grow" />
        <span>
          {done}/{steps.length}
        </span>
        <span className="progress">
          <i style={{ width: `${(done / Math.max(1, steps.length)) * 100}%` }} />
        </span>
      </div>
      <div onMouseLeave={() => link.hover(null)}>
        {steps.map((s) => {
          const read = !!readSteps[s.id];
          const Kind = STEP_ICON[s.kind] ?? Circle;
          const subs = s.substeps ?? [];
          const cls = ["step", read && "done", hoverStep === s.id && hoverSub == null && "hover", pinStep === s.id && "active"]
            .filter(Boolean)
            .join(" ");
          return (
            <div key={s.id} className={cls} data-step={s.id} onMouseEnter={() => link.hover(s.id)} onClick={() => link.focus(s.id)}>
              <div className="num">{read ? ic(Check, 12) : s.id}</div>
              <div>
                <div className="t">
                  {ic(Kind, 14)}
                  {s.title}
                </div>
                <div className="s">{inline(s.summary)}</div>
                {subs.length ? (
                  <ol className="subs" onMouseLeave={() => link.hover(s.id)}>
                    {subs.map((b) => {
                      const scls = ["sub", hoverStep === s.id && hoverSub === b.id && "hover", pinStep === s.id && pinSub === b.id && "active"]
                        .filter(Boolean)
                        .join(" ");
                      return (
                        <li
                          key={b.id}
                          className={scls}
                          data-step={s.id}
                          data-sub={b.id}
                          onMouseEnter={(e) => {
                            e.stopPropagation();
                            link.hover(s.id, b.id);
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            link.focus(s.id, b.id);
                          }}
                        >
                          <span className="sub-n">
                            {s.id}.{b.id}
                          </span>
                          <div>
                            <div className="sub-t">{b.title}</div>
                            <div className="sub-s">{inline(b.summary)}</div>
                            <div className="refs">
                              {b.refs.map((r, i) => (
                                <span key={i} className="ref">
                                  {refLabel(r, idx)}
                                </span>
                              ))}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <div className="refs">
                    {s.refs.map((r, i) => (
                      <span key={i} className="ref">
                        {refLabel(r, idx)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="acts">
                <button
                  className="icon-btn sm check"
                  title={read ? "Mark unread" : "Mark read"}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleRead(s.id);
                  }}
                >
                  {ic(read ? CircleCheck : Circle, 15)}
                </button>
                {onAskStep && (
                  <button
                    className="icon-btn sm ask"
                    title="Ask about this step"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAskStep(s);
                    }}
                  >
                    {ic(MessageCircle, 14)}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function useOpenFile() {
  return (path: string) => {
    const ui = useUI.getState();
    if (ui.hideSkip) ui.toggleHideSkip();
    ui.toggleCollapsed(path, false);
    requestAnimationFrame(() =>
      document.querySelector(`.file[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
  };
}

function Skippable() {
  const { guide, files } = useApp();
  const open = useOpenFile();
  if (!guide?.skippable.length) return null;
  const counts = new Map(files.map((f) => [f.path, f]));
  return (
    <section className="sec">
      <div className="sec-h">{ic(EyeOff, 13)}Skippable</div>
      {guide.skippable.map((s) => {
        const f = counts.get(s.file);
        return (
          <div key={s.file + s.reason} className="skip-row" title={s.reason} onClick={() => open(s.file)}>
            {ic(SKIP_ICON[s.reason] ?? EyeOff, 13)}
            <span>{s.file.split("/").pop()}</span>
            {f && (
              <span className="cnt">
                <span className="n-add">+{f.additions}</span> <span className="n-del">−{f.deletions}</span>
              </span>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Uncovered() {
  const guide = useApp((s) => s.guide);
  const idx = useHunkIndex();
  if (!guide?.uncovered.length) return null;
  return (
    <section className="sec">
      <div className="sec-h">{ic(CircleAlert, 13)}Uncovered</div>
      {guide.uncovered.map((id) => {
        const h = idx.byId.get(id);
        const ref = { hunk: id, side: "new" as const, start: null, end: null };
        return (
          <div
            key={id}
            className="skip-row uncovered"
            onMouseEnter={() => {
              const rows = idx.rows.get(id) ?? [];
              useUI.getState().setHover(rows.map((r) => `${r.file}:${r.pos}`));
            }}
            onMouseLeave={() => useUI.getState().setHover([])}
            onClick={() => {
              const rows = idx.rows.get(id) ?? [];
              if (h) useUI.getState().focus(rows.map((r) => `${r.file}:${r.pos}`), [h.file]);
            }}
          >
            {ic(CircleAlert, 13)}
            <span>{refLabel(ref, idx)}</span>
          </div>
        );
      })}
    </section>
  );
}
