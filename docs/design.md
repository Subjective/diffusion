# Diffusion: Design

UI reference: [`design/wireframe.html`](design/wireframe.html), an interactive wireframe (open it in a browser). The app has since moved past it in places; this document describes the current behaviour.

## 1. Problem

AI-assisted development has made writing code cheap, so the bottleneck has moved to review. GitHub's PR view lists changed files alphabetically and treats every line equally. A reviewer has to work out on their own:

- what the change is for, and what they need to know before reading it,
- where the logic starts and what order to read it in,
- which changes matter and which are boilerplate (lockfiles, snapshots, generated code),
- how a changed line relates to code the PR doesn't touch.

Reviewers end up reading in the wrong order, rebuilding context by hand, and spending their attention on noise.

## 2. Goal

A plugin for the reviewer's coding agent (Claude Code, Codex or Cursor) that turns a PR, a local branch or uncommitted work into a **guided, linked walkthrough** of the change, plus a **code-anchored AI side chat** for questions. The agent explores the change with its own tools and writes the guide; Diffusion checks it against the diff, keeps its versions, and renders it.

### Goals
- G1. Go from asking the agent for a review to a usable guide in about 2 minutes for a typical PR (≤ 1,500 changed lines).
- G2. Every part of the guide (step, substep, flow node, note, reference) links to exact diff lines, and every link resolves.
- G3. No changed code is silently left out. Every hunk is either covered by a step, marked skippable with a reason, or listed as uncovered.
- G4. Reviewers can ask about specific lines, ask several things without waiting, and always trace an answer back to its code.
- G5. Minimal, icon-first UI, styled after OpenAI's design language: neutral palette, whitespace, hairline borders, one accent color.
- G6. Works with the agent reviewers already use, on its own login and settings, with nothing to configure.
- G7. The guide fits the request: the whole change, or a focus within it (one file, one area) written with the rest of the change and the codebase as context.

### Non-goals (v1)
- Posting reviews or comments to GitHub, approving, or requesting changes.
- Replacing GitHub's PR page. This is a companion for reading.
- A hosted or multi-user service. v1 runs on the reviewer's own machine.
- Non-GitHub hosts for PR metadata. (Local mode works with any git repository.)
- Automated bug-finding or lint-style review. The guide explains; it doesn't judge.

## 3. Users

A software engineer reviewing a colleague's PR (or their own branch), often one produced with AI help. They're comfortable on the command line, have git and either `gh` or a GitHub token, and use Claude Code, Codex or Cursor. They may work on a remote machine and view the UI through an SSH port forward.

## 4. Core flows

