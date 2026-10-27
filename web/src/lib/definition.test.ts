import { wordAt } from "./definition";

test("wordAt finds the identifier around an offset", () => {
  const s = "const idx = useMemo(() => indexFiles(files));";
  expect(wordAt(s, s.indexOf("indexFiles") + 3)).toBe("indexFiles");
  expect(wordAt(s, s.indexOf("indexFiles"))).toBe("indexFiles");
  expect(wordAt(s, s.indexOf("(files") + 6)).toBe("files");
  expect(wordAt("$store.x", 1)).toBe("$store");
  expect(wordAt("a + 12", 5)).toBeNull();
  expect(wordAt("a  b", 2)).toBeNull();
});
