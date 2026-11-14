import { FileCode, LoaderCircle, SquareArrowOutUpRight, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type DefinitionMatch, fetchAround, fetchDefinition, fetchReferences, type ReferenceMatch } from "../api";
import { backStack } from "../lib/definition";
import { highlightLines, type LineTokens, langFor } from "../lib/highlight";
import { rowKey } from "../lib/refs";
import { useApp } from "../store";
import { type Peek, useUI } from "../ui";
import { ic } from "./icons";

type Tab = "defs" | "refs";
/** A place in the list: a definition or a use. */
interface Hit {
  path: string;
  line: number;
  end: number;
  text: string;
  /** Added or changed by the PR. */
  changed: boolean;
}

const CONTEXT = 6;

/** Go to a result: in the diff if it shows the line (remembering where we were, for ⌘[), else in a file tab.
 *  `tab` always opens a tab, kept rather than a preview. */
function jump(h: Hit, tab = false) {
  const key = rowKey(h.path, h.line);
  const pane = document.querySelector<HTMLElement>(".diff-scroll");
  if (!tab && pane?.querySelector(`tr[data-rk="${CSS.escape(key)}"]`)) {
    backStack.push(pane.scrollTop);
    useUI.getState().setPeek(null);
    useUI.getState().focus([key], [h.path]);
    return;
  }
  useUI.getState().openFile(h.path, { line: h.line, end: h.end }, tab);
}
const cache = new Map<string, Promise<{ first: number; text: string }>>();
const aroundOf = (url: string, h: Hit) => {
  const k = `${url}\n${h.path}\n${h.line}\n${h.end}`;
  if (!cache.has(k)) cache.set(k, fetchAround(url, h.path, h.line, h.end));
  return cache.get(k)!;
};

/** The definitions and uses of a ⌘-clicked name, shown under its row. A lone definition already on screen in the
 *  diff is jumped to instead; ⌘-clicking a definition, or ⇧⌘-clicking any name, opens its uses. */
