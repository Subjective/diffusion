import { FileCode, GitCompare, LoaderCircle, Pin, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { highlightLines, type LineTokens, langFor } from "../lib/highlight";
import { rowKey } from "../lib/refs";
import { loadFile } from "../lib/useFileLines";
import { useApp } from "../store";
import { useUI } from "../ui";
import { DiffRow, type Dot } from "./FileDiff";
import { ic } from "./icons";

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The diff, then a tab per open file. The preview tab (italic) gives way to the next file opened; double-click pins. */
export function TabBar() {
  const tabs = useUI((s) => s.tabs);
  const tab = useUI((s) => s.tab);
  const files = useApp((s) => s.files);
  const { showTab, closeTab, pinTab } = useUI.getState();
  return (
    <div className="tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={tab == null}
        className={`tab${tab == null ? " on" : ""}`}
        title={`Diff · ${files.length} ${files.length === 1 ? "file" : "files"}`}
        onClick={() => showTab(null)}
      >
        {ic(GitCompare, 14)}
        <span className="nm">Diff</span>
      </button>
      {tabs.map((t) => (
        <div
          key={t.path}
          className={`tab${tab === t.path ? " on" : ""}${t.pinned ? "" : " preview"}`}
          data-path={t.path}
          onAuxClick={(e) => e.button === 1 && closeTab(t.path)}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === t.path}
            className="tab-b"
            title={t.pinned ? t.path : `${t.path} · double-click to keep open`}
            onClick={() => showTab(t.path)}
            onDoubleClick={() => pinTab(t.path)}
          >
            {ic(FileCode, 14)}
            <span className="nm">{base(t.path)}</span>
          </button>
          <button type="button" className="x" title="Close" onClick={() => closeTab(t.path)}>
            {ic(X, 12)}
          </button>
        </div>
      ))}
    </div>
  );
}

interface Marks {
  added: Set<number>;
  /** New-side lines with deletions just above them. */
  cuts: Set<number>;
}

/** A whole file at the head, opened from the navigator or go-to-definition. In a changed file, added lines are
 *  tinted and a notch marks each deletion. Rows are the diff's own, so hover, ⌘-click and Ask work the same. */
export function FileView({
  path,
  dots,
  onNav,
  onShowInDiff,
}: {
  path: string;
  dots: Map<string, Dot[]>;
  onNav: (e: React.MouseEvent) => void;
  onShowInDiff: (path: string) => void;
}) {
  const url = useApp((s) => s.pr?.url ?? s.url);
  const fd = useApp((s) => s.files.find((f) => f.path === path));
  const pinned = useUI((s) => s.tabs.find((t) => t.path === path)?.pinned ?? true);
  const at = useUI((s) => (s.fileAt?.path === path ? s.fileAt : null));
  const [lines, setLines] = useState<string[] | null>(null);
  const [tokens, setTokens] = useState<LineTokens[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setLines(null);
    setTokens([]);
    setError(null);
    loadFile(url, path).then(
      async (ls) => {
        if (!live) return;
        setLines(ls);
        const lang = langFor(path);
        if (!lang) return;
        const t = await highlightLines(ls, lang).catch(() => []);
        if (live) setTokens(t);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [url, path]);

  const marks: Marks = useMemo(() => {
    const added = new Set<number>();
    const cuts = new Set<number>();
    for (const h of fd?.hunks ?? []) {
      let cut = false;
      let last = h.new_start - 1;
      for (const l of h.lines) {
        if (l.type === "del") cut = true;
        else {
          last = l.new!;
          if (l.type === "add") added.add(last);
          if (cut) cuts.add(last);
          cut = false;
        }
      }
      if (cut) cuts.add(last + 1);
    }
    return { added, cuts };
  }, [fd]);

  // Go to the lines asked for, once they've rendered, and flash them.
  useEffect(() => {
    if (!at || !lines) return;
    const keys: string[] = [];
    for (let n = at.line; n <= Math.min(at.end, lines.length); n++) keys.push(`f:${rowKey(path, n)}`);
    const row = scroller.current?.querySelector<HTMLElement>(`tr[data-rk="${CSS.escape(keys[0] ?? "")}"]`);
    row?.scrollIntoView({ block: "center" });
    useUI.setState((s) => ({ flash: { keys: new Set(keys), n: s.flash.n + 1 } }));
  }, [at, lines, path]);

  const slash = path.lastIndexOf("/") + 1;
  return (
    <div className="diffwrap fileview">
      <div className="file-scroll" ref={scroller} onClickCapture={onNav}>
        <div className="files">
          <div className="file" data-path={path}>
            <div className="file-h">
              {ic(FileCode, 15)}
              <span className="path" title={path}>
                <span className="dir">{path.slice(0, slash)}</span>
                {path.slice(slash)}
              </span>
              {fd && (
                <span className="cnt">
                  <span className="a">+{fd.additions}</span> <span className="d">−{fd.deletions}</span>
                </span>
              )}
              <span className="grow" />
              {fd && (
                <button
                  type="button"
                  className="icon-btn sm"
                  title="Show in the diff"
                  onClick={() => onShowInDiff(path)}
                >
                  {ic(GitCompare, 15)}
                </button>
              )}
              {!pinned && (
                <button
                  type="button"
                  className="icon-btn sm"
                  title="Keep this tab open"
                  onClick={() => useUI.getState().pinTab(path)}
                >
                  {ic(Pin, 15)}
                </button>
              )}
            </div>
            {lines ? (
              <table className="diff">
                <tbody>
                  {lines.map((text, i) => {
                    const n = i + 1;
                    return (
                      <DiffRow
                        key={n}
                        rk={`f:${rowKey(path, n)}`}
                        type={marks.added.has(n) ? "add" : "ctx"}
                        old={null}
                        nw={n}
                        text={text}
                        tokens={tokens[i]}
                        dots={dots.get(rowKey(path, n))}
                        file={path}
                        pos={n}
                        cut={marks.cuts.has(n)}
                      />
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="file-note">{error ?? <span className="spin">{ic(LoaderCircle, 15)}</span>}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
