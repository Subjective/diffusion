import { Clock, LoaderCircle, MessageCircle } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { questionRows } from "../App";
import { useChat } from "../chat";
import { useHunkIndex } from "../lib/linking";
import { rowKey } from "../lib/refs";
import { ic } from "./icons";

/** Row-key → badge node for anchored questions in the active chat (queued → answering → answered). */
export function useQuestionBadges(
  hoverQ: string | null,
  onHoverQ: (id: string | null) => void,
  revealQ: (id: string) => void,
): Map<string, ReactNode> {
  const questions = useChat((s) => s.chat.questions);
  const idx = useHunkIndex();
  return useMemo(() => {
    const byRow = new Map<string, typeof questions>();
    for (const q of questions) {
      if (!q.anchor || q.n == null || q.anchor.step != null) continue;
      const { keys } = questionRows(q, idx);
      if (!keys.length) continue;
      const k = keys[0];
      byRow.set(k, [...(byRow.get(k) ?? []), q]);
    }
    const out = new Map<string, ReactNode>();
    for (const [k, qs] of byRow) {
      out.set(
        k,
        <span className="qbs" key={k}>
          {qs.map((q) => {
            // A note waiting to be sent is just its number, as on its pill in the composer.
            const icon =
              q.status === "pending"
                ? LoaderCircle
                : q.status === "staged"
                  ? null
                  : q.status === "waiting"
                    ? Clock
                    : MessageCircle;
            return (
              <button
                type="button"
                key={q.id}
                className={`qb s-${q.status}${hoverQ === q.id ? " hover" : ""}`}
                title={q.status === "staged" ? q.text : undefined}
                data-q={q.id}
                onMouseEnter={() => onHoverQ(q.id)}
                onMouseLeave={() => onHoverQ(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  revealQ(q.id);
                }}
              >
                {icon && ic(icon, 11)}
                {q.n}
              </button>
            );
          })}
        </span>,
      );
    }
    void rowKey;
    return out;
  }, [questions, idx, hoverQ, onHoverQ, revealQ]);
}
