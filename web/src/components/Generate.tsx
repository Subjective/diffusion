// Writing a review of a GitHub PR from the review page: what to focus on, which agent, and the run while it goes.
import { Check, ChevronDown, Copy, LoaderCircle, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { useChat } from "../chat";
import { autosize } from "../lib/autosize";
import { tip } from "../lib/tips";
import { usePopover } from "../lib/usePopover";
import { useGenerate } from "../review";
import { useApp } from "../store";
import type { GenerateJob } from "../types";
import { HarnessMark, harnessName, ic } from "./icons";

const NONE: GenerateJob = { state: "none" };

/** The review skill as each agent's composer names it. */
export const reviewCommand = (url: string, focus = "", harness = "claude-code") =>
  `${harness === "codex" ? "$" : "/"}diffusion:review ${url} ${focus.split(/\s+/).join(" ")}`.trim();

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
  const harness = useGenerate((s) => s.harness);
  useEffect(() => void useGenerate.getState().loadHarnesses(), []);
  if (job.state === "running") return <Writing url={url} job={job} />;
  const go = () => {
    useApp.getState().toggleChat(true);
    void useGenerate.getState().start(url, focus, useChat.getState().modeOf(harness));
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
        <HarnessPicker
          harness={harness}
          onPick={(h) => useGenerate.getState().pick(h)}
          command={reviewCommand(url, focus, harness)}
        />
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
  const harnesses = useGenerate((s) => s.harnesses);
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
          {harnesses.map((h) => (
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
          {...tip("Stop")}
          onClick={() => void useGenerate.getState().stop(url)}
        >
          {ic(Square, 13)}
        </button>
      </div>
      <div className="gen-bar" />
    </div>
  );
}
