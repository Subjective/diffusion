import {
  Check,
  Circle,
  CircleAlert,
  CircleCheck,
  Copy,
  EyeOff,
  FileCode,
  Focus,
  GitPullRequest,
  ListOrdered,
  MessageCircle,
  Workflow,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { readingOrder, refsOf, refsTarget, useHunkIndex, useStepLinking } from "../lib/linking";
import { Inline } from "../lib/md";
import { GUIDE_W, startResize } from "../lib/panes";
import { refLabel } from "../lib/refs";
import { storage } from "../lib/storage";
import { useApp } from "../store";
import type { Ref, Step } from "../types";
import { useUI } from "../ui";
import { FlowGraph } from "./FlowGraph";
import { ic, SKIP_ICON, STEP_ICON } from "./icons";

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
  const { pr, guide } = useApp();
  if (!pr) return <aside className="guide" />;
  return (
    <aside className="guide">
      {guide ? (
        <div className="fade-in" key={guide.version}>
          <Header />
          <section className="sec">
            <div className="sec-h">
              {ic(Zap, 13)}TL;DR
              <ScopeChip />
            </div>
            <p className="tldr">
              <Inline text={guide.tldr} />
            </p>
          </section>
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
        <>
          <Header />
          <NoGuide />
        </>
      )}
    </aside>
  );
}

/** Things a reviewer should know that the diff doesn't show. Risks first; items with refs link to code. */
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
        <span className="meta-files" title={`${pr.changed_files} files changed`}>
          {ic(FileCode, 14)}
          {pr.changed_files}
        </span>
        <span className="n-add">+{pr.additions}</span>
        <span className="n-del">−{pr.deletions}</span>
      </div>
    </div>
  );
}

/** What the guide covers, when the reviewer narrowed it (the rest of the diff is context). */
function ScopeChip() {
  const scope = useApp((s) => s.guide?.scope);
  if (!scope?.files.length) return null;
  const files = scope.files.map((f) => f.replace(/\/$/, "").split("/").pop()).join(", ");
  return (
    <span className="scope-chip" title={`Covers ${scope.files.join(", ")}; the rest of the diff is context.`}>
      {ic(Focus, 11)}
      {scope.note || files}
    </span>
  );
}

/** Guides are written by the reviewer's coding agent; this page shows one as soon as it's submitted. */
export function NoGuide({ landing = false }: { landing?: boolean }) {
  const [copied, setCopied] = useState(false);
  const cmd = "/diffusion:review";
  return (
    <div className="no-guide">
      {landing ? "Ask your coding agent for a review:" : "No guide yet. Ask your coding agent for one:"}
      <div className="cmd">
        <code>{cmd}</code>
        <button
          type="button"
          className="icon-btn sm"
          title="Copy"
          onClick={() => {
            void navigator.clipboard?.writeText(cmd);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {ic(copied ? Check : Copy, 13)}
        </button>
      </div>
      {landing ? "It opens the review here when the guide is ready." : "It appears here when it's ready."}
    </div>
  );
}

function Steps({ onAskStep }: GuidePaneProps) {
  const guide = useApp((s) => s.guide!);
  const steps = guide.steps;
  const idx = useHunkIndex();
  const { readSteps, toggleRead, hoverStep, hoverSub, pinStep, pinSub, refAt, clearPin } = useUI();
  // The ref h/l is on, so its chip can show it.
  const active =
    pinStep != null && refAt != null
      ? refsOf(guide, pinStep, pinSub).filter((r) => refsTarget([r], idx).keys.length)[refAt]
      : null;
  const chip = (stepId: number, r: Ref) =>
    `ref${
      active &&
      stepId === pinStep &&
      r.hunk === active.hunk &&
      r.side === active.side &&
      r.start === active.start &&
      r.end === active.end
        ? " on"
        : ""
    }`;
  const link = useStepLinking();
  const done = steps.filter((s) => readSteps[s.id]).length;

  useEffect(() => {
    // h/l: move through the pinned step's (or substep's) line ranges, which may be far apart in the diff.
    const stepRef = (dir: 1 | -1) => {
      let ui = useUI.getState();
      if (ui.pinStep == null) {
        const first = readingOrder(guide)[0];
        if (!first) return;
        link.focus(first.step, first.sub);
        ui = useUI.getState();
      }
      const targets = refsOf(guide, ui.pinStep!, ui.pinSub)
        .map((r) => refsTarget([r], idx))
        .filter((t) => t.keys.length);
      if (!targets.length) return;
      const cur = ui.refAt ?? (dir > 0 ? -1 : targets.length);
      const i = Math.min(targets.length - 1, Math.max(0, cur + dir));
      if (i !== ui.refAt) ui.showRef(i, targets[i].keys, targets[i].files);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        clearPin();
        return;
      }
      if (/input|textarea/i.test((document.activeElement as HTMLElement)?.tagName ?? "")) return;
      if (e.key === "h" || e.key === "l") {
        stepRef(e.key === "l" ? 1 : -1);
        return;
      }
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
  }, [guide, link, clearPin, idx]);

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
          const cls = [
            "step",
            read && "done",
            hoverStep === s.id && hoverSub == null && "hover",
            pinStep === s.id && "active",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              key={s.id}
              className={cls}
              data-step={s.id}
              onMouseEnter={() => link.hover(s.id)}
              onClick={() => link.focus(s.id)}
            >
              <div className="num">{read ? ic(Check, 12) : s.id}</div>
              <div>
                <div className="t">
                  {ic(Kind, 14)}
                  {s.title}
                </div>
                <div className="s">
                  <Inline text={s.summary} />
                </div>
                {subs.length ? (
                  <ol className="subs" onMouseLeave={() => link.hover(s.id)}>
                    {subs.map((b) => {
                      const scls = [
                        "sub",
                        hoverStep === s.id && hoverSub === b.id && "hover",
                        pinStep === s.id && pinSub === b.id && "active",
                      ]
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
                            <div className="sub-s">
                              <Inline text={b.summary} />
                            </div>
                            <div className="refs">
                              {b.refs.map((r, i) => (
                                <span key={i} className={chip(s.id, r)}>
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
                      <span key={i} className={chip(s.id, r)}>
                        {refLabel(r, idx)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="acts">
                <button
                  type="button"
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
                    type="button"
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
      document
        .querySelector(`.file[data-path="${CSS.escape(path)}"]`)
        ?.scrollIntoView({ block: "start", behavior: "smooth" }),
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
              if (h)
                useUI.getState().focus(
                  rows.map((r) => `${r.file}:${r.pos}`),
                  [h.file],
                );
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
