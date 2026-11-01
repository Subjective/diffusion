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
  meta?: { head_sha: string; source?: "agent" | "chat"; harness?: string | null; created_at?: number };
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
