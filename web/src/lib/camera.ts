/** The map's camera: an SVG viewBox, eased between framings and zoomed about a point. */
export type VB = [number, number, number, number];

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** The viewBox `k` of the way from `a` to `b`: the center moves linearly and the scale geometrically,
 *  so a zoom feels even all the way through instead of rushing at the wide end. */
export function lerpVB(a: VB, b: VB, k: number): VB {
  const w = a[2] * (b[2] / a[2]) ** k;
  const h = a[3] * (b[3] / a[3]) ** k;
  const cx = a[0] + a[2] / 2 + (b[0] + b[2] / 2 - (a[0] + a[2] / 2)) * k;
  const cy = a[1] + a[3] / 2 + (b[1] + b[3] / 2 - (a[1] + a[3] / 2)) * k;
  return [cx - w / 2, cy - h / 2, w, h];
}

/** `v` scaled by `k` about the point (`fx`, `fy`), given as fractions of the view, with its width kept in [min, max]. */
export function zoomVB(v: VB, k: number, fx = 0.5, fy = 0.5, min = 0, max = Number.POSITIVE_INFINITY): VB {
  const s = Math.max(min / v[2], Math.min(max / v[2], k));
  const px = v[0] + fx * v[2];
  const py = v[1] + fy * v[3];
  return [px - (px - v[0]) * s, py - (py - v[1]) * s, v[2] * s, v[3] * s];
}

/** Whether a wheel event came from a trackpad (or another smooth-scrolling device) rather than a notched mouse
 *  wheel. Browsers don't say, so: line or page deltas are a wheel (Firefox), sideways motion is a trackpad, and
 *  a wheel's legacy `wheelDelta` comes in whole notches of 120 (Chrome, Safari, Edge). */
export function fromTrackpad(e: Pick<WheelEvent, "deltaMode" | "deltaX" | "deltaY"> & { wheelDeltaY?: number }) {
  if (e.deltaMode !== 0) return false;
  if (e.deltaX !== 0) return true;
  const w = e.wheelDeltaY;
  if (typeof w !== "number" || w === 0) return true;
  return w % 120 !== 0;
}
