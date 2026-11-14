/** Moving through a list from the keyboard: ↑↓, or ⌃P/⌃N as in the terminal and Emacs. 1 down, -1 up, 0 neither. */
export function listStep(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): number {
  if (e.key === "ArrowDown") return 1;
  if (e.key === "ArrowUp") return -1;
  if (!e.ctrlKey || e.metaKey || e.altKey) return 0;
  const k = e.key.toLowerCase();
  return k === "n" ? 1 : k === "p" ? -1 : 0;
}
