/** Grow a textarea with its text up to `maxLines`, then scroll; no scrollbar until it's needed. */
export function autosize(el: HTMLTextAreaElement | null, maxLines: number) {
  if (!el) return;
  const cs = getComputedStyle(el);
  const line = Number.parseFloat(cs.lineHeight) || 20;
  const pad = (Number.parseFloat(cs.paddingTop) || 0) + (Number.parseFloat(cs.paddingBottom) || 0);
  const max = line * maxLines + pad;
  el.style.height = "auto";
  const want = el.scrollHeight;
  el.style.height = `${Math.min(want, max)}px`;
  el.style.overflowY = want > max ? "auto" : "hidden";
}
