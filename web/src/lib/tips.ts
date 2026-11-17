/**
 * The app's one tooltip. Any element with `data-tip` gets it on hover or keyboard focus. It's a single fixed
 * bubble on <body>, placed from the element's box, so a pane's overflow can't clip it and the window's edge
 * can't cut it off. Tips open above (below in the top bar and toolbars, or when there's no room above).
 */

const DELAY = 350;
/** Moving straight from one tip to the next shows it at once, like a native menu bar. */
const WARM = 400;
const GAP = 6;
const EDGE = 8;

/** Props for an icon-only control: the tip, and the same text as its accessible name. */
export const tip = (label: string) => ({ "data-tip": label, "aria-label": label });

export function installTips(): () => void {
  const el = document.createElement("div");
  el.className = "tip";
  el.id = "tip";
  el.setAttribute("role", "tooltip");
  document.body.append(el);

  let target: HTMLElement | null = null;
  let shown = false;
  let timer = 0;
  let frame = 0;
  let hiddenAt = Number.NEGATIVE_INFINITY;

  const textOf = (t: HTMLElement) => (t.getAttribute("aria-expanded") === "true" ? "" : (t.dataset.tip ?? ""));

  const place = () => {
    frame = 0;
    if (!target || !shown) return;
    const text = textOf(target);
    if (!target.isConnected || !text) return hide();
    if (el.textContent !== text) el.textContent = text;
    const r = target.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const below = !!target.closest(".top, .toolbar") || r.top - GAP - h < EDGE;
    const x = Math.min(Math.max(r.left + r.width / 2 - w / 2, EDGE), vw - w - EDGE);
    const y = below ? r.bottom + GAP : r.top - GAP - h;
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    el.dataset.side = below ? "below" : "above";
    // Follow the element while it's shown: panes scroll and resize under a still pointer.
    frame = requestAnimationFrame(place);
  };

  const show = () => {
    timer = 0;
    if (!target || !textOf(target)) return;
    shown = true;
    el.textContent = textOf(target);
    el.classList.add("on");
    target.setAttribute("aria-describedby", "tip");
    cancelAnimationFrame(frame);
    place();
  };

  const hide = () => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    timer = frame = 0;
    if (shown) hiddenAt = performance.now();
    shown = false;
    el.classList.remove("on");
    if (target?.getAttribute("aria-describedby") === "tip") target.removeAttribute("aria-describedby");
    target = null;
  };

  const enter = (t: HTMLElement | null) => {
    if (t === target) return;
    hide();
    if (!t || !textOf(t)) return;
    target = t;
    if (performance.now() - hiddenAt < WARM) show();
    else timer = window.setTimeout(show, DELAY);
  };

  const owner = (n: EventTarget | null) =>
    n instanceof Element ? (n.closest("[data-tip]") as HTMLElement | null) : null;

  const over = (e: PointerEvent) => {
    if (e.pointerType !== "touch") enter(owner(e.target));
  };
  const out = (e: PointerEvent) => {
    if (target && !(e.relatedTarget instanceof Node && target.contains(e.relatedTarget))) hide();
  };
  const focus = (e: FocusEvent) => {
    const t = owner(e.target);
    if (t && t === e.target && t.matches(":focus-visible")) enter(t);
  };
  const blur = (e: FocusEvent) => {
    if (target && e.target === target && !target.matches(":hover")) hide();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") hide();
  };
  // A tip's text can change while it's up ("Copy" → "Copied"), or its menu can open.
  const watch = new MutationObserver(() => {
    if (target && shown && !frame) place();
    else if (target && !shown && !textOf(target)) hide();
  });
  watch.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-tip", "aria-expanded"] });

  document.addEventListener("pointerover", over);
  document.addEventListener("pointerout", out);
  document.addEventListener("focusin", focus);
  document.addEventListener("focusout", blur);
  document.addEventListener("keydown", key);
  window.addEventListener("blur", hide);
  return () => {
    hide();
    watch.disconnect();
    document.removeEventListener("pointerover", over);
    document.removeEventListener("pointerout", out);
    document.removeEventListener("focusin", focus);
    document.removeEventListener("focusout", blur);
    document.removeEventListener("keydown", key);
    window.removeEventListener("blur", hide);
    el.remove();
  };
}
