import { ChevronLeft, ChevronRight, FileCode, LoaderCircle, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type DefinitionMatch, fetchDefinition } from "../api";
import { backStack } from "../lib/definition";
import { highlightLines, type LineTokens, langFor } from "../lib/highlight";
import { rowKey } from "../lib/refs";
import { useApp } from "../store";
import { type Peek, useUI } from "../ui";
import { ic } from "./icons";

/** The definition of a ⌘-clicked name, shown under its row. A definition already on screen in the diff is
 *  jumped to instead. */
export function PeekRow({ peek }: { peek: Peek }) {
  const url = useApp((s) => s.pr?.url ?? s.url);
  const [matches, setMatches] = useState<DefinitionMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [i, setI] = useState(0);
  const close = () => useUI.getState().setPeek(null);

  useEffect(() => {
    let live = true;
    fetchDefinition(url, peek.symbol, peek.file).then(
      (ms) => {
        if (!live) return;
        const first = ms[0];
        const key = first && rowKey(first.path, first.line);
        const pane = document.querySelector<HTMLElement>(".diff-scroll");
        // In the diff already: go there, and remember where we were.
        if (first && pane?.querySelector(`tr[data-rk="${CSS.escape(key)}"]`) && key !== peek.rk) {
          backStack.push(pane.scrollTop);
          useUI.getState().setPeek(null);
          useUI.getState().focus([key], [first.path]);
          return;
        }
        setMatches(ms);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [url, peek]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && useUI.getState().setPeek(null);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const m = matches?.[i];
  return (
    <tr className="peek-row">
      <td colSpan={4}>
        <div className="peek" role="dialog" aria-label={`Definition of ${peek.symbol}`}>
          <div className="peek-h">
            {m ? (
              <>
                {ic(FileCode, 14)}
                <span className="path" title={m.path}>
                  <span className="dir">{m.path.slice(0, m.path.lastIndexOf("/") + 1)}</span>
                  {m.path.slice(m.path.lastIndexOf("/") + 1)}
                </span>
                <span className="ln">{m.line}</span>
              </>
            ) : (
              <span className="sym">{peek.symbol}</span>
            )}
            <span className="grow" />
            {matches && matches.length > 1 && (
              <span className="peek-nav">
                <button
                  type="button"
                  className="icon-btn sm"
                  title="Previous"
                  onClick={() => setI((i + matches.length - 1) % matches.length)}
                >
                  {ic(ChevronLeft, 14)}
                </button>
                <span className="cnt">
                  {i + 1}/{matches.length}
                </span>
                <button
                  type="button"
                  className="icon-btn sm"
                  title="Next"
                  onClick={() => setI((i + 1) % matches.length)}
                >
                  {ic(ChevronRight, 14)}
                </button>
              </span>
            )}
            <button type="button" className="icon-btn sm" title="Close" onClick={close}>
              {ic(X, 14)}
            </button>
          </div>
          {m ? (
            <PeekCode match={m} />
          ) : (
            <div className="peek-note">
              {error ? error : matches ? "No definition found" : <span className="spin">{ic(LoaderCircle, 14)}</span>}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

function PeekCode({ match }: { match: DefinitionMatch }) {
  const lines = useMemo(() => match.text.split("\n"), [match.text]);
  const [tokens, setTokens] = useState<LineTokens[]>([]);
  useEffect(() => {
    const lang = langFor(match.path);
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
  }, [match.path, lines]);
  return (
    <div className="peek-b">
      <table>
        <tbody>
          {lines.map((text, k) => (
            <tr key={k} className={k === 0 ? "def" : undefined}>
              <td className="no">{match.line + k}</td>
              <td className="src">
                {tokens[k]
                  ? tokens[k].map((t, j) =>
                      t.color ? (
                        <span key={j} style={{ color: t.color }}>
                          {t.content}
                        </span>
                      ) : (
                        t.content
                      ),
                    )
                  : text || " "}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
