import { ArrowUp, Check, FileCode, ListPlus, MessageCircle, MessageSquarePlus, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Anchor } from "../chat";
import { useChat } from "../chat";
import { autosize } from "../lib/autosize";
import { rangeText } from "../lib/selection";
import { storage } from "../lib/storage";
import { tip } from "../lib/tips";
import { commentable } from "../review";
import { useApp } from "../store";
import { GithubIcon, HarnessMark, ic } from "./icons";

export interface AskState {
  anchor: Anchor;
  x: number;
  y: number;
  /** Editing a line note that's attached to the next message. */
  edit?: { id: string; text: string };
}

export function AskPopup({
  state,
  onClose,
  onAsk,
  onStage,
  onEdit,
  github,
}: {
  state: AskState | null;
  onClose: () => void;
  onAsk: (text: string, a: Anchor) => void;
  onStage: (text: string, a: Anchor) => void;
  /** Save an edited note; empty text removes it. */
  onEdit: (id: string, text: string) => void;
  /** On a GitHub PR the popup can also write review comments: ↵ adds one to your review, ⌘↵ posts it now. */
  github?: { onPending: (text: string, a: Anchor) => void; onComment: (text: string, a: Anchor) => void };
}) {
  const [text, setText] = useState("");
  const [mode, setModeState] = useState<"ask" | "github">(() => storage.get("rv-ask-mode", "ask"));
  const input = useRef<HTMLTextAreaElement>(null);
  const harness = useChat((s) => s.chat.harness) ?? useApp.getState().guide?.meta?.harness ?? null;
  const setMode = (m: "ask" | "github") => {
    setModeState(m);
    storage.set("rv-ask-mode", m);
    input.current?.focus();
  };

  useEffect(() => {
    if (state) {
      setText(state.edit?.text ?? "");
      input.current?.focus();
      if (state.edit) requestAnimationFrame(() => input.current?.select());
      requestAnimationFrame(() => autosize(input.current, 5));
    }
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".ask-pop") && !(e.target as HTMLElement).closest(".ask-btn")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("mousedown", onDown);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("mousedown", onDown);
      removeEventListener("keydown", onKey);
    };
  }, [state, onClose]);

  if (!state) return null;
  const a = state.anchor;
  const editing = state.edit;
  // Comments go on lines of the diff; asking about a guide comment or editing a note stays with the agent.
  const lines = !!github && !editing && !a.comment;
  // GitHub only takes comments on lines of the PR's diff; elsewhere its option shows, greyed out.
  const inDiff = lines && commentable(useApp.getState().files, a.file, a.side, a.start, a.end);
  const canComment = lines && inDiff;
  const gh = canComment && mode === "github";
  const submit = (stage: boolean) => {
    if (editing) {
      onEdit(editing.id, text.trim());
      onClose();
      return;
    }
    if (gh) {
      if (!text.trim()) return;
      (stage ? github!.onPending : github!.onComment)(text.trim(), a);
      onClose();
      return;
    }
    const q = text.trim() || (a.comment ? "Tell me more about this comment." : "Explain this.");
    (stage ? onStage : onAsk)(q, a);
    onClose();
  };

  return (
    <div
      className="ask-pop"
      style={{ left: Math.min(state.x, innerWidth - 376), top: Math.min(state.y + 12, innerHeight - 120) }}
    >
      <div className="ask-ctx">
        {ic(a.commentTitle ? MessageCircle : FileCode, 13)}
        {a.commentTitle && (
          <b className="ask-cmt" title={a.commentTitle}>
            {a.commentTitle}
          </b>
        )}
        <b className="ask-file" title={a.file}>
          {a.file.split("/").pop()}
        </b>
        <span className="ask-range">{rangeText(a.start, a.end)}</span>
        <span className="grow" />
        {lines && (
          <span className="seg ask-mode">
            <button
              type="button"
              className={`icon-btn${gh ? "" : " on"}`}
              {...tip("Ask")}
              aria-pressed={!gh}
              onClick={() => setMode("ask")}
            >
              <HarnessMark harness={harness} size={13} />
            </button>
            <button
              type="button"
              className={`icon-btn${gh ? " on" : ""}`}
              {...tip(inDiff ? "Comment on GitHub" : "Only lines in the diff can be commented on")}
              aria-pressed={gh}
              disabled={!inDiff}
              onClick={() => setMode("github")}
            >
              <GithubIcon size={13} />
            </button>
          </span>
        )}
        <button type="button" className="icon-btn sm" onClick={onClose} {...tip("Close")}>
          {ic(X, 13)}
        </button>
      </div>
      <div className="ask-in">
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder={gh ? "Comment" : a.comment ? "Ask about this comment" : "Ask about these lines"}
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value);
            autosize(e.target, 5);
          }}
          onKeyDown={(e) => {
            // Tab switches between asking and commenting.
            if (e.key === "Tab" && canComment && !e.shiftKey) {
              e.preventDefault();
              setMode(gh ? "ask" : "github");
              return;
            }
            // ↵ queues (or adds to your review), ⌘↵ asks (or comments) now, ⇧↵ is a new line.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit(!(e.metaKey || e.ctrlKey));
            }
          }}
        />
        {editing ? (
          <button type="button" className="icon-btn solid" {...tip("Save (↵)")} onClick={() => submit(true)}>
            {ic(Check, 16)}
          </button>
        ) : gh ? (
          <>
            <button type="button" className="icon-btn" {...tip("Add to review (↵)")} onClick={() => submit(true)}>
              {ic(MessageSquarePlus, 17)}
            </button>
            <button type="button" className="icon-btn solid" {...tip("Comment now (⌘↵)")} onClick={() => submit(false)}>
              {ic(Send, 15)}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="icon-btn" {...tip("Queue (↵)")} onClick={() => submit(true)}>
              {ic(ListPlus, 17)}
            </button>
            <button type="button" className="icon-btn solid" {...tip("Ask now (⌘↵)")} onClick={() => submit(false)}>
              {ic(ArrowUp, 16)}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
