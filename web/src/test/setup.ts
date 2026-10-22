import { vi } from "vitest";

// jsdom gaps
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.scrollTo = vi.fn();
globalThis.matchMedia ??= ((q: string) => ({
  matches: false,
  media: q,
  addEventListener() {},
  removeEventListener() {},
})) as never;
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)) as never;
if (!globalThis.CSS?.escape)
  (globalThis as { CSS: unknown }).CSS = { escape: (s: string) => s.replace(/["\\]/g, "\\$&") };
