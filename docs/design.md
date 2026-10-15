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

A local tool that turns a PR URL, or a local branch, into a **guided, linked walkthrough** of the change, plus a **code-anchored AI side chat** for questions.

### Goals
- G1. Go from pasting a PR URL to a usable guide in about 2 minutes for a typical PR (≤ 1,500 changed lines).
- G2. Every part of the guide (step, substep, flow node, note, reference) links to exact diff lines, and every link resolves.
- G3. No changed code is silently left out. Every hunk is either covered by a step, marked skippable with a reason, or listed as uncovered.
- G4. Reviewers can ask about specific lines, ask several things without waiting, and always trace an answer back to its code.
- G5. Minimal, icon-first UI, styled after OpenAI's design language: neutral palette, whitespace, hairline borders, one accent color.
- G6. Works with the model access reviewers already have: Anthropic or OpenAI keys, OpenRouter, a gateway, a local model, or an existing Claude Code / Codex setup.

### Non-goals (v1)
- Posting reviews or comments to GitHub, approving, or requesting changes.
- Replacing GitHub's PR page. This is a companion for reading.
- A hosted or multi-user service. v1 runs on the reviewer's own machine.
- Non-GitHub hosts for PR metadata. (Local mode works with any git repository.)
- Automated bug-finding or lint-style review. The guide explains; it doesn't judge.

## 3. Users

A software engineer reviewing a colleague's PR (or their own branch), often one produced with AI help. They're comfortable on the command line, have git and either `gh` or a GitHub token, and have some form of model access. They may work on a remote machine and view the UI through an SSH port forward.

## 4. Core flows

