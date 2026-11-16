// Writing a review of a GitHub PR from the review page: what to focus on, which agent, and the run while it goes.
import { Check, ChevronDown, Copy, LoaderCircle, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { autosize } from "../lib/autosize";
import { usePopover } from "../lib/usePopover";
import { useGenerate } from "../review";
import { useApp } from "../store";
import type { GenerateJob } from "../types";
import { HarnessMark, harnessName, ic } from "./icons";

/** The agents that can write a review from here (the review skill comes from the reviewer's Claude Code plugin). */
const HARNESSES = ["claude-code"] as const;
const NONE: GenerateJob = { state: "none" };

export const reviewCommand = (url: string, focus = "") =>
  `/diffusion:review ${url} ${focus.split(/\s+/).join(" ")}`.trim();

/** The agent writing this PR's review, while there's no review yet to say whose it is. */
export function useGeneratingHarness(): string | null {
  const url = useApp((s) => (s.pr && !s.pr.local && !s.guide ? s.pr.url : null));
  const job = useGenerate((s) => (url ? s.jobs[url] : undefined));
  return job && job.state !== "none" ? HARNESSES[0] : null;
}

/** Polls the run while it goes; the guide shows up on its own when the agent submits it. */
export function useGenerateJob(url: string) {
  const job = useGenerate((s) => s.jobs[url]) ?? NONE;
  const running = job.state === "running";
  useEffect(() => {
    void useGenerate.getState().load(url);
    if (!running) return;
    const t = setInterval(() => void useGenerate.getState().load(url), 1500);
    return () => clearInterval(t);
  }, [url, running]);
  return job;
}

export function GenerateCard({ url }: { url: string }) {
  const job = useGenerateJob(url);
  const [focus, setFocus] = useState("");
  const [harness, setHarness] = useState<string>(HARNESSES[0]);
  if (job.state === "running") return <Writing url={url} job={job} />;
  const go = () => {
    useApp.getState().toggleChat(true);
    void useGenerate.getState().start(url, focus);
  };
  return (
    <div className="gen-card">
      <textarea
        rows={1}
        value={focus}
        placeholder="Anything to focus on?"
        onChange={(e) => {
          setFocus(e.target.value);
          autosize(e.target, 6);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            go();
          }
        }}
      />
      <div className="gen-f">
        <HarnessPicker harness={harness} onPick={setHarness} command={reviewCommand(url, focus)} />
        <button type="button" className="gen-go" onClick={go}>
          <HarnessMark harness={harness} size={14} />
          Generate
        </button>
      </div>
      {job.state === "failed" && job.error && <div className="write-err">{job.error}</div>}
    </div>
  );
}

/** Which agent writes it, and the command, to run it yourself instead. */
function HarnessPicker({
  harness,
  onPick,
  command,
}: {
  harness: string;
  onPick: (h: string) => void;
  command: string;
}) {
  const [open, setOpen, ref] = usePopover();
  const [copied, setCopied] = useState(false);
  return (
    <div className="pop-anchor" ref={ref}>
      <button type="button" className={`gen-h${open ? " on" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <HarnessMark harness={harness} size={14} />
        {harnessName(harness)}
        {ic(ChevronDown, 13)}
      </button>
      {open && (
        <div className="gen-menu" role="menu">
          {HARNESSES.map((h) => (
            <button
              key={h}
              type="button"
              role="menuitemradio"
              aria-checked={h === harness}
              onClick={() => {
                onPick(h);
                setOpen(false);
              }}
            >
              <HarnessMark harness={h} size={14} />
              <span className="grow">{harnessName(h)}</span>
              {h === harness && ic(Check, 14)}
            </button>
          ))}
          <div className="gen-sep" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void navigator.clipboard?.writeText(command);
              setCopied(true);
              setTimeout(() => {
                setCopied(false);
                setOpen(false);
              }, 900);
            }}
          >
            {ic(copied ? Check : Copy, 14)}
            <span className="grow">{copied ? "Copied" : "Copy command"}</span>
          </button>
        </div>
      )}
    </div>
  );
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The run: how long it's been going, and a way to stop it. Its steps show in the chat. */
function Writing({ url, job }: { url: string; job: GenerateJob }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  const since = Math.max(0, now - (job.started_at ?? now));
  return (
    <div className="gen-card writing">
      <div className="gen-w">
        <span className="spin">{ic(LoaderCircle, 15)}</span>
        <span className="grow">Writing</span>
        <span className="gen-clock">{clock(since)}</span>
        <button
          type="button"
          className="icon-btn sm"
          data-tip="Stop"
          onClick={() => void useGenerate.getState().stop(url)}
        >
          {ic(Square, 13)}
        </button>
      </div>
      <div className="gen-bar" />
    </div>
  );
}
