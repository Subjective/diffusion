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

/** Block markdown: paragraphs, bullet/numbered lists, fenced code, headings (as bold). */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={blocks.length} className="md-pre">
          {body.join("\n")}
        </pre>,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const L = ordered ? "ol" : "ul";
      blocks.push(
        <L key={blocks.length}>
          {items.map((t, k) => (
            <li key={k}>{inline(t)}</li>
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
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith("```") && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]))
      para.push(lines[i++]);
    const head = para[0].match(/^#{1,6}\s+(.*)/);
    blocks.push(
      head ? (
        <p key={blocks.length}>
          <b>{inline(head[1])}</b>
        </p>
      ) : (
        <p key={blocks.length}>{inline(para.join(" "))}</p>
      ),
    );
  }
  return <div className="md">{blocks}</div>;
}
