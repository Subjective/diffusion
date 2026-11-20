import { ChevronDown, ChevronRight, FileDiff as FileDiffIcon, Folder, FolderTree, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { startResize } from "../lib/panes";
import { storage } from "../lib/storage";
import { tip } from "../lib/tips";
import { cachedTree } from "../lib/tree";
import { useApp } from "../store";
import type { FileDiff as FD } from "../types";
import { useUI } from "../ui";
import { Counts } from "./Counts";
import { ic } from "./icons";

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

interface Props {
  /** The changed files, in the diff's order. */
  files: FD[];
  /** Guide order lists the changed files as the diff runs, under a folder row wherever the folder changes; file order is the tree. */
  order: "guide" | "alpha";
  skip: Set<string>;
  fileSteps: Map<string, number[]>;
  /** The file in view: the diff's, or the open tab's. */
  current: string | null;
  /** A changed file was picked: show it in the diff. */
  onPick(path: string): void;
}

/** A directory: its name may join a chain of single-folder parents (`src/tools`), as editors compact them. */
export interface Dir {
  name: string;
  path: string;
  dirs: Dir[];
  files: string[];
}

/** Paths as a tree, folders before files, A–Z, single-child folder chains joined into one row. */
export function buildTree(paths: string[]): Dir {
  const root: Dir = { name: "", path: "", dirs: [], files: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let d = root;
    for (const part of parts.slice(0, -1)) {
      const path = d.path ? `${d.path}/${part}` : part;
      let next = d.dirs.find((x) => x.name === part);
      if (!next) {
        next = { name: part, path, dirs: [], files: [] };
        d.dirs.push(next);
      }
      d = next;
    }
    d.files.push(p);
  }
  const tidy = (d: Dir): Dir => {
    let dirs = d.dirs.map(tidy).sort((a, b) => a.name.localeCompare(b.name));
    dirs = dirs.map((c) =>
      c.files.length === 0 && c.dirs.length === 1 ? { ...c.dirs[0], name: `${c.name}/${c.dirs[0].name}` } : c,
    );
    return { ...d, dirs, files: [...d.files].sort((a, b) => a.localeCompare(b)) };
  };
  return tidy(root);
}

export const RAIL_W = 240;
const clampRail = (w: number) => Math.round(Math.max(160, Math.min(w, 560)));
/** Paths in the order the tree shows them: folders before files, A–Z. */
export function treeOrder(paths: string[]): string[] {
  const out: string[] = [];
  const walk = (d: Dir) => {
    for (const c of d.dirs) walk(c);
    out.push(...d.files);
  };
  walk(buildTree(paths));
  return out;
}

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));

/** A folder row's path split into the part it shares with the folder above (shown faint) and the rest. */
export function splitDir(dir: string, prev: string | null): [string, string] {
  const a = prev ? prev.split("/") : [];
  const b = dir.split("/");
  let k = 0;
  while (k < a.length && k < b.length - 1 && a[k] === b[k]) k++;
  return k ? [`${b.slice(0, k).join("/")}/`, b.slice(k).join("/")] : ["", dir];
}

/** The changed files, or every file at the head, as a tree that follows the file in view. Folders holding changes
 *  start open, the rest folded. A changed file opens in the diff (⌘-click: a tab); any other opens in a tab. */
