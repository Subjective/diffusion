import {
  ChevronDown,
  ChevronUp,
  Circle,
  CircleCheck,
  FileCode,
  FoldVertical,
  MessageCircle,
  UnfoldVertical,
} from "lucide-react";
import { Fragment, memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { type Gap, gapsOf, type Reveal, STEP, shownLines } from "../lib/expand";
import { highlightHunk, type LineTokens, langFor } from "../lib/highlight";
import { rowKey, rowsOfHunk } from "../lib/refs";
import { type FileLines, useFileLines } from "../lib/useFileLines";
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
  const lang = langFor(file.path);

  // Unchanged lines around hunks, fetched on first expand. `full` shows every gap in full.
  const expandable = !file.binary && file.status !== "deleted" && file.hunks.length > 0;
  const gaps = useMemo(() => gapsOf(file.hunks), [file.hunks]);
  const [reveal, setReveal] = useState<Record<number, Reveal>>({});
  const [full, setFull] = useState(false);
  const text = useFileLines(file.path, lang);
  const revealOf = (i: number): Reveal => (full ? ALL : (reveal[i] ?? NONE));
  const expand = (i: number, dir: Dir) => {
    text.request();
    setReveal((r) => {
      const cur = r[i] ?? NONE;
      const next =
        dir === "all" ? ALL : dir === "down" ? { ...cur, top: cur.top + STEP } : { ...cur, bottom: cur.bottom + STEP };
      return { ...r, [i]: next };
    });
  };
  const gapProps = (i: number) => ({
    gap: gaps[i],
    index: i,
    count: gaps.length,
    rev: revealOf(i),
    text: text.file,
    error: text.error,
    onExpand: expand,
    path: file.path,
    gutter,
  });
  const hasHidden = gaps.some((g) => g.end == null || g.end >= g.start);

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
        {expandable && hasHidden && (
          <button
            type="button"
            className={`icon-btn sm${full ? " on" : ""}`}
            title={full ? "Show changes only" : "Show full file"}
            onClick={(e) => {
              e.stopPropagation();
              if (full) setReveal({});
              else text.request();
              setFull(!full);
            }}
          >
            {ic(full ? FoldVertical : UnfoldVertical, 15)}
          </button>
        )}
        <button
          type="button"
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
                {file.hunks.map((h, i) => (
                  <Fragment key={h.id}>
                    {expandable ? <GapRows {...gapProps(i)} hunk={h} /> : <HunkHeader hunk={h} />}
                    <HunkRows hunk={h} lang={lang} gutter={gutter} />
                  </Fragment>
                ))}
                {expandable && <GapRows {...gapProps(gaps.length - 1)} />}
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

const NONE: Reveal = { top: 0, bottom: 0 };
const ALL: Reveal = { top: Number.POSITIVE_INFINITY, bottom: 0 };
type Dir = "up" | "down" | "all";

const headerText = (h: Hunk) => (
  <>
    @@ -{h.old_start},{h.old_len} +{h.new_start},{h.new_len} @@ <span>{h.symbol}</span>
  </>
);

function HunkHeader({ hunk }: { hunk: Hunk }) {
  return (
    <tr className="hh" data-hunk={hunk.id}>
      <td colSpan={4}>{headerText(hunk)}</td>
    </tr>
  );
}

interface GapProps {
  gap: Gap;
  index: number;
  count: number;
  rev: Reveal;
  text: FileLines | null;
  error: string | null;
  onExpand(i: number, dir: Dir): void;
  path: string;
  gutter: Gutter;
  /** The hunk after this gap; absent for the trailing gap. */
  hunk?: Hunk;
}

/** Revealed lines below the previous hunk, the expander (with the next hunk's header), then lines above the next hunk. */
function GapRows({ gap, index, count, rev, text, error, onExpand, path, gutter, hunk }: GapProps) {
  const shown = shownLines(gap, text ? rev : NONE, text?.lines.length ?? null);
  const lead = index === 0;
  const tail = index === count - 1;
  // Nothing hidden: hunks run together. A file's first hunk keeps its header for orientation.
  if (shown.hidden === 0 && gap.end != null && gap.end < gap.start)
    return lead && hunk ? <HunkHeader hunk={hunk} /> : null;

  const ctx = (n: number) => <ContextRow key={n} n={n} delta={gap.delta} path={path} text={text} gutter={gutter} />;
  const btn = (dir: Dir, icon: typeof ChevronUp, title: string) => (
    <button type="button" className="exp-btn" title={title} onClick={() => onExpand(index, dir)}>
      {ic(icon, 15)}
    </button>
  );
  const hidden = shown.hidden;
  const lines = hidden == null ? "" : ` (${hidden} line${hidden === 1 ? "" : "s"})`;
  return (
    <>
      {shown.top.map(ctx)}
      {hidden !== 0 && (
        <tr className="hh gap" data-hunk={hunk?.id}>
          <td colSpan={3} className="exp" title={error ?? undefined}>
            {error ? null : hidden != null && hidden <= STEP ? (
              btn("all", UnfoldVertical, `Show hidden lines${lines}`)
            ) : (
              <>
                {!lead && btn("down", ChevronDown, `Show ${STEP} more lines${lines}`)}
                {!tail && btn("up", ChevronUp, `Show ${STEP} more lines${lines}`)}
              </>
            )}
          </td>
          <td>{hunk && headerText(hunk)}</td>
        </tr>
      )}
      {shown.bottom.map(ctx)}
    </>
  );
}

function ContextRow({
  n,
  delta,
  path,
  text,
  gutter,
}: {
  n: number;
  delta: number;
  path: string;
  text: FileLines | null;
  gutter: Gutter;
}) {
  const key = rowKey(path, n);
  return (
    <DiffRow
      rk={key}
      type="ctx"
      old={n + delta}
      nw={n}
      text={text?.lines[n - 1] ?? ""}
      tokens={text?.tokens[n - 1]}
      dots={gutter.dots.get(key)}
      extra={gutter.extras?.get(key)}
      file={path}
      pos={n}
    />
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
        <button type="button" className="ask-btn" title="Click, or drag to select lines" tabIndex={-1}>
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