export function PeekRow({ peek }: { peek: Peek }) {
  const url = useApp((s) => s.pr?.url ?? s.url);
  const prFiles = useApp((s) => s.files);
  const [defs, setDefs] = useState<DefinitionMatch[] | null>(null);
  const [refs, setRefs] = useState<ReferenceMatch[] | null>(null);
  const [tab, setTab] = useState<Tab>(peek.refs ? "refs" : "defs");
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  // Stay hidden while the lookup is quick, so a jump to a definition already in the diff doesn't flash a popup.
  const [slow, setSlow] = useState(false);
  const close = () => useUI.getState().setPeek(null);
  const row = useRef<HTMLTableRowElement>(null);

  // Lines the PR adds, and the files it touches: uses there come first and are marked.
  const { added, touched } = useMemo(() => {
    const added = new Set<string>();
    for (const f of prFiles)
      for (const h of f.hunks) for (const l of h.lines) if (l.type === "add") added.add(rowKey(f.path, l.new!));
    return { added, touched: new Set(prFiles.map((f) => f.path)) };
  }, [prFiles]);

  useEffect(() => {
    let live = true;
    setDefs(null);
    setRefs(null);
    setError(null);
    setSel(0);
    setTab(peek.refs ? "refs" : "defs");
    setSlow(false);
    const t = setTimeout(() => live && setSlow(true), 300);
    fetchReferences(url, peek.symbol, peek.file).then(
      (rs) => live && setRefs(rs),
      () => live && setRefs([]),
    );
    fetchDefinition(url, peek.symbol, peek.file).then(
      (ms) => {
        if (!live) return;
        const keys = ms.map((m) => rowKey(m.path, m.line));
        // Clicked on the definition itself: show where it's used instead, as VS Code does.
        if (keys.includes(peek.rk)) setTab("refs");
        else if (ms.length === 1 && !peek.refs) {
          const pane = document.querySelector<HTMLElement>(".diff-scroll");
          // In the diff already: go there, and remember where we were.
          if (pane?.querySelector(`tr[data-rk="${CSS.escape(keys[0])}"]`)) {
            backStack.push(pane.scrollTop);
            useUI.getState().setPeek(null);
            useUI.getState().focus([keys[0]], [ms[0].path]);
            return;
          }
        }
        setDefs(ms);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [url, peek]);

  const hits: Hit[] | null = useMemo(() => {
    if (tab === "defs") return defs?.map((d) => ({ ...d, changed: added.has(rowKey(d.path, d.line)) })) ?? null;
    if (!refs) return null;
    const all = refs.map((r) => ({
      path: r.path,
      line: r.line,
      end: r.line,
      text: r.text,
      changed: added.has(rowKey(r.path, r.line)),
    }));
    // Files the PR touches first, keeping the server's nearest-first order otherwise.
    return [...all.filter((h) => touched.has(h.path)), ...all.filter((h) => !touched.has(h.path))];
  }, [tab, defs, refs, added, touched]);

  const show = (t: Tab) => {
    setTab(t);
    setSel(0);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useUI.getState().setPeek(null);
      if (!hits?.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => (s + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
      }
      if (e.key === "Enter" && hits[sel]) {
        e.preventDefault();
        jump(hits[sel], e.metaKey || e.ctrlKey);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [hits, sel]);

  // A name clicked near the bottom of the pane would open its peek out of sight; keep it in view as it grows.
  const phase = defs ? "found" : error ? "error" : slow ? "loading" : null;
  useEffect(() => {
    if (phase) row.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [phase]);

  if (!phase) return null;
  const h = hits?.[sel];
  const list = tab === "refs" || (hits?.length ?? 0) > 1;
  return (
    <tr className="peek-row" ref={row}>
      <td colSpan={4}>
        <div className="peek" role="dialog" aria-label={`${peek.symbol}`}>
          <div className="peek-h">
            {h ? (
              <>
                {ic(FileCode, 14)}
                <button
                  type="button"
                  className="path go"
                  title={`Go to ${h.path}:${h.line} (↵)`}
                  onClick={(e) => jump(h, e.metaKey || e.ctrlKey)}
                >
                  <span className="dir">{h.path.slice(0, h.path.lastIndexOf("/") + 1)}</span>
                  {h.path.slice(h.path.lastIndexOf("/") + 1)}
                </button>
                <span className="ln">{h.line}</span>
              </>
            ) : (
              <span className="sym">{peek.symbol}</span>
            )}
            <span className="grow" />
            <span className="peek-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "defs"}
                className={tab === "defs" ? "on" : undefined}
                onClick={() => show("defs")}
              >
                Definitions<span className="cnt">{defs?.length ?? ""}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "refs"}
                className={tab === "refs" ? "on" : undefined}
                onClick={() => show("refs")}
              >
                References<span className="cnt">{refs ? (refs.length >= 300 ? "300+" : refs.length) : ""}</span>
              </button>
            </span>
            {h && (
              <button type="button" className="icon-btn sm" title="Open in a tab (⌘↵)" onClick={() => jump(h, true)}>
                {ic(SquareArrowOutUpRight, 14)}
              </button>
            )}
            <button type="button" className="icon-btn sm" title="Close" onClick={close}>
              {ic(X, 14)}
            </button>
          </div>
          {h ? (
            <div className={list ? "peek-split" : undefined}>
              <PeekCode url={url} hit={h} symbol={peek.symbol} />
              {list && hits && <HitList hits={hits} sel={sel} symbol={peek.symbol} onPick={setSel} onJump={jump} />}
            </div>
          ) : (
            <div className="peek-note">
              {error ? (
                error
              ) : hits ? (
                tab === "defs" ? (
                  "No definition found"
                ) : (
                  "No references found"
                )
              ) : (
                <span className="spin">{ic(LoaderCircle, 14)}</span>
              )}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

/** Results grouped by file, like VS Code's peek. */
function HitList({
  hits,
  sel,
  symbol,
  onPick,
  onJump,
}: {
  hits: Hit[];
  sel: number;
  symbol: string;
  onPick: (i: number) => void;
  onJump: (h: Hit, tab?: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the selection
  useEffect(() => {
    ref.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  const groups: { path: string; items: [Hit, number][] }[] = [];
  hits.forEach((h, i) => {
    const g = groups.at(-1)?.path === h.path ? groups.at(-1)! : groups[groups.push({ path: h.path, items: [] }) - 1];
    g.items.push([h, i]);
  });
  return (
    <div className="peek-list" ref={ref}>
      {groups.map((g) => (
        <div key={g.path} className="grp">
          <div className="grp-h" title={g.path}>
            <span className="name">{g.path.slice(g.path.lastIndexOf("/") + 1)}</span>
            <span className="dir">{g.path.slice(0, g.path.lastIndexOf("/"))}</span>
            <span className="grow" />
            <span className="cnt">{g.items.length}</span>
          </div>
          {g.items.map(([h, i]) => (
            <button
              type="button"
              key={i}
              className={`hit${i === sel ? " on" : ""}`}
              onClick={() => onPick(i)}
              onDoubleClick={(e) => onJump(h, e.metaKey || e.ctrlKey)}
            >
              <span className="no">{h.line}</span>
              <span className="txt">
                <Marked text={h.text.split("\n")[0].trim()} symbol={symbol} />
              </span>
              {h.changed && <span className="chg" title="Changed in this PR" />}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function Marked({ text, symbol }: { text: string; symbol: string }) {
  const parts = text.split(new RegExp(`(?<![\\w$])(${symbol.replace(/\$/g, "\\$")})(?![\\w$])`));
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</>;
}

/** The selected result in its file, with a few lines either side. */
function PeekCode({ url, hit, symbol }: { url: string; hit: Hit; symbol: string }) {
  const [around, setAround] = useState<{ first: number; text: string } | null>(null);
  const [tokens, setTokens] = useState<LineTokens[]>([]);
  useEffect(() => {
    let live = true;
    setAround(null);
    aroundOf(url, hit).then(
      (r) => live && setAround(r),
      () => live && setAround({ first: hit.line, text: hit.text }),
    );
    return () => {
      live = false;
    };
  }, [url, hit]);
  const first = around?.first ?? hit.line;
  const lines = useMemo(() => (around?.text ?? hit.text).split("\n"), [around, hit.text]);
  useEffect(() => {
    const lang = langFor(hit.path);
    setTokens([]);
    if (!lang) return;
    let live = true;
    highlightLines(lines, lang).then(
      (t) => live && setTokens(t),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [hit.path, lines]);
  const body = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-center when the lines change
  useEffect(() => {
    const b = body.current;
    const at = b?.querySelector<HTMLElement>("tr.def");
    if (b && at) b.scrollTop = at.offsetTop - 20 * Math.min(CONTEXT, 3);
  }, [lines]);
  return (
    <div className="peek-b" ref={body}>
      <table>
        <tbody>
          {lines.map((text, k) => {
            const n = first + k;
            return (
              <tr key={n} className={n === hit.line ? "def" : undefined}>
                <td className="no">{n}</td>
                <td className="src">
                  {tokens[k] ? (
                    tokens[k].map((t, j) =>
                      t.color ? (
                        <span key={j} style={{ color: t.color }}>
                          {t.content}
                        </span>
                      ) : (
                        t.content
                      ),
                    )
                  ) : n === hit.line ? (
                    <Marked text={text} symbol={symbol} />
                  ) : (
                    text || " "
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
