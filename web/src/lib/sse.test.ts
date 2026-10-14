import { SSEParser } from "./sse";

test("parses events split across chunks", () => {
  const p = new SSEParser();
  expect(p.push('event: stage\ndata: {"stage":"fe')).toEqual([]);
  expect(p.push('tch"}\n\nevent: tool\ndata: {"name":"Grep"}\n\n')).toEqual([
    { event: "stage", data: { stage: "fetch" } },
    { event: "tool", data: { name: "Grep" } },
  ]);
});

test("handles CRLF, multi-line data, and non-JSON", () => {
  const p = new SSEParser();
  expect(p.push("data: a\r\ndata: b\r\n\r\n")).toEqual([{ event: "message", data: "a\nb" }]);
});

test("skips blocks without data", () => {
  expect(new SSEParser().push(": keepalive\n\n")).toEqual([]);
});
