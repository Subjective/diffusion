import { type RefObject, useEffect, useRef, useState } from "react";

/** Open state for a popover anchored in `ref`: a click outside it or Escape closes it. */
export function usePopover<T extends HTMLElement = HTMLDivElement>(): [
  boolean,
  (open: boolean) => void,
  RefObject<T | null>,
] {
  const [open, setOpen] = useState(false);
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", close);
    };
  }, [open]);
  return [open, setOpen, ref];
}
