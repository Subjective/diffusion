import type { FileDiff } from "../types";

/** A file's added and removed lines, each only when there are some (a binary file has none). */
export function Counts({
  file,
  lines,
  cls = ["a", "d"],
}: {
  file: Pick<FileDiff, "additions" | "deletions">;
  /** Lines to count instead of the whole file's (part of a file). */
  lines?: [number, number];
  cls?: [string, string];
}) {
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
