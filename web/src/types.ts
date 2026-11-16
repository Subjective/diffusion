// Mirrors engine/src/diffusion/{hunks,schema,github}.py

export type LineType = "add" | "del" | "ctx";
export interface Line {
  type: LineType;
  old: number | null;
  new: number | null;
  text: string;
}
export interface Hunk {
  id: string;
  file: string;
  old_start: number;
  old_len: number;
  new_start: number;
  new_len: number;
  symbol: string;
  lines: Line[];
}
export type SkipReason =
  | "lockfile"
  | "generated"
  | "snapshot"
  | "vendored"
  | "rename"
  | "binary"
  | "formatting"
  | "trivial";
export interface FileDiff {
  path: string;
  old_path: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: Hunk[];
  skip: SkipReason | null;
}

export interface PRMeta {
  url: string;
  owner: string;
  repo: string;
  number: number;
  local?: boolean;
  title: string;
  body: string;
  author: string;
  base_ref: string;
  head_ref: string;
  base_sha: string;
  head_sha: string;
  additions: number;
  deletions: number;
  changed_files: number;
}

export type StepKind = "entry" | "core" | "contract" | "wiring" | "cleanup" | "test" | "config" | "docs";
export type Tone = "bug" | "check" | "note";
export interface Ref {
  hunk: string;
  side: "new" | "old";
  start: number | null;
  end: number | null;
}
export interface Substep {
  id: number;
  title: string;
  summary: string;
  refs: Ref[];
}
export interface Step {
  id: number;
  title: string;
  kind: StepKind;
  summary: string;
  refs: Ref[];
  substeps?: Substep[];
}
/** A piece of code in a view: a box, or a region grouping boxes. A block with no refs is unchanged context. */
export interface Block {
  id: string;
  label: string;
  kind: "box" | "region";
  parent?: string | null;
  step?: number | null;
  refs: Ref[];
}
export interface Arrow {
  from: string;
  to: string;
  label?: string | null;
  kind: "call" | "data" | "event" | "error";
}
/** One stop in a walk through a view: the blocks it frames and lights. */
export interface Scene {
  title: string;
  text: string;
  blocks: string[];
  step?: number | null;
}
/** A diagram of the change, shown as the map. The first view is the overview. */
export interface View {
  id: number;
  title: string;
  layout: "flow";
  blocks: Block[];
  arrows: Arrow[];
  scenes: Scene[];
}
/** A comment the guide leaves on the lines it is about; shown under them in the diff. */
export interface Comment {
  id: number;
  title: string;
  text: string;
  tone: Tone;
  refs: Ref[];
}
export interface Scope {
  files: string[];
  note: string;
}
export interface Guide {
  version?: number;
  label?: string;
  scope?: Scope | null;
  brief?: string;
  tldr: string;
  comments: Comment[];
  steps: Step[];
  views: View[];
  skippable: { file: string; hunks: string[]; reason: SkipReason }[];
  uncovered: string[];
  validation: { total_refs: number; invalid_refs: number; clamped_refs: number };
  meta?: {
    head_sha: string;
    source?: "agent" | "chat";
    harness?: string | null;
    /** The agent session that wrote the guide, which chat forks or continues. */
    session?: string | null;
    created_at?: number;
  };
}

/** One saved version of the guide for the current head: every submit, and every edit made from chat. */
export interface GuideVersion {
  version: number;
  label: string;
  scope: Scope | null;
  source: "agent" | "chat";
  created_at: number | null;
}

export interface PRPayload {
  pr: PRMeta;
  files: FileDiff[];
  guide: Guide | null;
  versions: GuideVersion[];
}

/** A past review on the home page. */
export interface Reviewer {
  login: string;
  avatar: string;
  state: "approved" | "changes" | "commented" | "requested";
}

export interface Check {
  name: string;
  state: "success" | "failure" | "pending" | "skipped";
  url: string;
  /** Where a failing check points in the code. */
  annotations?: { path: string; start: number | null; end: number | null; message: string; title: string }[];
}

export interface ThreadComment {
  id: string;
  author: string;
  avatar: string;
  bot: boolean;
  body: string;
  created_at: number;
  url: string;
  /** The review it was posted with. */
  review?: string | null;
}

/** One entry in a PR's conversation: a comment, a submitted review, or a pushed commit. */
export interface TimelineItem {
  kind: "comment" | "review" | "commit";
  id: string;
  author: string;
  avatar: string;
  bot?: boolean;
  body: string;
  created_at: number;
  url?: string;
  state?: "approved" | "changes" | "commented" | "dismissed";
  sha?: string;
}

/** A review thread on GitHub: on lines `start`–`end` of one side of `path`, on the whole file, or outdated. */
export interface Thread {
  id: string;
  path: string;
  side: "old" | "new";
  start: number | null;
  end: number | null;
  file_level: boolean;
  resolved: boolean;
  outdated: boolean;
  comments: ThreadComment[];
  /** Diffusion's own, not GitHub's: a comment waiting for your review, or a failing check's note on these lines. */
  pending?: boolean;
  ci?: { name: string; url: string };
}

/** GitHub's side of a PR. `available` is false for local targets. */
export interface ReviewState {
  available: boolean;
  error?: string;
  viewer?: string;
  /** The PR's GitHub node id (for commenting on it). */
  id?: string;
  title?: string;
  body?: string;
  timeline?: TimelineItem[];
  /** The PR's author (who can't approve or request changes on it). */
  author?: string;
  head_sha?: string;
  base_ref?: string;
  mergeable?: "mergeable" | "conflicting" | "unknown";
  reviewers?: Reviewer[];
  checks?: { state: "success" | "failure" | "pending" | "none"; failing: number; list: Check[] };
  threads?: Thread[];
}

/** One of the signed-in user's open PRs on GitHub, for the home page's inbox. */
export interface InboxPR {
  url: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  draft: boolean;
  group: "review" | "yours" | "drafts";
  author: string;
  author_avatar: string;
  base_ref: string;
  head_ref: string;
  updated_at: number;
  comments: number;
  reviewers: Reviewer[];
  checks: { state: "success" | "failure" | "pending" | "none"; failing: number };
  /** Set when the PR builds on another open PR's branch: the bottom PR's url, its layer (1 = bottom) and the size. */
  stack?: { id: string; index: number; size: number };
  /** Guide versions saved for it. */
  guides: number;
  /** A review Diffusion is writing (or wrote, or failed to) for it from here. */
  generating?: GenerateJob;
}

export interface GenerateJob {
  state: "none" | "running" | "done" | "failed" | "stopped";
  /** What the agent is doing now. */
  doing?: string;
  error?: string | null;
  /** When it started (epoch seconds), and what it was asked. */
  started_at?: number;
  prompt?: string;
  /** Its steps so far (tool calls, reasoning) and what it has said. */
  log?: ({ tool: string } | { think: string })[];
  text?: string;
  /** The agent writing it. */
  harness?: string;
  /** Tool calls waiting on the reviewer, as in a chat turn. */
  asks?: { id: string; tool: string; summary: string; input: Record<string, unknown> }[];
}

export interface Inbox {
  login: string;
  prs: InboxPR[];
  error: string | null;
}

export interface Target {
  url: string;
  owner: string;
  repo: string;
  number: number;
  local?: boolean;
  title: string;
  head_ref: string;
  label: string;
  versions: number;
  chats: number;
  updated_at: number;
}
