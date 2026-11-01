import {
  Check,
  FileDiff,
  GitBranch,
  History,
  ListOrdered,
  Map as MapIcon,
  Moon,
  PanelRight,
  Route,
  Sun,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ago } from "../lib/time";
import { useApp } from "../store";
import { useUI } from "../ui";
import { GithubIcon, ic } from "./icons";

export function TopBar() {
  const { theme, toggleTheme, chatOpen, toggleChat } = useApp();
  return (
    <header className="top">
      <div className="brand">{ic(Route, 16)}</div>
      <Target />
      <div className="top-r">
        <ModeToggle />
        <Versions />
        <button type="button" className="icon-btn" title="Theme" onClick={toggleTheme}>
          {ic(theme === "dark" ? Sun : Moon, 17)}
        </button>
        <DiffToggle />
        <button type="button" className={`icon-btn${chatOpen ? " on" : ""}`} title="Chat" onClick={() => toggleChat()}>
          {ic(PanelRight, 16)}
        </button>
      </div>
    </header>
  );
}

/** Steps or map in the left pane; shown once the guide has a view to map. */
function ModeToggle() {
  const hasMap = useApp((s) => !!s.guide?.views?.length);
  const { mode, setMode } = useUI();
  if (!hasMap) return null;
  return (
    <div className="seg">
      <button
        type="button"
        className={`icon-btn${mode !== "map" ? " on" : ""}`}
        title="Steps"
        aria-pressed={mode !== "map"}
        onClick={() => setMode("guide")}
      >
        {ic(ListOrdered, 16)}
      </button>
      <button
        type="button"
        className={`icon-btn${mode === "map" ? " on" : ""}`}
        title="Map"
        aria-pressed={mode === "map"}
        onClick={() => setMode("map")}
      >
        {ic(MapIcon, 16)}
      </button>
    </div>
  );
}

/** On the map, the diff is a pane like the chat: closed until a box is clicked, toggled here. */
function DiffToggle() {
  const hasMap = useApp((s) => !!s.guide?.views?.length);
  const { mode, codeOpen, openCode } = useUI();
  if (!hasMap || mode !== "map") return null;
  return (
    <button
      type="button"
      className={`icon-btn${codeOpen ? " on" : ""}`}
      title="Diff"
      onClick={() => openCode(!codeOpen)}
    >
      {ic(FileDiff, 16)}
    </button>
  );
}

/** What's under review: the PR (linking out), or the local repository and branch. */
function Target() {
  const pr = useApp((s) => s.pr);
  if (!pr) return <div className="target" />;
  return (
    <div className="target">
      {pr.local ? (
        <span title={pr.url}>
          {ic(GitBranch, 15)}
          <b>{localName(pr.url)}</b>
          <span className="target-ref">{pr.head_ref}</span>
        </span>
      ) : (
        <a href={pr.url} target="_blank" rel="noreferrer" title={pr.url}>
          <GithubIcon size={15} />
          <b>
            {pr.owner}/{pr.repo}
          </b>
          <span className="target-ref">#{pr.number}</span>
        </a>
      )}
    </div>
  );
}

/** `local:/path/to/repo#base..head` → `repo`. */
export const localName = (target: string) =>
  target
    .replace(/^local:/, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "")
    .split("/")
    .pop() || target;

/** Earlier versions of the guide (each submit, and each edit from chat); shown once there is more than one. */
function Versions() {
  const { versions, guide, showVersion } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", close);
    };
  }, [open]);
  if (versions.length < 2) return null;
  const current = guide?.version;
  return (
    <div className="versions" ref={ref}>
      <button
        type="button"
        className={`icon-btn ver-btn${open ? " on" : ""}`}
        title="Guide versions"
        onClick={() => setOpen(!open)}
      >
        {ic(History, 16)}
        <span>v{current}</span>
      </button>
      {open && (
        <div className="ver-menu" role="menu">
          {[...versions].reverse().map((v) => (
            <button
              type="button"
              key={v.version}
              role="menuitem"
              className={`h-item${v.version === current ? " active" : ""}`}
              onClick={() => {
                setOpen(false);
                void showVersion(v.version);
              }}
            >
              <div className="h-t">
                <span className="ver-n">v{v.version}</span>
                {v.label || (v.source === "chat" ? "Edited in chat" : "Guide")}
                {v.version === current && ic(Check, 13)}
              </div>
              <div className="h-m">
                <span>{v.source === "chat" ? "chat" : "agent"}</span>
                {v.scope?.files.length ? (
                  <span title={v.scope.files.join("\n")}>{v.scope.note || "scoped"}</span>
                ) : null}
                <span className="grow" />
                {v.created_at != null && <span>{ago(v.created_at)}</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
