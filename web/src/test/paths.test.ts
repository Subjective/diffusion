import { expect, test } from "vitest";
import { parsePath, repoPath } from "../lib/cite";

test("bare paths in answers are files; other code isn't", () => {
  expect(parsePath("engine/src/diffusion/schema.py")).toBe("engine/src/diffusion/schema.py");
  expect(parsePath("/Users/j/repo/src/a.ts")).toBe("/Users/j/repo/src/a.ts");
  expect(parsePath("./src/a.ts")).toBe("src/a.ts");
  expect(parsePath("a.ts")).toBeNull();
  expect(parsePath("os.path")).toBeNull();
  expect(parsePath("src/a.ts:3")).toBeNull();
});

test("a path is matched to the repository's", () => {
  const known = ["src/a.ts", "engine/src/a.ts", "lib/b.ts"];
  expect(repoPath("src/a.ts", known)).toBe("src/a.ts");
  // an absolute path in the agent's checkout: the longest known path it ends with
  expect(repoPath("/Users/j/repo/engine/src/a.ts", known)).toBe("engine/src/a.ts");
  // a short one: only when it's unambiguous
  expect(repoPath("x/lib/b.ts", known)).toBe("lib/b.ts");
  expect(repoPath("b.ts", known)).toBe("lib/b.ts");
  expect(repoPath("a.ts", known)).toBeNull();
  expect(repoPath("/elsewhere/c.ts", known)).toBeNull();
});
