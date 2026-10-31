import { Check, ChevronRight, MessageCircle, RotateCcw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { refsTarget } from "../lib/linking";
import { Inline } from "../lib/md";
import { type HunkIndex, rowKey, rowsForRef } from "../lib/refs";
import type { Comment } from "../types";
import { useUI } from "../ui";
import { ic } from "./icons";

/** Open the ask popup for a comment: its lines are the anchor, the comment rides along as context. */
export type AskComment = (c: Comment, keys: string[], at: { x: number; y: number }) => void;

/** Comment rows by the row key of each comment's last cited line, where they render, GitHub-style. Resolved
 *  comments stay, collapsed to a dimmed line that opens to show the comment and Unresolve. */
export function commentRows(
  comments: Comment[],
  idx: HunkIndex,
  resolved: Record<string, boolean>,
  onAsk: AskComment,
): Map<string, ReactNode> {
  const byRow = new Map<string, Comment[]>();
  for (const c of comments) {
    const rows = rowsForRef(c.refs[c.refs.length - 1], idx);
    const last = rows[rows.length - 1];
    if (!last) continue;
    const k = rowKey(last.file, last.pos);
    byRow.set(k, [...(byRow.get(k) ?? []), c]);
  }
  return new Map(
    [...byRow].map(([k, cs]) => [
      k,
      cs.map((c) => <CommentRow key={c.id} c={c} idx={idx} onAsk={onAsk} resolved={!!resolved[c.title]} />),
    ]),
  );
}

function CommentRow({ c, idx, onAsk, resolved }: { c: Comment; idx: HunkIndex; onAsk: AskComment; resolved: boolean }) {
  const { keys } = refsTarget(c.refs, idx);
  const ui = useUI.getState;
  const [open, setOpen] = useState(false);
  if (resolved && !open)
    return (
      <tr className="cmt-row resolved" data-tone={c.tone}>
        <td colSpan={4}>
          <button type="button" className="cmt-closed" onClick={() => setOpen(true)} title="Show resolved comment">
            {ic(ChevronRight, 13)}
            <span>Resolved</span>
            <b>{c.title}</b>
          </button>
        </td>
      </tr>
    );
  return (
    <tr
      className={`cmt-row${resolved ? " resolved" : ""}`}
      data-tone={c.tone}
      onMouseEnter={() => ui().setHover(keys)}
      onMouseLeave={() => ui().setHover([])}
    >
      <td colSpan={4}>
        <div className="cmt">
          <div className="cmt-h">
            <span className="cmt-tone" title={c.tone}>
              {ic(MessageCircle, 13)}
            </span>
            <b>{c.title}</b>
            <span className="grow" />
            <button
              type="button"
              className="icon-btn sm"
              title="Ask in chat"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                onAsk(c, keys, { x: r.left - 340, y: r.bottom });
              }}
            >
              {ic(MessageCircle, 14)}
            </button>
            {resolved ? (
              <button
                type="button"
                className="icon-btn sm"
                title="Unresolve"
                onClick={() => {
                  setOpen(false);
                  ui().resolve(c.title, false);
                }}
              >
                {ic(RotateCcw, 14)}
              </button>
            ) : (
              <button type="button" className="icon-btn sm" title="Resolve" onClick={() => ui().resolve(c.title)}>
                {ic(Check, 14)}
              </button>
            )}
          </div>
          <div className="cmt-t">
            <Inline text={c.text} />
          </div>
        </div>
      </td>
    </tr>
  );
}
