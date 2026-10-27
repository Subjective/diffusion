// The full text of a changed file at the PR head, fetched the first time a gap is expanded and kept per session.
import { useCallback, useEffect, useState } from "react";
import { fetchFile } from "../api";
import { useApp } from "../store";
import { splitLines } from "./expand";
import { highlightLines, type LineTokens } from "./highlight";

export interface FileLines {
  lines: string[];
  tokens: LineTokens[];
}

const cache = new Map<string, Promise<string[]>>();

function load(url: string, path: string): Promise<string[]> {
  const k = `${url}\n${path}`;
  let p = cache.get(k);
  if (!p) {
    p = fetchFile(url, path).then(splitLines);
    p.catch(() => cache.delete(k));
    cache.set(k, p);
  }
  return p;
}

/** `request()` starts the fetch; `file` is null until it lands, `error` set if it failed. */
export function useFileLines(path: string, lang: string | null) {
  const url = useApp((s) => s.pr?.url ?? s.url);
  const [wanted, setWanted] = useState(false);
  const [file, setFile] = useState<FileLines | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!wanted) return;
    let live = true;
    load(url, path).then(
      async (lines) => {
        if (!live) return;
        setFile({ lines, tokens: [] });
        if (!lang) return;
        const tokens = await highlightLines(lines, lang).catch(() => []);
        if (live) setFile({ lines, tokens });
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [wanted, url, path, lang]);

  const request = useCallback(() => setWanted(true), []);
  return { file, error, request };
}
