// Go to definition: the name under a ⌘/Ctrl-click, and where to return after jumping within the diff.

const WORD = /[\w$]/;

/** The identifier in `text` touching `offset`, or null. */
export function wordAt(text: string, offset: number): string | null {
  let a = offset;
  let b = offset;
  while (a > 0 && WORD.test(text[a - 1])) a--;
  while (b < text.length && WORD.test(text[b])) b++;
  const w = text.slice(a, b);
  return /^[A-Za-z_$][\w$]*$/.test(w) ? w : null;
}

/** The identifier under a point in the page, via the caret position there. */
export function wordAtPoint(x: number, y: number): string | null {
  const doc = document as Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
  };
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos)
    return pos.offsetNode.nodeType === Node.TEXT_NODE ? wordAt(pos.offsetNode.textContent ?? "", pos.offset) : null;
  const range = document.caretRangeFromPoint?.(x, y);
  if (range?.startContainer.nodeType === Node.TEXT_NODE)
    return wordAt(range.startContainer.textContent ?? "", range.startOffset);
  return null;
}

/** Diff scroll positions to return to (⌘[) after jumping to a definition inside the diff. */
export const backStack: number[] = [];
