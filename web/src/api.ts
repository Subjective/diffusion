import { errorText } from "./lib/sse";
import type { GenerateJob, Guide, GuideVersion, Inbox, PRPayload, ReviewState, Target } from "./types";

/** The diff and a guide: version `v`, or the latest. */
export async function fetchPR(url: string, v?: number | null): Promise<PRPayload> {
  const q = new URLSearchParams({ url });
  if (v) q.set("v", String(v));
  const res = await fetch(`/api/pr?${q}`);
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

/** The guide versions saved for the target's current head. Cheap; polled to pick up new ones. */
export async function fetchVersions(url: string): Promise<{ head_sha: string; versions: GuideVersion[] }> {
  const res = await fetch(`/api/guides?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

export async function fetchGuide(url: string, v: number): Promise<Guide> {
  const res = await fetch(`/api/guide?url=${encodeURIComponent(url)}&v=${v}`);
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

export async function fetchFile(url: string, path: string): Promise<string> {
  const res = await fetch(`/api/file?url=${encodeURIComponent(url)}&path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()).text;
}

/** Every file tracked at the head, for the navigator's all-files view. */
export async function fetchTree(url: string): Promise<string[]> {
  const res = await fetch(`/api/tree?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()).files;
}

export interface DefinitionMatch {
  path: string;
  line: number;
  end: number;
  text: string;
}

export async function fetchDefinition(url: string, symbol: string, path: string): Promise<DefinitionMatch[]> {
  const q = new URLSearchParams({ url, symbol, path });
  const res = await fetch(`/api/definition?${q}`);
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()).matches;
}

export interface ReferenceMatch {
  path: string;
  line: number;
  col: number;
  text: string;
}

export async function fetchReferences(url: string, symbol: string, path: string): Promise<ReferenceMatch[]> {
  const q = new URLSearchParams({ url, symbol, path });
  const res = await fetch(`/api/references?${q}`);
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()).matches;
}

/** A definition or reference with a few lines either side; `first` is the first line's number. */
export async function fetchAround(
  url: string,
  path: string,
  line: number,
  end: number,
): Promise<{ first: number; text: string }> {
  const q = new URLSearchParams({ url, path, line: String(line), end: String(end) });
  const res = await fetch(`/api/around?${q}`);
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

/** Everything reviewed so far, most recent first. */
export async function fetchTargets(): Promise<Target[]> {
  const res = await fetch("/api/targets");
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

/** The signed-in user's open PRs on GitHub (the engine reuses its answer for a minute unless `refresh`). */
export async function fetchInbox(refresh = false): Promise<Inbox> {
  const res = await fetch(`/api/inbox${refresh ? "?refresh=true" : ""}`);
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

/** A PR's review threads, reviewers and checks from GitHub (reused for half a minute unless `refresh`). */
export async function fetchReview(url: string, refresh = false): Promise<ReviewState> {
  const q = new URLSearchParams({ url });
  if (refresh) q.set("refresh", "true");
  const res = await fetch(`/api/review?${q}`);
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

/** Something done on the PR as you: submit a review, reply to or (un)resolve a thread, edit or delete a comment. */
export type ReviewAct =
  | {
      kind: "submit";
      event: "comment" | "approve" | "request_changes";
      body: string;
      commit?: string;
      comments: { path: string; side: "old" | "new"; start: number | null; end: number | null; body: string }[];
    }
  | { kind: "comment"; pr: string; body: string }
  | { kind: "reply"; thread: string; body: string }
  | { kind: "resolve" | "unresolve"; thread: string }
  | { kind: "edit"; comment: string; body: string }
  | { kind: "delete"; comment: string }
  | { kind: "edit_pr"; pr: string; title: string; body: string };

/** Do it on GitHub; the answer is the PR's fresh review state. */
export async function reviewAction(url: string, action: ReviewAct): Promise<ReviewState> {
  const res = await fetch("/api/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, action }),
  });
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

/** Start writing a review of the PR with the reviewer's agent, in the background. */
export async function startGenerate(
  url: string,
  focus = "",
  mode = "default",
  harness = "claude-code",
): Promise<GenerateJob> {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, focus, mode, harness }),
  });
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

/** The agents that can write a review from here. */
export async function fetchGenerateHarnesses(): Promise<string[]> {
  const res = await fetch("/api/generate/harnesses");
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()).harnesses;
}

/** Switch the review being written to another mode; returns the waiting asks that went ahead. */
export async function switchGenerateMode(url: string, mode: string): Promise<string[]> {
  const res = await fetch("/api/generate/mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, mode }),
  });
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()).answered ?? [];
}

/** Answer a tool call the review being written is waiting on. */
export async function answerGenerate(id: string, decision: string): Promise<void> {
  await fetch("/api/generate/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, decision }),
  });
}

/** Stop it: the agent stops and nothing is saved. */
export async function stopGenerate(url: string): Promise<GenerateJob> {
  const res = await fetch("/api/generate/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

export async function fetchGenerate(url: string): Promise<GenerateJob> {
  const res = await fetch(`/api/generate?${new URLSearchParams({ url })}`);
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

export interface Command {
  name: string;
  description: string;
  hint: string;
}

/** What the guide session can run from the composer's / menu (Claude Code commands, Codex skills). */
export async function fetchCommands(url: string): Promise<Command[]> {
  const res = await fetch(`/api/commands?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()).commands ?? [];
}