1. **Generate.** Paste a PR URL, or `local:<repo>#<base>..<head>` for a local branch, and press generate. Progress shows the stages (fetch → split into hunks → read & plan → validate), and the guide replaces it when ready. Reloading the page reconnects to a job that's still running. The same PR at the same head SHA loads from the cache.
2. **Read by steps.** Read the TL;DR and notes, scan the flow graph, then work through the steps in order. Larger steps break into substeps, each a specific piece of logic that may span several files or line ranges. Hovering a step or substep highlights its lines (a step highlights all of its substeps'). Clicking one scrolls there, expands any collapsed file, and pins the highlight. `j`/`k` walk steps and substeps in reading order. Steps can be marked read, with progress shown as `n/N`.
3. **Skip noise.** Skippable files (lockfiles, snapshots, generated code, renames) are listed separately and collapsed in the diff, and can be hidden entirely.
4. **Ask about lines.** Select text in the diff, or press and drag a line's bubble icon across several lines, then type a question in the popup.
   - `Enter` asks now. The question and code go to the chat and the answer streams in.
   - `⇧Enter` queues the question. It joins a tray above the composer, and the send button shows the queued count. Sending sends every queued comment, plus any typed message, as one turn, and each question gets its own answer section.
5. **Chat.** A general chat is seeded with the PR and the guide. The composer sends immediately; queuing only applies to line comments. One turn runs at a time: anything asked while an answer is streaming waits in the thread and goes out together as the next turn, so you never have to wait before asking again.
6. **Trace back.** Each anchored question puts a numbered badge in the diff gutter, whose look reflects its status: queued, waiting, answering or answered. Hovering a badge, question, queued row or answer header highlights the original lines. Clicking a question or answer flashes those lines and scrolls to them. Clicking a badge jumps to its answer.
7. **Chat history.** A new chat starts clean, with no messages, annotations or queue from the previous one. The history icon lists past chats (first question, number of questions, number tied to code, how long ago), and opening one restores its messages and gutter annotations.

## 5. Functional requirements

### 5.1 Top bar
- Target input (PR URL or `local:` target), a generate/regenerate button, a light/dark theme toggle and a chat panel toggle. Icons only.

### 5.2 Guide pane (left)
- Resizable by dragging its right edge; shares a clamp with the chat panel so the diff keeps at least 420px. The width is remembered, and double-clicking the edge resets it.
- PR title, repo and number (or head → base for a local branch), author, total added/deleted lines.
- **TL;DR**: 1–2 sentences.
- **Notes**: 0–4 one-sentence items the reviewer can't see in the diff (a dependent caller, a convention elsewhere, a likely problem), each with an icon from a fixed set (fact, dependency, risk, history, …). Risks are listed first and tinted. A note can link to lines: hovering highlights them, clicking scrolls there. Notes don't repeat the TL;DR or steps, and the section is hidden when empty.
- **Flow**: a graph whose nodes are functions or components and whose edges show calls or data flow. Error paths are dashed and red. Each node belongs to a step (optionally a substep), and hovering or clicking it behaves like that step or substep. It scales with the pane width; there's no separate expanded view, so highlights stay visible in the diff.
- **Steps**: an ordered list. Each has a number, a kind icon (entry, core, contract, wiring, cleanup, test, config, docs), a short title, a one-to-two-line summary, ref chips (`file:start–end`), a mark-read toggle, and an "ask about this step" action.
- **Substeps**: listed under their step and numbered `1.1`, `1.2`. Each has a title, a short summary and its own ref chips; references are narrow (typically 2–15 lines) and may span several files or ranges.
- **Skippable**: one row per file, showing the reason icon, filename and +/− counts. Clicking a row opens that file.
- **Uncovered**: any hunks not covered by a step and not skippable. Shown only when there are some.

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
- Tool activity (for example `Grep refreshTokens`) shown while the agent is exploring.
- Questions asked while an answer is streaming appear in the thread with a clock icon and count, and are sent together when it finishes.

## 6. System overview

- **Engine** (Python, local): for a PR, fetches metadata with `gh` (or the REST API with `GITHUB_TOKEN`) and makes a git worktree at the PR head from a cached clone; for a local branch, makes the worktree from the local repo. It computes the diff against the merge base, splits it into hunks with stable IDs (`H1..Hn`), and classifies skippable files with rules.
  - **Guide agent:** a session in the worktree with read-only file tools plus `get_hunk`. For normal-sized changes the annotated hunks are in the prompt, so it can cite exact lines. It explores and then calls `submit_guide` with output matching a fixed schema (steps, substeps, refs, flow, notes).
  - **Validation:** a validator checks every reference against the hunk table, clamps line ranges, drops invalid refs, and computes coverage.
  - **Chat agent:** a separate session per chat, seeded with the PR, the hunks and the guide, with the same read-only tools. Turns in a chat run one at a time and resume the same session.
- **Backends**, behind one runner interface and chosen per profile:
  - `api`: a Pydantic AI agent over the Anthropic Messages API or any OpenAI-compatible Chat Completions API (OpenAI, OpenRouter, Gemini, Ollama, vLLM, gateways), with read-only `read_file`/`grep`/`glob` tools.
  - `claude-code`: the Claude Agent SDK, driving the user's Claude Code CLI with its read-only built-in tools.
  - `codex`: `codex exec` in a read-only sandbox; the guide comes back through `--output-schema`.
- **Web** (React, local): renders the guide, the diff and the chat. It talks to the engine over HTTP and streaming SSE. The built UI ships inside the Python package, so `diffusion serve` needs no Node.
- **Storage:** everything stays under `~/.cache/diffusion/`: the repo clones and worktrees, guides keyed by head SHA, chat records, and `api`-backend sessions.

## 7. LLM, security and data constraints

- Model access is configured as profiles (`~/.config/diffusion/config.toml`) or auto-detected from the environment; see the README. Each profile sets a backend, endpoint, key source and models: a strong model for guides and a faster one for chat.
- Keys come from environment variables, a key command, or inherited settings files (e.g. an existing Claude Code setup). They're never written to disk by the tool, logged, or sent to the browser.
- The agent's tools are read-only and confined to the change's worktree; paths outside it are rejected, including through symlinks. It has no write access and no web access, and no shell except Codex's own read-only sandbox.
- PR text and code are untrusted input. A hostile change can at worst mislead the guide.
- The engine listens on `127.0.0.1` only. Remote access is through SSH port forwarding.
- Code is sent only to the configured model backend. There is no other external service.
- `diffusion doctor --eval` scores a model's line-reference accuracy on a built-in sample change, so users can check a model before relying on it.

## 8. Success metrics

| Metric | Target |
|---|---|
| References that resolve to real lines, after validation | 100% |
| Invalid references before validation (a measure of model quality; see `diffusion doctor --eval`) | < 5% |
| Hunks not skippable and not covered by any step | ≤ 1 per PR on average |
| Time to a complete guide, for a PR of ≤ 1,500 lines | ≤ 2 min (p50) |
| Time until a chat answer starts streaming (no tool calls) | ≤ 3 s |
| Reviewer reports they understood the PR faster (self-reported) | majority of pilot users |

## 9. Milestones

1. Engine produces a validated guide JSON from the command line (`diffusion guide <url>`).
2. Web UI shows the diff and the guide, with step linking and the flow graph.
3. Chat, select/drag to ask, the comment queue, linked annotations and history.
4. A single-port `diffusion serve`, plus README instructions.
5. Pluggable model backends (`api`, `claude-code`, `codex`), profiles, local-branch mode, and a self-contained package.

## 10. Deferred / future

- **Parallel fan-out for queued comments:** run each queued question as its own session on a shared cached prefix, so a slow question doesn't hold up fast ones.
- **Seed the chat with distilled exploration context:** give the chat the notes and excerpts the guide agent gathered, rather than replaying its transcript.
- A browser extension as a second front end on GitHub's PR page, using the same local engine.
- PR metadata from other code hosts (GitLab, Bitbucket).
- Posting the reviewer's comments back to GitHub as review comments.
- Incremental re-guiding when new commits are pushed (showing what changed since the last guide).
- A symbol index (callers and usages of changed symbols) as input to the guide agent.

## 11. Open questions

- Can large PRs (> 5,000 lines) be handled by limiting hunks, or do they need chunked multi-pass generation?
- How should guides and chats be kept when the PR head moves: archive, or try to re-anchor?
- Which models reliably produce good guides? Collect `doctor --eval` results and recommend a short list.
