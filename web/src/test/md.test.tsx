import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "../lib/md";

const html = (text: string) => render(<Markdown text={text} />).container;

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
    expect(items[1].textContent).toBe("Session loss. Gone on panic.");
  });

  it("continues a list's numbering when it restarts after a paragraph", () => {
    const c = html("1. a\n\nSome prose.\n\n2. b");
    expect(c.querySelectorAll("ol")[1].getAttribute("start")).toBe("2");
  });

  it("still renders flat lists and paragraphs", () => {
    const c = html("Intro line\nwraps.\n\n- x\n- y");
    expect(c.querySelector("p")!.textContent).toBe("Intro line wraps.");
    expect(c.querySelectorAll("ul > li")).toHaveLength(2);
  });
});
