import { ArrowUp, FileCode, ListPlus, MessageCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Anchor } from "../chat";
import { autosize } from "../lib/autosize";
import { rangeText } from "../lib/selection";
import { ic } from "./icons";

export interface AskState {
  anchor: Anchor;
  x: number;
  y: number;
}

export function AskPopup({
  state,
  onClose,
  onAsk,
  onStage,
}: {
  state: AskState | null;
  onClose: () => void;
  onAsk: (text: string, a: Anchor) => void;
  onStage: (text: string, a: Anchor) => void;
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (state) {
      setText("");
      input.current?.focus();
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
  const submit = (stage: boolean) => {
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
        <button type="button" className="icon-btn sm" onClick={onClose} title="Close">
          {ic(X, 13)}
        </button>
      </div>
      <div className="ask-in">
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder={a.comment ? "Ask about this comment" : "Ask about these lines"}
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value);
            autosize(e.target, 5);
          }}
          onKeyDown={(e) => {
            // ↵ asks, ⌘↵ queues, ⇧↵ is a new line.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit(e.metaKey || e.ctrlKey);
            }
          }}
        />
        <button type="button" className="icon-btn" title="Queue (⌘↵)" onClick={() => submit(true)}>
          {ic(ListPlus, 17)}
        </button>
        <button type="button" className="icon-btn solid" title="Ask now (↵)" onClick={() => submit(false)}>
          {ic(ArrowUp, 16)}
        </button>
      </div>
    </div>
  );
}
