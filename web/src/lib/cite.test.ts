import { files } from "../test/fixture";
import { expandCites, findFile, parseCite, parseCites, resolveLoc } from "./cite";
import { indexFiles } from "./refs";

test("parseCite accepts path:line and ranges, rejects other code", () => {
  expect(parseCite("src/auth/session.ts:14")).toEqual({ file: "src/auth/session.ts", start: 14, end: 14, side: "new" });
  expect(parseCite("session.ts:12–20")).toMatchObject({ file: "session.ts", start: 12, end: 20 });
  expect(parseCite("./a/b.py:L3-L5")).toMatchObject({ file: "a/b.py", start: 3, end: 5 });
  expect(parseCite("x.ts:9-2")).toMatchObject({ start: 2, end: 9 });
  expect(parseCite(".github/workflows/ci.yml:4")).toMatchObject({ file: ".github/workflows/ci.yml" });
  for (const s of ["end()", "a:b", "localhost:8080", "std::vector", "session.ts", "http://x.io:80"])
    expect(parseCite(s)).toBeNull();
});

test("parseCites links each range of a list on one file", () => {
  expect(parseCites("session.ts:2, 6–7")).toEqual([
    { loc: { file: "session.ts", start: 2, end: 2, side: "new" }, text: "session.ts:2" },
    { loc: { file: "session.ts", start: 6, end: 7, side: "new" }, text: "6–7" },
  ]);
  expect(parseCites("a.py:L3,L9")?.map((c) => c.loc.start)).toEqual([3, 9]);
  expect(parseCites("a.py:3, b")).toBeNull();
});

test("expandCites names the file in bare line citations that follow a full one", () => {
  expect(expandCites("at `src/a.ts:7`, declared at `:5` and `L9–12`")).toBe(
    "at `src/a.ts:7`, declared at `src/a.ts:5` and `src/a.ts:L9–12`",
  );
  expect(expandCites("`a.ts:1` then `b.go:4`, then `:6`")).toBe("`a.ts:1` then `b.go:4`, then `b.go:6`");
  expect(expandCites("`:5` alone, `L2` and `x:3` stay")).toBe("`:5` alone, `L2` and `x:3` stay");
});

test("findFile resolves exact and unique suffix paths", () => {
  expect(findFile(files, "src/auth/types.ts")?.path).toBe("src/auth/types.ts");
  expect(findFile(files, "session.ts")?.path).toBe("src/auth/session.ts");
  expect(findFile(files, "auth/session.ts")?.path).toBe("src/auth/session.ts");
  expect(findFile(files, "nope.ts")).toBeNull();
  expect(findFile(files, "ssion.ts")).toBeNull(); // suffix must start at a path segment
});

test("resolveLoc maps lines in the diff to row keys; lines outside resolve to null", () => {
  const idx = indexFiles(files);
  const r = resolveLoc({ file: "types.ts", start: 2, end: 2, side: "new" }, files, idx)!;
  expect(r.file).toBe("src/auth/types.ts");
  expect(r.keys).toEqual(["src/auth/types.ts:2"]);
  expect(r.files).toEqual(["src/auth/types.ts"]);
  expect(resolveLoc({ file: "types.ts", start: 400, end: 410, side: "new" }, files, idx)).toBeNull();
  expect(resolveLoc({ file: "README.md", start: 1, end: 1, side: "new" }, files, idx)).toBeNull();
});

test("a range spanning a deletion includes the deleted row; old-side locations resolve by old numbers", () => {
  const idx = indexFiles(files);
  expect(resolveLoc({ file: "session.ts", start: 5, end: 7, side: "new" }, files, idx)!.keys).toEqual([
    "src/auth/session.ts:5",
    "src/auth/session.ts:5.5",
    "src/auth/session.ts:6",
    "src/auth/session.ts:7",
  ]);
  expect(resolveLoc({ file: "session.ts", start: 4, end: 4, side: "old" }, files, idx)!.keys).toEqual([
    "src/auth/session.ts:5.5",
  ]);
});
