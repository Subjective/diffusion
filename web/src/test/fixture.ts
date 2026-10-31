import type { FileDiff, Guide, PRPayload } from "../types";

const ln = (type: "add" | "del" | "ctx", old: number | null, nw: number | null, text: string) => ({
  type,
  old,
  new: nw,
  text,
});

export const files: FileDiff[] = [
  {
    path: "src/auth/session.ts",
    old_path: null,
    status: "modified",
    binary: false,
    additions: 4,
    deletions: 1,
    skip: null,
    hunks: [
      {
        id: "H1",
        file: "src/auth/session.ts",
        old_start: 1,
        old_len: 5,
        new_start: 1,
        new_len: 8,
        symbol: "class SessionManager",
        lines: [
          ln("ctx", 1, 1, 'import { Session } from "./types";'),
          ln("add", null, 2, 'import { refreshTokens } from "../api/client";'),
          ln("ctx", 2, 3, ""),
          ln("ctx", 3, 4, "export class SessionManager {"),
          ln("add", null, 5, "  private timer?: number;"),
          ln("del", 4, null, "  end() { this.s = null; }"),
          ln("add", null, 6, "  end() {"),
          ln("add", null, 7, "    clearTimeout(this.timer);"),
          ln("ctx", 5, 8, "}"),
        ],
      },
    ],
  },
  {
    path: "src/auth/types.ts",
    old_path: null,
    status: "modified",
    binary: false,
    additions: 1,
    deletions: 0,
    skip: null,
    hunks: [
      {
        id: "H2",
        file: "src/auth/types.ts",
        old_start: 1,
        old_len: 2,
        new_start: 1,
        new_len: 3,
        symbol: "",
        lines: [
          ln("ctx", 1, 1, "export interface TokenPair {"),
          ln("add", null, 2, "  expiresAt: number;"),
          ln("ctx", 2, 3, "}"),
        ],
      },
    ],
  },
  {
    path: "package-lock.json",
    old_path: null,
    status: "modified",
    binary: false,
    additions: 1,
    deletions: 1,
    skip: "lockfile",
    hunks: [
      {
        id: "H3",
        file: "package-lock.json",
        old_start: 3,
        old_len: 1,
        new_start: 3,
        new_len: 1,
        symbol: "",
        lines: [ln("del", 3, null, '"version": "1.0.0"'), ln("add", null, 3, '"version": "1.1.0"')],
      },
    ],
  },
];

export const guide: Guide = {
  tldr: "Sessions now refresh `tokens` before expiry.",
  context: [
    { icon: "fact", text: "Teardown runs on logout", refs: [{ hunk: "H1", side: "new", start: 6, end: 7 }] },
    { icon: "risk", text: "No retry on 5xx" },
  ],
  steps: [
    {
      id: 1,
      title: "Types",
      kind: "contract",
      summary: "New `expiresAt`.",
      refs: [{ hunk: "H2", side: "new", start: 2, end: 2 }],
    },
    {
      id: 2,
      title: "Teardown",
      kind: "cleanup",
      summary: "`end()` clears the timer.",
      refs: [{ hunk: "H1", side: "new", start: 6, end: 7 }],
    },
    {
      id: 3,
      title: "Refresh",
      kind: "core",
      summary: "Two parts.",
      refs: [
        { hunk: "H1", side: "new", start: 5, end: 5 },
        { hunk: "H1", side: "new", start: 2, end: 2 },
        { hunk: "H2", side: "new", start: 2, end: 2 },
      ],
      substeps: [
        {
          id: 1,
          title: "Timer field",
          summary: "Holds the pending refresh.",
          refs: [{ hunk: "H1", side: "new", start: 5, end: 5 }],
        },
        {
          id: 2,
          title: "Wiring",
          summary: "Import + type, split across files.",
          refs: [
            { hunk: "H1", side: "new", start: 2, end: 2 },
            { hunk: "H2", side: "new", start: 2, end: 2 },
          ],
        },
      ],
    },
  ],
  flow: {
    nodes: [
      { id: "a", label: "start()", step: 1 },
      { id: "b", label: "end()", step: 2 },
    ],
    edges: [{ from: "a", to: "b", label: null, kind: "normal" }],
  },
  skippable: [{ file: "package-lock.json", hunks: ["H3"], reason: "lockfile" }],
  uncovered: [],
  validation: { total_refs: 2, invalid_refs: 0, clamped_refs: 0 },
};

export const payload: PRPayload = {
  pr: {
    url: "https://github.com/acme/web/pull/7",
    owner: "acme",
    repo: "web",
    number: 7,
    title: "Add token refresh",
    body: "",
    author: "jy",
    base_ref: "main",
    head_ref: "feat",
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    additions: 6,
    deletions: 2,
    changed_files: 3,
  },
  files,
  guide: { ...guide, version: 1 },
  versions: [{ version: 1, label: "", scope: null, source: "agent", created_at: 0 }],
};
