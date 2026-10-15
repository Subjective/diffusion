import { ChevronDown, Circle, CircleCheck, FileCode, MessageCircle } from "lucide-react";
import { memo, type ReactNode, useEffect, useState } from "react";
import { highlightHunk, type LineTokens, langFor } from "../lib/highlight";
import { rowKey, rowsOfHunk } from "../lib/refs";
import type { FileDiff as FD, Hunk } from "../types";
import { useUI } from "../ui";
import { ic, SKIP_ICON } from "./icons";

export interface Dot {
  step: number;
  sub: number | null;
}

export interface Gutter {
  /** Step/substep dots by row key. */
  dots: Map<string, Dot[]>;
  /** Extra per-row content (question badges), by row key. */
  extras?: Map<string, ReactNode>;
}

interface Props {
  file: FD;
  steps: number[];
  gutter: Gutter;
}

export const FileDiff = memo(function FileDiff({ file, steps, gutter }: Props) {
  const collapsed = useUI((s) => !!s.collapsed[file.path]);
  const viewed = useUI((s) => !!s.viewed[file.path]);
  const toggleCollapsed = useUI((s) => s.toggleCollapsed);
  const toggleViewed = useUI((s) => s.toggleViewed);
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";
  const base = file.path.slice(dir.length);
  const Lead = file.skip ? SKIP_ICON[file.skip] : FileCode;

  return (
    <section className={`file${file.skip ? " skip" : ""}${collapsed ? " collapsed" : ""}`} data-path={file.path}>
      <div className="file-h" onClick={() => toggleCollapsed(file.path)}>
        <span className="chev">{ic(ChevronDown, 14)}</span>
        {ic(Lead, 14)}
        <span className="path" title={file.old_path ? `${file.old_path} → ${file.path}` : file.path}>
          <span className="dir">{dir}</span>
          {base}
        </span>
        <span className="cnt">
          <span className="a">+{file.additions}</span> <span className="d">−{file.deletions}</span>
        </span>
        <span className="badges">
          {steps.map((s) => (
            <span key={s} className="dot sm" data-step={s}>
              {s}
            </span>
          ))}
        </span>
        <span className="grow" />
        <button
          className={`icon-btn sm viewed${viewed ? " on" : ""}`}
          title="Viewed"
          onClick={(e) => {
            e.stopPropagation();
            toggleViewed(file.path);
          }}
        >
          {ic(viewed ? CircleCheck : Circle, 15)}
        </button>
      </div>
      {!collapsed && (
        <div className="file-b">
          {file.binary ? (
            <div className="file-note">Binary file</div>
          ) : !file.hunks.length ? (
            <div className="file-note">
              {file.status === "renamed" ? `Renamed from ${file.old_path}` : "No changes"}
            </div>
          ) : (
            <table className="diff">
              <tbody>
                {file.hunks.map((h) => (
                  <HunkRows key={h.id} hunk={h} lang={langFor(file.path)} gutter={gutter} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
});

function HunkRows({ hunk, lang, gutter }: { hunk: Hunk; lang: string | null; gutter: Gutter }) {
  const [tokens, setTokens] = useState<Map<number, LineTokens> | null>(null);
  useEffect(() => {
    if (!lang) return;
    let live = true;
    highlightHunk(hunk, lang).then(
      (t) => live && setTokens(t),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [hunk, lang]);

  const rows = rowsOfHunk(hunk);
  return (
    <>
      <tr className="hh" data-hunk={hunk.id}>
        <td colSpan={4}>
          @@ -{hunk.old_start},{hunk.old_len} +{hunk.new_start},{hunk.new_len} @@ <span>{hunk.symbol}</span>
        </td>
      </tr>
      {hunk.lines.map((ln, i) => {
        const r = rows[i];
        const key = rowKey(hunk.file, r.pos);
        return (
          <DiffRow
            key={i}
            rk={key}
            type={ln.type}
            old={ln.old}
            nw={ln.new}
            text={ln.text}
            tokens={tokens?.get(i)}
            dots={gutter.dots.get(key)}
            extra={gutter.extras?.get(key)}
            file={hunk.file}
            pos={r.pos}
          />
        );
      })}
    </>
  );
}

interface RowProps {
  rk: string;
  type: "add" | "del" | "ctx";
  old: number | null;
  nw: number | null;
  text: string;
  tokens?: LineTokens;
  dots?: Dot[];
  extra?: ReactNode;
  file: string;
  pos: number;
}

const DiffRow = memo(function DiffRow({ rk, type, old, nw, text, tokens, dots, extra, file, pos }: RowProps) {
  const hl = useUI((s) => s.hoverRows.has(rk));
  const pin = useUI((s) => s.pinRows.has(rk));
  const flashN = useUI((s) => (s.flash.keys.has(rk) ? s.flash.n : 0));
  const cls = ["ln", type, extra && "qd", hl && "hl", pin && "pin", flashN && `flash f${flashN % 2}`]
    .filter(Boolean)
    .join(" ");
  const sign = type === "add" ? "+" : type === "del" ? "−" : "";
  return (
    <tr
      className={cls}
      data-rk={rk}
      data-file={file}
      data-pos={pos}
      data-new={nw ?? undefined}
      data-old={old ?? undefined}
    >
      <td className="mark">
        {dots?.map((d) => (
          <span
            key={`${d.step}.${d.sub}`}
            className={`dot${d.sub != null ? " sub-dot" : ""}`}
            data-step={d.step}
            data-sub={d.sub ?? undefined}
            title={d.sub == null ? `Step ${d.step}` : `Step ${d.step}.${d.sub}`}
          >
            {d.sub == null ? d.step : `${d.step}.${d.sub}`}
          </span>
        ))}
      </td>
      <td className="no">{old ?? ""}</td>
      <td className="no">{nw ?? ""}</td>
      <td className="code">
        <button className="ask-btn" title="Click, or drag to select lines" tabIndex={-1}>
          {ic(MessageCircle, 12)}
        </button>
        <span className="sg">{sign}</span>
        <span className="src">
          {tokens
            ? tokens.map((t, i) =>
                t.color ? (
                  <span key={i} style={{ color: t.color }}>
                    {t.content}
                  </span>
                ) : (
                  t.content
                ),
              )
            : text || " "}
        </span>
        {extra}
      </td>
    </tr>
  );
});
