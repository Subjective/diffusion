import type { ToolActivity } from "../store";
import type { FileDiff } from "../types";

const base = (p: string) => p.split("/").pop() || p;

function filesFor(ids: string[], files: FileDiff[]): string[] {
  const want = new Set(ids);
  return files.filter((f) => f.hunks.some((h) => want.has(h.id))).map((f) => base(f.path));
}

/** One plain-language line for what the guide model is doing now, e.g. "Reading store.ts". */
export function describeActivity(tools: ToolActivity[], files: FileDiff[]): string {
  const t = tools.at(-1);
  if (!t) return "Reading the diff";
  const name = t.name.split("__").pop() ?? t.name;
  if (name === "submit_guide") return "Checking references";
  const [verb, ...rest] = t.summary.split(" ");
  const arg = rest.join(" ");
  if (verb === "Hunk") {
    const names = filesFor(arg.match(/H\d+/g) ?? [], files);
    if (!names.length) return "Reading the diff";
    return `Reading ${names[0]}${names.length > 1 ? ` and ${names.length - 1} more` : ""}`;
  }
  if (verb === "Read" && arg) return `Reading ${arg}`;
  if (verb === "Show" && arg) return `Reading ${arg.split(":")[0]}`;
  if (verb === "Grep" || verb === "Glob") return "Searching the code";
  return "Exploring the code";
}
