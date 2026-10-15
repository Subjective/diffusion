// Minimal inline markdown for model text: `code`, **bold**, *em*, line breaks. No HTML passthrough.
import { Fragment, type ReactNode } from "react";

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;

export function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <b key={i}>{part.slice(2, -2)}</b>;
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

const ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const indent = (l: string) => l.length - l.trimStart().length;

/** Block markdown: paragraphs, nested bullet/numbered lists, fenced code, headings (as bold). */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text.replace(/\r\n/g, "\n").split("\n"))}</div>;
}

function blocks(lines: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) body.push(lines[i++]);
      i++;
      out.push(
        <pre key={out.length} className="md-pre">
          {body.join("\n")}
        </pre>,
      );
      continue;
    }
    const m = line.match(ITEM);
    if (m) {
      const base = m[1].length;
      const ordered = /\d/.test(m[2]);
      const items: { text: string; sub: string[] }[] = [];
      while (i < lines.length) {
        const im = lines[i].match(ITEM);
        if (!im || im[1].length !== base || /\d/.test(im[2]) !== ordered) break;
        const sub: string[] = [];
        i++;
        // Deeper-indented lines (sub-lists, continuations) belong to this item, even across blank lines.
        for (let j = i; j < lines.length; j++) {
          if (!lines[j].trim()) continue;
          if (indent(lines[j]) <= base) break;
          sub.push(...lines.slice(i, j + 1));
          i = j + 1;
        }
        items.push({ text: im[3], sub });
        // A blank line between items doesn't end the list (the model writes "1. …\n\n2. …").
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        const nm = lines[j]?.match(ITEM);
        if (nm && nm[1].length === base && /\d/.test(nm[2]) === ordered) i = j;
      }
      const n = ordered ? parseInt(m[2], 10) : 1;
      const L = ordered ? "ol" : "ul";
      out.push(
        <L key={out.length} start={n !== 1 ? n : undefined}>
          {items.map((it, k) => (
            <li key={k}>
              {inline(it.text)}
              {it.sub.length > 0 && blocks(dedent(it.sub))}
            </li>
          ))}
        </L>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].trimStart().startsWith("```") && !ITEM.test(lines[i]))
      para.push(lines[i++].trim());
    const head = para[0].match(/^#{1,6}\s+(.*)/);
    out.push(
      head ? (
        <p key={out.length}>
          <b>{inline(head[1])}</b>
        </p>
      ) : (
        <p key={out.length}>{inline(para.join(" "))}</p>
      ),
    );
  }
  return out;
}

function dedent(lines: string[]): string[] {
  const d = Math.min(...lines.filter((l) => l.trim()).map(indent));
  return lines.map((l) => l.slice(d));
}
