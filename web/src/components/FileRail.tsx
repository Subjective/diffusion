import { FolderClosed } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { FileDiff as FD } from "../types";
import { useUI } from "../ui";
import { ic } from "./icons";

interface Props {
  files: FD[];
  skip: Set<string>;
  fileSteps: Map<string, number[]>;
  current: string | null;
  onPick(path: string): void;
}

/** Changed files grouped by directory, A–Z. The file in view is highlighted and kept in sight. */
export function FileRail({ files, skip, fileSteps, current, onPick }: Props) {
  const viewed = useUI((s) => s.viewed);
  const hideSkip = useUI((s) => s.hideSkip);
  const nav = useRef<HTMLElement>(null);

  const groups = useMemo(() => {
    const by = new Map<string, FD[]>();
    for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      if (hideSkip && skip.has(f.path)) continue;
      const dir = f.path.slice(0, f.path.lastIndexOf("/") + 1);
      by.set(dir, [...(by.get(dir) ?? []), f]);
    }
    return [...by].sort((a, b) => a[0].localeCompare(b[0]));
  }, [files, skip, hideSkip]);

  useEffect(() => {
    if (!current) return;
    nav.current?.querySelector(`[data-path="${CSS.escape(current)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <nav className="rail" ref={nav} aria-label="Files">
      {groups.map(([dir, fs]) => (
        <div key={dir} className="rail-g">
          {dir && (
            <div className="rail-dir" title={dir}>
              {ic(FolderClosed, 13)}
              <span>{dir}</span>
            </div>
          )}
          {fs.map((f) => {
            const cls = [
              "rail-f",
              f.path === current && "on",
              viewed[f.path] && "viewed",
              skip.has(f.path) && "skip",
              dir && "nested",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={f.path}
                type="button"
                className={cls}
                data-path={f.path}
                title={f.path}
                onClick={() => onPick(f.path)}
              >
                <span className="nm">{f.path.slice(dir.length)}</span>
                <span className="grow" />
                {(fileSteps.get(f.path) ?? []).map((s) => (
                  <span key={s} className="dot sm" data-step={s}>
                    {s}
                  </span>
                ))}
                <span className="cnt">
                  <span className="a">+{f.additions}</span> <span className="d">−{f.deletions}</span>
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** The file whose section is under the top of the scroller (just below its sticky header). */
export function fileInView(scroller: HTMLElement): string | null {
  const top = scroller.getBoundingClientRect().top + 48;
  let last: string | null = null;
  for (const f of scroller.querySelectorAll<HTMLElement>(".file")) {
    if (!f.offsetParent) continue;
    last = f.dataset.path ?? null;
    if (f.getBoundingClientRect().bottom > top) return last;
  }
  return last;
}
