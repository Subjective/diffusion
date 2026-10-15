// Side-pane widths: guide (left) and chat (right), clamped together so the diff keeps MIN_DIFF.
import { useEffect, useState } from "react";
import { storage } from "./storage";

export const GUIDE_W = 360;
export const CHAT_W = 380;
export const MIN_GUIDE = 260;
export const MIN_CHAT = 300;
export const MIN_DIFF = 420;

export const clampGuideW = (w: number, chatW: number, vw = innerWidth) =>
  Math.round(Math.max(MIN_GUIDE, Math.min(w, vw - chatW - MIN_DIFF)));
export const clampChatW = (w: number, guideW: number, vw = innerWidth) =>
  Math.round(Math.max(MIN_CHAT, Math.min(w, vw - guideW - MIN_DIFF)));

export function usePaneWidths(chatOpen: boolean) {
  const [guide, setGuide] = useState(() => storage.get("rv-guide-w", GUIDE_W));
  const [chat, setChat] = useState(() => storage.get("rv-chat-w", CHAT_W));
  const effChat = chatOpen ? chat : 0;
  useEffect(() => {
    const fit = () => {
      setGuide((g) => clampGuideW(g, chatOpen ? clampChatW(chat, MIN_GUIDE) : 0));
      setChat((c) => clampChatW(c, MIN_GUIDE));
    };
    fit();
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, [chatOpen]);
  return {
    guide: clampGuideW(guide, effChat),
    chat: clampChatW(chat, clampGuideW(guide, effChat)),
    setGuide: (w: number) => setGuide(clampGuideW(w, effChat)),
    setChat: (w: number) => setChat(clampChatW(w, clampGuideW(guide, effChat))),
  };
}

/** Drag handler for a pane edge. `toWidth` maps the pointer x to a desired width. */
export function startResize(
  e: React.MouseEvent,
  toWidth: (x: number) => number,
  apply: (w: number) => void,
  key: string,
) {
  if (e.button !== 0) return;
  e.preventDefault();
  document.body.classList.add("resizing");
  let last: number | null = null;
  const move = (ev: MouseEvent) => {
    last = toWidth(ev.clientX);
    apply(last);
  };
  const up = () => {
    document.body.classList.remove("resizing");
    removeEventListener("mousemove", move);
    removeEventListener("mouseup", up);
    if (last != null) storage.set(key, last);
  };
  addEventListener("mousemove", move);
  addEventListener("mouseup", up);
}