export function FileRail({ files, order, skip, fileSteps, current, onPick }: Props) {
  const url = useApp((s) => s.pr?.url ?? s.url);
  const viewed = useUI((s) => s.viewed);
  const hideSkip = useUI((s) => s.hideSkip);
  const mode = useUI((s) => s.railMode);
  const hoverRows = useUI((s) => s.hoverRows);
  const hoverStep = useUI((s) => s.hoverStep);
  const nav = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [width, setWidth] = useState(() => clampRail(storage.get("rv-rail-w", RAIL_W)));
  const [all, setAll] = useState<string[] | null>(null);
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  // The files the hovered step, substep or ref touches (row keys are `file:pos`).
  const lit = useMemo(() => new Set([...hoverRows].map((k) => k.slice(0, k.lastIndexOf(":")))), [hoverRows]);

  useEffect(() => {
    if (mode !== "all") return;
    let live = true;
    void cachedTree(url).then((t) => live && setAll(t));
    return () => {
      live = false;
    };
  }, [mode, url]);

  // ⌘P (Ctrl+P off a Mac, where ⌃P moves up lists): find a file, unless something focused took the key first (⌃P moves up an open composer menu).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((MAC ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "p" && !e.shiftKey) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const needle = q.trim().toLowerCase();
  const root = useMemo(() => {
    let paths = mode === "all" && all ? [...new Set([...all, ...files.map((f) => f.path)])] : files.map((f) => f.path);
    if (mode === "diff" && hideSkip) paths = paths.filter((p) => !skip.has(p));
    if (needle) paths = paths.filter((p) => p.toLowerCase().includes(needle));
    return buildTree(paths);
  }, [mode, all, files, hideSkip, skip, needle]);

  const flat = useMemo(() => {
    if (mode !== "diff" || order !== "guide") return null;
    return files
      .map((f) => f.path)
      .filter((p) => !(hideSkip && skip.has(p)) && (!needle || p.toLowerCase().includes(needle)));
  }, [mode, order, files, hideSkip, skip, needle]);

  const changedDirs = useMemo(() => {
    const s = new Set<string>();
    for (const f of files) {
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join("/"));
    }
    return s;
  }, [files]);
  // A joined row (`src/tools`) counts as holding changes if its last folder does.
  const isOpen = (d: Dir) => (needle ? true : (toggled.get(d.path) ?? (mode === "diff" || changedDirs.has(d.path))));
  const toggle = (d: Dir) => setToggled((m) => new Map(m).set(d.path, !isOpen(d)));

  useEffect(() => {
    if (!current) return;
    nav.current?.querySelector(`[data-path="${CSS.escape(current)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const open = (path: string, e: React.MouseEvent) => {
    const tab = e.metaKey || e.ctrlKey;
    if (byPath.has(path) && !tab) {
      useUI.getState().showTab(null);
      onPick(path);
    } else useUI.getState().openFile(path, undefined, tab);
  };

  const fileRow = (p: string, indent: number) => {
    const f = byPath.get(p);
    const cls = [
      "rail-f",
      p === current && "on",
      lit.has(p) && "lit",
      f && viewed[p] && "viewed",
      f && skip.has(p) && "skip",
      f?.status === "deleted" && "gone",
      f?.status === "added" && "new",
      !f && "plain",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <button
        key={p}
        type="button"
        className={cls}
        style={{ paddingLeft: indent }}
        data-path={p}
        title={p}
        onClick={(e) => open(p, e)}
        onDoubleClick={() => !f && useUI.getState().pinTab(p)}
      >
        <span className="nm">
          <Hit text={base(p)} q={needle} />
        </span>
        {f && (
          <>
            <span className="grow" />
            {(fileSteps.get(p) ?? []).map((s) => (
              <span key={s} className={`dot sm${s === hoverStep && lit.has(p) ? " on" : ""}`} data-step={s}>
                {s}
              </span>
            ))}
            <Counts file={f} />
          </>
        )}
      </button>
    );
  };

  const rows: React.ReactNode[] = [];
  const walk = (d: Dir, depth: number) => {
    for (const c of d.dirs) {
      const shut = !isOpen(c);
      const holds = !!current && current.startsWith(`${c.path}/`);
      const holdsLit = shut && [...lit].some((p) => p.startsWith(`${c.path}/`));
      rows.push(
        <button
          key={`d:${c.path}`}
          type="button"
          className={`rail-dir${shut && holds ? " on" : ""}${holdsLit ? " lit" : ""}`}
          style={{ paddingLeft: 6 + depth * 12 }}
          title={c.path}
          aria-expanded={!shut}
          onClick={() => toggle(c)}
        >
          <span className="tw">{ic(shut ? ChevronRight : ChevronDown, 13)}</span>
          <span className="nm">{c.name}</span>
          {shut && changedDirs.has(c.path) && mode === "all" && <span className="fd" title="Holds changes" />}
        </button>,
      );
      if (!shut) walk(c, depth + 1);
    }
    for (const p of d.files) rows.push(fileRow(p, 6 + depth * 12 + 17));
  };
  if (flat) {
    // Skippable files trail the guide's; a rule marks where they start. A folder row heads each run of files in
    // one folder, so a folder the guide comes back to shows again as one row, never as a second tree.
    let tail = flat.length;
    while (tail > 0 && skip.has(flat[tail - 1])) tail--;
    let prev: string | null = null;
    flat.forEach((p, n) => {
      if (n === tail && n > 0) {
        rows.push(<div key="skip-rule" className="rail-rule" />);
        prev = null;
      }
      const d = dirOf(p);
      if (d && d !== prev) {
        const [same, rest] = splitDir(d, prev);
        rows.push(
          <div key={`h:${n}`} className="rail-run" title={d}>
            {ic(Folder, 12)}
            <span className="nm">
              <bdi>
                {same && <span className="same">{same}</span>}
                {rest}
              </bdi>
            </span>
          </div>,
        );
      }
      prev = d;
      rows.push(fileRow(p, d ? 26 : 8));
    });
  } else walk(root, 0);

  return (
    <div className="rail-wrap" style={{ width }}>
      <nav className="rail" ref={nav} aria-label="Files">
        <div className="rail-h">
          <label className="rail-q">
            {ic(Search, 13)}
            <input
              ref={input}
              value={q}
              placeholder="Filter"
              spellCheck={false}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") q ? setQ("") : e.currentTarget.blur();
                if (e.key === "Enter") {
                  const first = nav.current?.querySelector<HTMLElement>(".rail-f");
                  first?.click();
                }
              }}
            />
            {q && (
              <button type="button" className="clr" {...tip("Clear")} onClick={() => setQ("")}>
                {ic(X, 12)}
              </button>
            )}
          </label>
          <div className="seg">
            <button
              type="button"
              className={`icon-btn sm${mode === "diff" ? " on" : ""}`}
              {...tip("Changed files")}
              onClick={() => useUI.getState().setRailMode("diff")}
            >
              {ic(FileDiffIcon, 14)}
            </button>
            <button
              type="button"
              className={`icon-btn sm${mode === "all" ? " on" : ""}`}
              {...tip("All files")}
              onClick={() => useUI.getState().setRailMode("all")}
            >
              {ic(FolderTree, 14)}
            </button>
          </div>
        </div>
        {rows.length ? rows : <div className="rail-none">{needle ? "No matches" : ""}</div>}
      </nav>
      <div
        className="resizer right"
        onDoubleClick={() => {
          setWidth(RAIL_W);
          storage.set("rv-rail-w", RAIL_W);
        }}
        onMouseDown={(e) => {
          const left = e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
          startResize(e, (x) => clampRail(x - left), setWidth, "rv-rail-w");
        }}
      />
    </div>
  );
}

function Hit({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** The file whose section is under the top of the scroller (just below its sticky header). */
export function fileInView(scroller: HTMLElement): string | null {
  const top = scroller.getBoundingClientRect().top + 48;
  let last: string | null = null;
  // The files' own list, not a search of the whole diff: this runs every frame while scrolling.
  for (const f of scroller.querySelector(".files")?.children ?? []) {
    if (!(f instanceof HTMLElement)) continue;
    if (!f.offsetParent) continue;
    last = f.dataset.path ?? null;
    if (f.getBoundingClientRect().bottom > top) return last;
  }
  return last;
}
