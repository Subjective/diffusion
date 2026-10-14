// Syntax highlighting with Shiki's CSS-variables theme, so colours follow the wireframe's light/dark tokens.
// Each hunk side (old/new) is tokenized as one block so multi-line constructs highlight correctly.
import { createCssVariablesTheme, createHighlighter, type Highlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { Hunk } from "../types";

export interface Token {
  content: string;
  color?: string;
}
export type LineTokens = Token[];

const theme = createCssVariablesTheme({ name: "rv", variablePrefix: "--shiki-", variableDefaults: {}, fontStyle: true });

const EXT: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", scala: "scala",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", rb: "ruby", php: "php", swift: "swift",
  sh: "bash", bash: "bash", zsh: "bash", sql: "sql", json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  md: "markdown", html: "html", css: "css", scss: "scss", proto: "proto", tf: "hcl", hcl: "hcl", xml: "xml",
  dockerfile: "docker", makefile: "make", lua: "lua", r: "r", jl: "julia", vue: "vue", svelte: "svelte",
};  // prettier-ignore

export function langFor(path: string): string | null {
  const name = path.split("/").pop()!.toLowerCase();
  if (name === "dockerfile") return "docker";
  if (name === "makefile") return "make";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return EXT[ext] ?? null;
}

let hl: Promise<Highlighter> | null = null;
const loaded = new Set<string>();

function highlighter(): Promise<Highlighter> {
  hl ??= createHighlighter({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
  return hl;
}

async function tokenize(code: string, lang: string): Promise<LineTokens[]> {
  const h = await highlighter();
  if (!loaded.has(lang)) {
    await h.loadLanguage(lang as Parameters<Highlighter["loadLanguage"]>[0]);
    loaded.add(lang);
  }
  return h.codeToTokensBase(code, { lang: lang as never, theme }).map((line) =>
    line.map((t) => ({ content: t.content, color: t.color })),
  );
}

/** Tokens per hunk line index, keyed by `${hunk.id}:${i}`. Missing entries render as plain text. */
export async function highlightHunk(hunk: Hunk, lang: string): Promise<Map<number, LineTokens>> {
  const out = new Map<number, LineTokens>();
  const sides: Record<"old" | "new", number[]> = { old: [], new: [] };
  hunk.lines.forEach((ln, i) => {
    if (ln.type !== "add") sides.old.push(i);
    if (ln.type !== "del") sides.new.push(i);
  });
  for (const side of ["new", "old"] as const) {
    const idxs = sides[side];
    if (!idxs.length) continue;
    const toks = await tokenize(idxs.map((i) => hunk.lines[i].text).join("\n"), lang);
    idxs.forEach((lineIdx, k) => {
      if (!out.has(lineIdx) && toks[k]) out.set(lineIdx, toks[k]);
    });
  }
  return out;
}
