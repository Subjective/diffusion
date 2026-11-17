import { Binary } from "lucide-react";
import type { FileDiff } from "../types";
import { ic } from "./icons";

/** A file's added and removed lines, each only when there are some; a binary file has no lines, so an icon says so. */
export function Counts({
  file,
  lines,
  cls = ["a", "d"],
}: {
  file: Pick<FileDiff, "binary" | "additions" | "deletions">;
  /** Lines to count instead of the whole file's (part of a file). */
  lines?: [number, number];
  cls?: [string, string];
}) {
  if (file.binary)
    return (
      <span className="cnt bin" data-tip="Binary">
        {ic(Binary, 13)}
      </span>
    );
  const [a, d] = lines ?? [file.additions, file.deletions];
  if (!a && !d) return null;
  return (
    <span className="cnt">
      {a > 0 && <span className={cls[0]}>+{a}</span>}
      {a > 0 && d > 0 && " "}
      {d > 0 && <span className={cls[1]}>−{d}</span>}
    </span>
  );
}