1. **Ask for a review.** In the agent, run `/diffusion:review` with a PR URL, nothing for the current branch, or words for what to focus on ("just the parser", "my uncommitted changes"). The agent works out three things: the **target** (the diff shown: a PR, a branch against its base, or the working tree), the **scope** (the changes the guide must cover, the whole diff unless narrowed) and the **context** (anything it reads to explain them). It explores, writes the guide, and submits it with `diffusion submit`, which checks every citation and either saves the guide as a new version and opens the page, or says what to fix. The agent may hand exploration to a subagent, one that inherits the conversation or a fresh one, as it sees fit.
2. **Revise.** Asking the agent, or the chat beside the guide, to change the guide (regroup steps, refocus, fix a citation) saves a new version. An open page switches to it within a few seconds, and earlier versions stay in its history.
3. **Read by steps.** Read the TL;DR, scan the flow graph, then work through the steps in order. Larger steps break into substeps, each a specific piece of logic that may span several files or line ranges. Hovering a step or substep highlights its lines (a step highlights all of its substeps'). Clicking one scrolls there, expands any collapsed file, and pins the highlight. `j`/`k` walk steps and substeps in reading order, and `h`/`l` move through the pinned one's line ranges, which may be far apart in the diff (its ref chip shows which). Steps can be marked read, with progress shown as `n/N`.
4. **Skip noise.** Skippable files (lockfiles, snapshots, generated code, renames) are listed separately and collapsed in the diff, and can be hidden entirely.
5. **Ask about lines.** Select text in the diff, or press and drag a line's bubble icon across several lines, then type a question in the popup.
   - `Enter` asks now. The question and code go to the chat and the answer streams in.
   - `⇧Enter` queues the question. It joins a tray above the composer, and the send button shows the queued count. Sending sends every queued comment, plus any typed message, as one turn, and each question gets its own answer section.
6. **Chat.** A general chat is seeded with the PR and the guide on screen. With Claude Code or Codex it continues a fork of the session that wrote the guide, so it knows what the agent read while the agent's own session is left alone; Cursor's CLI can't fork, so its chat starts fresh with the guide and the reviewer's brief. The composer sends immediately; queuing only applies to line comments. One turn runs at a time: anything asked while an answer is streaming waits in the thread and goes out together as the next turn, so you never have to wait before asking again.
7. **Trace back.** Each anchored question puts a numbered badge in the diff gutter, whose look reflects its status: queued, waiting, answering or answered. Hovering a badge, question, queued row or answer header highlights the original lines. Clicking a question or answer flashes those lines and scrolls to them. Clicking a badge jumps to its answer.
8. **Chat history.** A new chat starts clean, with no messages, annotations or queue from the previous one. The history icon lists past chats (first question, number of questions, number tied to code, how long ago), and opening one restores its messages and gutter annotations.

## 5. Functional requirements

### 5.1 Top bar
- What's under review: the repository and PR number (linking to the PR), or the repository and branch for local work. Then, once a guide has more than one version, a history button showing the version on screen (`v3`); its menu lists versions newest first, with label, whether the agent or a chat wrote it, scope and age, and picking one shows it. A page that's showing the latest version follows new ones as they arrive; one showing an earlier version stays put. Then a light/dark theme toggle and a chat panel toggle. Icons only.

### 5.2 Guide pane (left)
- Resizable by dragging its right edge; shares a clamp with the chat panel so the diff keeps at least 420px. The width is remembered, and double-clicking the edge resets it.
- PR title, repo and number (or head → base for a local branch), author, total added/deleted lines.
- **TL;DR**: 1–2 sentences. When the guide is scoped to part of the change, a quiet chip beside the heading names the focus (hovering lists the paths).
- **No guide yet**: the PR header, then the command to ask the agent for one, with a copy button. The guide appears when it's submitted.
- **Comments**: 0–5 comments the guide leaves on the lines they are about, shown GitHub-style under the last cited line: a 2–4 word title, a sentence or two, and a tone (`bug`, `check` or `note`) that only tints the icon. Hovering one highlights its lines. **Ask** opens the ask popup on those lines with the comment attached, so follow-up happens in chat; **Resolve** collapses it to a dimmed one-line row whose check turns into an undo icon on hover, and clicking that row unresolves it (remembered per PR), and a toolbar button with the open count hides them all. Every comment must cite lines; one whose refs all miss the diff is dropped.
- **Flow**: a graph whose nodes are functions or components and whose edges show calls or data flow. Error paths are dashed and red. Each node belongs to a step (optionally a substep), and hovering or clicking it behaves like that step or substep. It scales with the pane width; there's no separate expanded view, so highlights stay visible in the diff.
- **Steps**: an ordered list. Each has a number, a kind icon (entry, core, contract, wiring, cleanup, test, config, docs), a short title, a one-to-two-line summary, ref chips (`file:start–end`), a mark-read toggle, and an "ask about this step" action.
- **Substeps**: listed under their step and numbered `1.1`, `1.2`. Each has a title, a short summary and its own ref chips; references are narrow (typically 2–15 lines) and may span several files or ranges.
- **Skippable**: one row per file, showing the reason icon, filename and +/− counts. Clicking a row opens that file.
- **Uncovered**: any changes in scope not covered by a step and not skippable. Shown only when there are some.

### 5.3 Diff pane (centre)
- A unified diff per file, with sticky file headers showing the path, +/− counts, the numbers of the steps that touch the file, and a viewed toggle (marking a file viewed collapses it).
- Hunk headers, old and new line numbers, syntax highlighting, and add/delete backgrounds.
- A step-number dot in the gutter at the start of each step's range, or a `1.2`-style dot per substep; dots link back to their step or substep.
- Toolbar: guide order or A–Z, hide skippable, collapse all.
- Hovering a line shows a bubble. Clicking it asks about that line. Pressing and dragging selects a range, showing a live `L16–19` label and auto-scrolling near the edges. `Esc` cancels.

### 5.4 Chat panel (right)
- Header: history, new chat and close. The panel can be resized by dragging its left edge. The width is clamped so the diff keeps at least 420px, it's remembered, and double-clicking the edge resets it.
- Empty state: suggestion chips (risks, test gaps, flow).
- Messages: the user's questions with code cards (file, range, code preview) and number badges, and AI answers with a numbered, linked header per question.
- Queue tray (shown only when comments are queued): a list of `n · file:range · question` rows with remove and clear-all. No separate send button; the composer's send button shows the count.
- What the agent is doing shows as one quiet line above the answer: its latest step while it works (`Grep refreshTokens`, or a reasoning headline), then "Thought for 12s · 6 tools" (or "Worked for…" without reasoning). It opens to a timeline of reasoning and tool calls in the order they happened, as Cursor and Codex show them. Reasoning is whatever the agent's CLI reports: Claude Code's thinking summaries, Codex reasoning items, Cursor thinking.
- Questions asked while an answer is streaming appear in the thread with a clock icon and count, and are sent together when it finishes.
- An answer that changed the guide ends with a small "Updated the guide · v4" link, and the guide pane switches to that version.

## 6. System overview

- **Plugin** (`plugins/diffusion/`): the `review` skill, for Claude Code, Codex and Cursor. It tells the agent how to choose target, scope and context, what makes a good guide, and the guide's format (`schema.json`), then has it run `diffusion submit`. Exploration is the agent's own, with its own tools.
- **Engine** (Python, local, run through `uvx`): for a PR, fetches metadata with `gh` (or the REST API with `GITHUB_TOKEN`) and makes a git worktree at the PR head from a cached clone; for a local branch, makes the worktree from the local repo; for uncommitted work, first commits the working tree to a dangling snapshot through a temporary index, leaving the user's branch, index and files alone (an unchanged working tree keeps its snapshot, so its guide versions carry over). It computes the diff against the merge base, splits it into hunks with stable IDs, and classifies skippable files with rules.
  - **Submit:** agents cite changed lines by path and head line number (`{file, start, end, side}`). `diffusion submit` maps each citation onto the hunks it touches, clamps it into them, and computes coverage within the scope. If anything doesn't match, nothing is saved and the agent gets a list of what to fix, with the changed ranges of each file. Otherwise the guide is saved as the next version, with the draft as written (which is what an agent edits to make the next one), and the page opens on it.
  - **Chat agent:** a session per chat on the agent CLI that wrote the guide, seeded with the PR, the hunks and the guide on screen, with read-only tools. With Claude Code and Codex the first turn forks the guide's session (falling back to a fresh one if it's gone); later turns resume the chat's own. When asked to change the guide, the answer ends with the whole revised guide in a `diffusion-guide` block, which is hidden from the reply, checked like a submit, and saved as a new version.
