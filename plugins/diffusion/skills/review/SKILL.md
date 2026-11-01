---
name: review
description: Write a guided review of a pull request, a branch, or uncommitted changes, and open it in Diffusion.
argument-hint: "[PR URL | repository directory] [what to focus on]"
allowed-tools: Bash(uvx:*), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(gh pr view:*), Bash(gh pr diff:*)
disable-model-invocation: true
---

# Diffusion review

You write a reviewer's guide to a set of changes, and Diffusion shows it next to the diff: steps to read in
order, each linked to the exact lines, plus comments on the lines that matter, a map of the change and what's
safe to skip. Your job is to make the review fast and correct: what matters, in what order, and what can be skipped.

## 1. Work out the target, the scope and the context

- **Target**: the diff the reviewer sees. A PR URL; or a local repository directory (default: the current
  directory), which compares the current branch with its base (`--base`/`--head` to choose refs). Use
  `--uncommitted` when the user means work that isn't committed yet (it is reviewed together with the branch's
  commits).
- **Scope**: what the guide must cover. The whole diff, unless the user asked to focus on part of it ("just
  the parser", "only `api/`"). Then set `scope.files` to those paths or globs and `scope.note` to the focus in
  a few words. Changes outside the scope can still be cited; they just don't have to be covered.
- **Context**: anything you read to explain the change: the rest of the diff, callers and consumers, tests,
  config, history, the PR description, and what the user said earlier in this conversation. Put what the
  reviewer said they care about or already know in `brief`; it is passed on to chat.

## 2. Explore

Start from the list of changed files, then read the diff in pieces you can keep in mind (`gh pr diff`, or
`git diff origin/HEAD...` for a local branch unless the user gave a base). Then read just enough of the surrounding code to understand entry points,
contracts and how the pieces connect. Prefer searching for callers and usages of changed symbols. Keep it
focused, and read more where the scope is narrow and deep. For a large diff you may hand exploration to a
subagent, one that inherits this conversation when it matters or a fresh one to keep your context small; write
the guide yourself.

## 3. Write the guide

Write JSON in the format of [schema.json](schema.json) to a file in the system's temp directory. Cite changed
lines as `{"file": "src/a.ts", "start": 12, "end": 18}`, with line numbers in the head version of the file;
add `"side": "old"` for deleted lines, and leave out `start`/`end` to cite every change in a file. Never
invent paths or line numbers.

- `label`: a few words naming this version, e.g. "Full review" or "Parser only".
- `tldr`: 1–2 plain sentences: what changes and the behavioural consequence.
- `comments`: 0–5 comments the reviewer sees under the lines they are about, like review comments on a PR.
  Leave one only for something worth stopping on: a likely bug, an assumption to verify, or context the diff
  can't show (a caller that depends on the change, an invariant elsewhere). `refs` are required and narrow.
  `title`: 2–4 words naming the point ("Never re-armed", "Unit unclear"). `text`: 1–2 sentences. `tone`:
  `bug` for a likely defect, `check` for something to verify, `note` (the default) for context. Don't repeat
  a step summary; an empty list is fine.
- `steps`: 3–8 steps in reading order (usually entry point → core logic → contracts → wiring → cleanup →
  tests), each a coherent concept to read together.
  - `title`: 1–3 words. `summary`: ≤ 25 words on what to look at and why. Inline `code` is fine.
  - `substeps`: when a step covers more than about 15 changed lines, 2–6 specific pieces of logic to read in
    order (one function, block or decision each). A substep may cite several ranges when one piece of logic
    is split across files. Avoid catch-all substeps like "remaining edits".
  - `refs`: narrow to the lines that matter (typically 2–15). Cite a whole change only if it is small. A step
    with substeps can leave its own `refs` empty.
  - Every non-trivial change in scope must appear in some step. A change may appear in several steps with
    different line ranges.
- `views`: one diagram of how the change fits together, which the reviewer can open as a map. 4–12 `box`
  blocks for the main functions, types or components (labels like `refresh()`), grouped by `region` blocks
  (a file, class or module) through `parent`. Each box cites the lines it stands for in `refs` and names its
  `step`; a box for unchanged code that helps explain the change has no `refs`. `arrows` show how control or
  data moves (`call`, `data`, `event`, `error`; labels ≤ 2 words). `scenes` walk the view outside-in: usually
  one per step (with `step`), each lighting the blocks it is about, then a last one on the blocks your `bug`
  and `check` comments sit on. Leave `views` out when the change has no meaningful structure.
- `skippable`: changes that are pure formatting or trivially safe (`formatting` / `trivial`). Lockfiles,
  snapshots, generated, vendored, binary and rename-only files are detected already.

Be concise; the UI shows icons, not prose.

## 4. Submit it

```
uvx --from diffusion-review==0.1.3 diffusion submit GUIDE.json TARGET [--uncommitted]
```

It checks every citation against the diff. If something doesn't match, nothing is saved: it prints what to
fix (with the changed line ranges) and exits 1. Fix the file and submit again, at most twice; then pass
`--allow-issues` to save what matches. It needs network access for a PR and starts a local server that keeps
running, so if your shell is sandboxed, run it outside the sandbox.

## 5. Tell the user

In one or two lines: the review link it printed, and the scope if you narrowed it. Don't open, fetch or
summarize the link yourself.

## Changing a guide

When the user asks to change a guide (regroup steps, refocus, fix a citation), run
`uvx --from diffusion-review==0.1.3 diffusion open TARGET`. It prints where the latest version's JSON is. Copy it to
the temp directory, edit it, update `label`, and submit it: it becomes a new version, and the open page switches
to it. Earlier versions stay in the page's history.

## Errors

- If `uvx` was not found, Diffusion needs uv. Tell the user to install it
  (`curl -LsSf https://astral.sh/uv/install.sh | sh` on macOS or Linux, or see https://docs.astral.sh/uv/) and
  try again.
- For any other error, quote the error lines and stop. Don't install anything.
