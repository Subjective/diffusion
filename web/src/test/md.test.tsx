import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Inline, InlineCodeContext, Markdown } from "../lib/md";

const html = (text: string) => render(<Markdown text={text} />).container;
// Soft line breaks and loose-list paragraphs leave newlines in textContent; the browser renders them as spaces.
const words = (el: Element) => el.textContent!.replace(/\s+/g, " ").trim();

describe("Markdown lists", () => {
  it("keeps numbering across blank lines and nests indented sub-points", () => {
    const c = html(
      [
        "1. **Racy cancel.**",
        "   - unbiased select",
        "   - emit can block",
        "",
        "2. **Session loss.** Gone on panic.",
        "",
        "3. **Coverage.**",
      ].join("\n"),
    );
    const top = c.querySelectorAll(".md > ol");
    expect(top).toHaveLength(1);
    const items = top[0].querySelectorAll(":scope > li");
    expect(items).toHaveLength(3);
    expect(items[0].querySelectorAll(":scope > ul > li")).toHaveLength(2);
    expect(words(items[1])).toBe("Session loss. Gone on panic.");
  });

  it("continues a list's numbering when it restarts after a paragraph", () => {
    const c = html("1. a\n\nSome prose.\n\n2. b");
    expect(c.querySelectorAll("ol")[1].getAttribute("start")).toBe("2");
  });

  it("still renders flat lists and paragraphs", () => {
    const c = html("Intro line\nwraps.\n\n- x\n- y");
    expect(words(c.querySelector("p")!)).toBe("Intro line wraps.");
    expect(c.querySelectorAll("ul > li")).toHaveLength(2);
  });
});

describe("Markdown blocks and inline", () => {
  it("renders bold-wrapped inline code as code inside bold", () => {
    const c = html("See **`run()`** first.");
    expect(c.querySelector("strong > code")!.textContent).toBe("run()");
  });

  it("renders headings, links, blockquotes and tables", () => {
    const c = html("## Risks\n\n> careful\n\n[docs](https://example.com)\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(c.querySelector("h2")!.textContent).toBe("Risks");
    expect(c.querySelector("blockquote")!.textContent.trim()).toBe("careful");
    expect(c.querySelector("a")!.getAttribute("href")).toBe("https://example.com");
    expect(c.querySelectorAll("td")).toHaveLength(2);
  });

  it("escapes raw HTML", () => {
    const c = html("<img src=x onerror=alert(1)> hi");
    expect(c.querySelector("img")).toBeNull();
  });

  it("keeps fenced code out of the inline-code renderer", () => {
    const Cite = ({ text }: { text: string }) => <button type="button">{text}</button>;
    const c = render(
      <InlineCodeContext.Provider value={Cite}>
        <Markdown text={"Look at `a.ts:3`.\n\n```\nconst x = 1;\n```"} />
      </InlineCodeContext.Provider>,
    ).container;
    expect(c.querySelector("p button")!.textContent).toBe("a.ts:3");
    expect(c.querySelector("pre.md-pre")!.textContent).toBe("const x = 1;");
    expect(c.querySelector("pre button")).toBeNull();
  });

  it("renders inline markdown without a wrapping paragraph", () => {
    const c = render(<Inline text={"Uses **`foo`** and *bar*"} />).container;
    expect(c.querySelector("p")).toBeNull();
    expect(c.querySelector("strong > code")!.textContent).toBe("foo");
    expect(c.querySelector("em")!.textContent).toBe("bar");
  });
});
