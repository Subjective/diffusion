import { useLayoutEffect, useState } from "react";
import { useChat } from "../chat";

/** Hovering a line note waiting to be sent (its badge on the line, or its pill) shows what it says, in the popup's
 *  style; clicking reopens it to edit. */
export function NotePeek({ id }: { id: string | null }) {
  const q = useChat((s) => (id ? s.chat.questions.find((x) => x.id === id && x.status === "staged") : undefined));
  const [at, setAt] = useState<{ x: number; y: number; above: boolean } | null>(null);
  useLayoutEffect(() => {
    const el = q && document.querySelector(`[data-q="${q.id}"]:hover`);
    if (!el) return setAt(null);
    const r = el.getBoundingClientRect();
    const above = r.top > innerHeight / 2;
    setAt({ x: Math.min(r.left, innerWidth - 336), y: above ? innerHeight - r.top + 6 : r.bottom + 6, above });
  }, [q]);
  if (!q || !at) return null;
  return (
    <div
      className="ask-pop note-peek"
      style={{ left: at.x, ...(at.above ? { bottom: at.y } : { top: at.y }) }}
      role="tooltip"
    >
      {q.text}
    </div>
  );
}
