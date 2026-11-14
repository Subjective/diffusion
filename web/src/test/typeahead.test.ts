import { complete, rankCommands, rankFiles, trigger } from "../lib/typeahead";

test("@ opens anywhere after a space, / only at the start", () => {
  expect(trigger("look at @sess", 13)).toEqual({ kind: "@", query: "sess", start: 8 });
  expect(trigger("@", 1)).toEqual({ kind: "@", query: "", start: 0 });
  expect(trigger("/code-r", 7)).toEqual({ kind: "/", query: "code-r", start: 0 });
  expect(trigger("  /x", 4)).toEqual({ kind: "/", query: "x", start: 2 });
  expect(trigger("why /x", 6)).toBeNull();
  expect(trigger("a@b", 3)).toBeNull();
  expect(trigger("@done ", 6)).toBeNull();
});

test("picking replaces the token and leaves the caret after a space", () => {
  const t = trigger("see @se rest", 7)!;
  expect(complete("see @se rest", 7, t, "@src/session.ts")).toEqual(["see @src/session.ts rest", 20]);
});

test("files rank by basename, changed files first; a bare @ lists the changed ones", () => {
  const paths = ["docs/session-notes.md", "src/auth/session.ts", "src/server.ts", "lib/legacy_session.py"];
  const changed = new Set(["src/auth/session.ts"]);
  expect(rankFiles(paths, "sess", changed)).toEqual([
    "src/auth/session.ts",
    "docs/session-notes.md",
    "lib/legacy_session.py",
  ]);
  expect(rankFiles(paths, "", changed)).toEqual(["src/auth/session.ts"]);
  expect(rankFiles(paths, "auth", changed)).toEqual(["src/auth/session.ts"]);
});

test("commands rank by name prefix", () => {
  const cmds = [{ name: "review" }, { name: "code-review" }, { name: "compact" }];
  expect(rankCommands(cmds, "rev").map((c) => c.name)).toEqual(["review", "code-review"]);
  expect(rankCommands(cmds, "").map((c) => c.name)).toEqual(["code-review", "compact", "review"]);
});
