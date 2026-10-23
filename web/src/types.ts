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
export type ContextIcon = "fact" | "dependency" | "risk" | "history" | "config" | "security" | "performance";
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
export interface FlowNode {
  id: string;
  label: string;
  step: number;
  substep?: number | null;
}
export interface FlowEdge {
  from: string;
  to: string;
  label: string | null;
  kind: "normal" | "error";
}
export interface Guide {
  tldr: string;
  context: { icon: ContextIcon; text: string; refs?: Ref[] }[];
  steps: Step[];
  flow: { nodes: FlowNode[]; edges: FlowEdge[] };
  skippable: { file: string; hunks: string[]; reason: SkipReason }[];
  uncovered: string[];
  validation: { total_refs: number; invalid_refs: number; clamped_refs: number };
  meta?: { head_sha: string; model: string; turns: number; cost_usd: number | null; seconds: number };
}

export interface PRPayload {
  pr: PRMeta;
  files: FileDiff[];
  guide: Guide | null;
}

export type Stage = "fetch" | "hunks" | "explore";
