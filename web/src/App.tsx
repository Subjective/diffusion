import { CircleAlert, GitPullRequest } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { type Question, useChat } from "./chat";
import { AskPopup } from "./components/AskPopup";
import { type ChatLinkProps, ChatPanel } from "./components/ChatPanel";
import type { AskComment } from "./components/Comments";
import { DiffPane } from "./components/DiffPane";
import { GuidePane, NoGuide } from "./components/GuidePane";
import { ic } from "./components/icons";
import { useQuestionBadges } from "./components/QuestionBadges";
import { TopBar } from "./components/TopBar";
import { refsTarget, useHunkIndex, useStepLinking } from "./lib/linking";
import { usePaneWidths } from "./lib/panes";
import { type HunkIndex, rowKey } from "./lib/refs";
import { useAsk } from "./lib/useAsk";
import { useApp } from "./store";
import type { Step } from "./types";
import { useUI } from "./ui";

const POLL_MS = 2500;

/** Row keys an anchored question covers. */
export function questionRows(q: Question, idx: HunkIndex): { keys: string[]; files: string[] } {
  const a = q.anchor;
  if (!a) return { keys: [], files: [] };
  if (a.refs?.length) return refsTarget(a.refs, idx);
  if (a.pfrom == null || a.pto == null) return { keys: [], files: [a.file] };
  const keys: string[] = [];
  for (const rows of idx.rows.values())
    for (const r of rows) if (r.file === a.file && r.pos >= a.pfrom && r.pos <= a.pto) keys.push(rowKey(r.file, r.pos));
  return { keys, files: [a.file] };
}

export function App() {
  const { theme, chatOpen, pr, error, loading, url, load, toggleChat } = useApp();
  const panes = usePaneWidths(chatOpen);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: load the target from the link once, on mount.
  useEffect(() => {
    if (url && !pr) void load();
  }, []);

  // New guide versions (a resubmit, an edit from chat) show up without a reload.
  const loaded = !!pr;
  useEffect(() => {
    if (!loaded) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void useApp.getState().refresh();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [loaded]);

  const files = useApp((s) => s.files);
  const skippable = useApp((s) => s.guide?.skippable);
  useEffect(() => {
    if (!pr) return;
    const skip = new Set([...files.filter((f) => f.skip).map((f) => f.path), ...(skippable?.map((s) => s.file) ?? [])]);
    useUI
      .getState()
      .init(
        `${pr.owner}/${pr.repo}#${pr.number}@${pr.head_sha.slice(0, 12)}`,
        Object.fromEntries([...skip].map((p) => [p, true])),
      );
    useChat.getState().reset(pr.url);
  }, [pr, files, skippable]);

  const link = useStepLinking();
  const idx = useHunkIndex();

  // Step dots anywhere in the diff link back to their step.
  const onOver = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".diffpane [data-step]");
    const id = el ? Number(el.dataset.step) : null;
    const sub = el?.dataset.sub ? Number(el.dataset.sub) : null;
    const ui = useUI.getState();
    if ((id !== ui.hoverStep || sub !== ui.hoverSub) && (id != null || (e.target as HTMLElement).closest(".diffpane")))
      link.hover(id, sub);
  };
  const onClick = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".diffpane [data-step]");
    if (!el) return;
    e.stopPropagation();
    const id = Number(el.dataset.step);
    const sub = el.dataset.sub ? Number(el.dataset.sub) : null;
    link.focus(id, sub);
    const sel = sub == null ? `.step[data-step="${id}"]` : `.sub[data-step="${id}"][data-sub="${sub}"]`;
    document.querySelector(sel)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  // Question ⇄ lines linking
  const [hoverQ, setHoverQ] = useState<string | null>(null);
  const [flashQ, setFlashQ] = useState<{ id: string; n: number } | null>(null);
  const onHoverQ = useCallback(
    (id: string | null) => {
      setHoverQ(id);
      const q = id ? useChat.getState().chat.questions.find((x) => x.id === id) : null;
      useUI.getState().setHover(q ? questionRows(q, idx).keys : []);
    },
    [idx],
  );
  const onFocusQ = useCallback(
    (q: Question) => {
      const t = questionRows(q, idx);
      useUI.getState().focus(t.keys, t.files);
    },
    [idx],
  );
  const revealQ = useCallback(
    (id: string) => {
      toggleChat(true);
      setFlashQ((f) => ({ id, n: (f?.n ?? 0) + 1 }));
      requestAnimationFrame(() =>
        document
          .querySelector(`[data-ans="${id}"], .q-row[data-q="${id}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" }),
      );
    },
    [toggleChat],
  );
  const chatLink: ChatLinkProps = { onHoverQ, onFocusQ, hoverQ, flashQ };
  const badges = useQuestionBadges(hoverQ, onHoverQ, revealQ);
  const { ask, close, open } = useAsk();
  const askComment: AskComment = useCallback(
    (c, keys, at) => {
      const rows = keys
        .map((k) => document.querySelector<HTMLElement>(`tr.ln[data-rk="${CSS.escape(k)}"]`))
        .filter((r): r is HTMLElement => !!r);
      open(rows, at.x, at.y, { comment: `${c.title}. ${c.text}`, commentTitle: c.title });
    },
    [open],
  );

  const askStep = useCallback(
    (s: Step) => {
      toggleChat(true);
      useChat.getState().ask(`Walk me through step ${s.id}.`, {
        file: "",
        start: 0,
        end: 0,
        side: "new",
        code: "",
        step: s.id,
        stepTitle: s.title,
        stepKind: s.kind,
        refs: s.refs,
      });
    },
    [toggleChat],
  );
  return (
    <>
      <TopBar />
      {error && (
        <div className="banner err" role="alert">
          {ic(CircleAlert, 15)}
          <span>{error}</span>
        </div>
      )}
      {!pr ? (
        <main className="landing">
          {url || loading ? (
            <div className="landing-i">
              {loading ? <span className="spin">{ic(GitPullRequest, 22)}</span> : ic(GitPullRequest, 22)}
            </div>
          ) : (
            <NoGuide landing />
          )}
        </main>
      ) : (
        <main
          className={`app${chatOpen ? "" : " no-chat"}`}
          id="app"
          style={{ "--chat-w": `${panes.chat}px`, "--guide-w": `${panes.guide}px` } as CSSProperties}
          onMouseOver={onOver}
          onClickCapture={onClick}
        >
          <GuidePane onAskStep={askStep} onWidth={panes.setGuide} />
          <DiffPane extras={badges} onAskComment={askComment} />
          {chatOpen ? <ChatPanel onWidth={panes.setChat} link={chatLink} /> : <aside className="chat" />}
        </main>
      )}
      <AskPopup
        state={ask}
        onClose={close}
        onAsk={(text, a) => {
          useChat.getState().ask(text, a);
          useApp.getState().toggleChat(true);
        }}
        onStage={(text, a) => {
          useChat.getState().stage(text, a);
          useApp.getState().toggleChat(true);
        }}
      />
    </>
  );
}