- **Agent CLIs**, behind one runner interface:
  - `claude-code`: the Claude Agent SDK, driving Claude Code with its read-only built-in tools.
  - `codex`: `codex exec` (or `codex exec fork` from the guide's thread) in a read-only sandbox.
  - `cursor`: `cursor-agent -p` in read-only ask mode.
- **Web** (React, local): renders the guide, the diff and the chat, and polls for new guide versions. It talks to the engine over HTTP and streaming SSE. The built UI ships inside the Python package, so the server needs no Node.
- **Storage:** everything stays under `~/.cache/diffusion/`: the repo clones, worktrees and snapshots, guide versions keyed by target and head SHA, and chat records.

## 7. LLM, security and data constraints

- Guides are written by the reviewer's own agent, with its own permissions; Diffusion runs no model to write them.
- Chat runs on the same agent's CLI, on its login and provider settings. Diffusion stores no keys.
- The chat agent's tools are read-only and confined to the change's worktree; paths outside it are rejected, including through symlinks. It has no write access and no web access, and no shell except Codex's own read-only sandbox.
- PR text and code are untrusted input. A hostile change can at worst mislead the guide.
- A submitted guide is data: every citation is checked against the diff, and text is rendered as inline markdown only.
- The engine listens on `127.0.0.1` only. Remote access is through SSH port forwarding.

## 8. Success metrics

| Metric | Target |
|---|---|
| References that resolve to real lines, after validation | 100% |
| Guides that pass `diffusion submit` within two correction rounds | ≥ 95% |
| Hunks not skippable and not covered by any step | ≤ 1 per PR on average |
| Time to a complete guide, for a PR of ≤ 1,500 lines | ≤ 2 min (p50) |
| Time until a chat answer starts streaming (no tool calls) | ≤ 3 s |
| Reviewer reports they understood the PR faster (self-reported) | majority of pilot users |

## 9. Milestones

1. Engine checks a guide against a diff and produces the linked guide JSON.
2. Web UI shows the diff and the guide, with step linking and the flow graph.
3. Chat, select/drag to ask, the comment queue, linked annotations and history.
4. A single-port `diffusion serve`, plus README instructions.
5. Local-branch mode and a self-contained package.
6. Guides written by the reviewer's agent through the plugin, with scope, uncommitted work, versions, and chat that continues the guide's session.

## 10. Deferred / future

- **Parallel fan-out for queued comments:** run each queued question as its own session on a shared cached prefix, so a slow question doesn't hold up fast ones.
- A browser extension as a second front end on GitHub's PR page, using the same local engine.
- PR metadata from other code hosts (GitLab, Bitbucket).
- Posting the reviewer's comments back to GitHub as review comments.
- Incremental re-guiding when new commits are pushed (showing what changed since the last guide).

## 11. Open questions

- For very large PRs (> 5,000 lines), should the skill suggest splitting the review into scoped guides?
- How should guides and chats be kept when the PR head moves: archive, or try to re-anchor?
- Which agents and models reliably produce good guides? Collect results and recommend a short list.
