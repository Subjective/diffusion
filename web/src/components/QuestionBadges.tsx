import { type ReactNode, useMemo } from "react";
import { questionRows } from "../App";
import { useChat } from "../chat";
import { useHunkIndex } from "../lib/linking";
import { rowKey } from "../lib/refs";

/** Row-key → badge node for anchored questions in the active chat (staged → queued → answering → answered), on the
 *  first line each covers: a diff row, an expanded context line, or a line in a file tab. */
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
            // One numbered bubble wherever a note shows (here, its pill, its message); only its fill says where
            // it's at: staged solid, queued outlined, answering pulsing, answered dark.
            return (
              <button
                type="button"
                key={q.id}
                className={`qb s-${q.status}${hoverQ === q.id ? " hover" : ""}`}
                data-q={q.id}
                onMouseEnter={() => onHoverQ(q.id)}
                onMouseLeave={() => onHoverQ(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  revealQ(q.id);
                }}
              >
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
