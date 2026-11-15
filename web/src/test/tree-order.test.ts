import { expect, test } from "vitest";
import { treeOrder } from "../components/FileRail";

test("file tree order: folders before files, A–Z, as the navigator lists them", () => {
  const paths = [
    "engine/uv.lock",
    "engine/src/diffusion/symbols.py",
    "engine/pyproject.toml",
    "web/a.tsx",
    "README.md",
  ];
  expect(treeOrder(paths)).toEqual([
    "engine/src/diffusion/symbols.py",
    "engine/pyproject.toml",
    "engine/uv.lock",
    "web/a.tsx",
    "README.md",
  ]);
});
