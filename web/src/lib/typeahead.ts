/** The composer's @ file and / command menus: what's being typed, and what matches it. */

export interface Trigger {
  kind: "@" | "/";
  query: string;
  /** Where the token (its @ or /) starts in the text. */
  start: number;
}

/** The token ending at the caret, if it opens a menu: `/name` at the very start, `@path` at the start or after
 *  a space. */
export function trigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)([@/])([^\s]*)$/.exec(before);
  if (!m) return null;
  const start = m.index + m[1].length;
  const kind = m[2] as "@" | "/";
  if (kind === "/" && before.slice(0, start).trim()) return null;
  return { kind, query: m[3], start };
}

/** Replace the token with `insert` and a space; returns the new text and caret. */
export function complete(text: string, caret: number, t: Trigger, insert: string): [string, number] {
  const end = caret + (/^[^\s]*/.exec(text.slice(caret))?.[0].length ?? 0);
  const out = `${text.slice(0, t.start)}${insert} ${text.slice(end).replace(/^ /, "")}`;
  return [out, t.start + insert.length + 1];
}

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Files for `@query`: basename prefix first, then basename, then anywhere in the path; shorter paths first. */
export function rankFiles(paths: string[], query: string, changed: Set<string>, limit = 8): string[] {
  const q = query.toLowerCase();
  const score = (p: string) => {
    const l = p.toLowerCase();
    const b = base(l);
    if (!q) return changed.has(p) ? 0 : -1;
    if (b.startsWith(q)) return 0;
    if (b.includes(q)) return 1;
    if (l.includes(q)) return 2;
    return -1;
  };
  return paths
    .map((p) => [p, score(p)] as const)
    .filter(([, s]) => s >= 0)
    .sort(([a, x], [b, y]) => x - y || Number(changed.has(b)) - Number(changed.has(a)) || a.length - b.length)
    .slice(0, limit)
    .map(([p]) => p);
}

/** Commands for `/query`: name prefix first, then anywhere in the name. */
export function rankCommands<T extends { name: string }>(cmds: T[], query: string, limit = 8): T[] {
  const q = query.toLowerCase();
  const score = (c: T) => (c.name.toLowerCase().startsWith(q) ? 0 : c.name.toLowerCase().includes(q) ? 1 : -1);
  return cmds
    .filter((c) => score(c) >= 0)
    .sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))
    .slice(0, limit);
}
