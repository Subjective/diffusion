/** Seconds since the epoch → a compact age: now, 5m, 3h, 2d, 4mo, 3y. */
export const ago = (t: number) => {
  const m = Math.round((Date.now() / 1000 - t) / 60);
  const d = Math.floor(m / 1440);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  if (d < 30) return `${d}d`;
  return d < 365 ? `${Math.floor(d / 30)}mo` : `${Math.floor(d / 365)}y`;
};

/** Seconds since the epoch → a date for a tooltip: "Nov 12", or "Nov 12, 2023" in another year. */
export const dateText = (t: number) => {
  const at = new Date(t * 1000);
  const year = at.getFullYear() === new Date().getFullYear() ? undefined : "numeric";
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric", year });
};
