// Markdown for model text, via react-markdown + GFM. Raw HTML is never rendered.
import type { Element, ElementContent } from "hast";
import { type ComponentType, createContext, Fragment, useContext } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** Optional renderer for inline code spans (chat uses it to turn `path:line` citations into diff links). */
export const InlineCodeContext = createContext<ComponentType<{ text: string }> | null>(null);

function InlineCode({ text }: { text: string }) {
  const Render = useContext(InlineCodeContext);
  return Render ? <Render text={text} /> : <code>{text}</code>;
}

const textOf = (n: ElementContent | Element): string =>
  n.type === "text" ? n.value : "children" in n ? n.children.map(textOf).join("") : "";

const BLOCK: Components = {
  // Fenced code renders as plain preformatted text; `code` below only ever sees inline spans.
  pre: ({ node }) => <pre className="md-pre">{node ? textOf(node).replace(/\n$/, "") : null}</pre>,
  code: ({ children }) => <InlineCode text={String(children)} />,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

const plugins = [remarkGfm];

/** Block markdown: paragraphs, headings, nested lists, fenced code, links, tables, blockquotes. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={plugins} components={BLOCK}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

const INLINE: Components = { ...BLOCK, p: ({ children }) => <Fragment>{children}</Fragment> };
const INLINE_TAGS = ["p", "code", "strong", "em", "del", "a"];

/** One line of markdown inside an existing element: inline formatting only, no wrapping paragraph. */
export function Inline({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={INLINE} allowedElements={INLINE_TAGS} unwrapDisallowed>
      {text}
    </ReactMarkdown>
  );
}
