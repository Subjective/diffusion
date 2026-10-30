---
name: video
description: Make a short narrated, animated explainer video of a pull request, or of the current branch, for reviewers.
argument-hint: "[PR URL | repository directory]"
allowed-tools: Bash(npx:*), Bash(npm:*), Bash(uv:*), Bash(gh:*), Bash(git:*), Bash(ffprobe:*), Bash(ffmpeg:*)
disable-model-invocation: true
---

# PR video

Make a short narrated video that helps a reviewer understand the change: what it does, how it fits the system,
and the few pieces of code that matter. It should feel like a well-made explainer, not a slideshow or a reading
of the diff.

## Tools

Render with HyperFrames (HTML to MP4) and speak with its local Kokoro voice. Start every shell call with these
two lines, since variables don't carry between calls:

```
export HYPERFRAMES_NO_TELEMETRY=1 HYPERFRAMES_PYTHON=~/.cache/diffusion/tts/bin/python
HF="npx --yes hyperframes@0.8.217"
```

First call only, install what's missing (quick when it's already there):

```
[ -x "$HYPERFRAMES_PYTHON" ] || { uv venv -q ~/.cache/diffusion/tts && uv pip install -q --python "$HYPERFRAMES_PYTHON" kokoro-onnx soundfile; }
$HF browser ensure
npx --yes -p hyperframes@0.8.217 -c 'echo $(dirname $(dirname $(readlink -f $(command -v hyperframes))))/dist/skills/hyperframes'
```

The last line prints where HyperFrames keeps its own guidance. Read `references/types/explainer.md` and
`references/motion.md` there before writing the video; `SKILL.md` and `references/format.md` when something
doesn't render. Skip its steps that stop to ask the user.

It needs Node 22+, ffmpeg and uv. If one is missing, tell the user which and stop.

## Steps

1. **Read the change.** For a PR, `gh pr view TARGET --json title,body,commits,files` and `gh pr diff TARGET`
   (if `gh pr view` fails, `gh api repos/OWNER/REPO/pulls/N` gives the same); for a branch, `git log` and
   `git diff` against the default branch. Skip lockfiles and generated files. Read surrounding code when you
   need it to draw the system accurately.
2. **Find the story.** Pick the one idea a reviewer must leave with, and the picture that explains it: usually
   a diagram of the parts the PR touches, with one concrete thing (a request, an event, a file) moving through
   it before and after the change. Then the code that makes the difference, then what to double-check.
3. **Write the narration** as segments of about 20 words (9 s), one idea each, written so each thing on screen
   has a word to appear on. A small PR is 3–5 segments, a large one up to 10.
4. **Set up the folder.** Copy `example/` from this skill to `~/.cache/diffusion/videos/<repo>-<number or branch>/`
   and work inside it. Vendor GSAP once: `npm pack gsap@3.14.2 --pack-destination /tmp`, then
   `tar -xzf /tmp/gsap-3.14.2.tgz -C /tmp && mkdir -p assets && cp /tmp/package/dist/gsap.min.js assets/`.
5. **Speak it.** For each segment N, from 0: `$HF tts "<segment>" -v am_michael -o assets/vo-N.wav --json`,
   and note `durationSeconds`.
6. **Animate it** in `index.html`. The example is one continuous stage driven by one timeline, with helpers
   for timing moves to spoken words, captions, syntax colors and drawing lines; its comment explains the
   wiring. Keep the helpers and replace everything else with this PR's own picture and moves.
7. **Check and look.** `$HF check` and fix every error; `nested_structure_needs_subcomposition` is expected.
   Then `$HF snapshot --review` and look at the contact sheet. Fix anything cramped, empty or out of order.
8. **Render** with `$HF render -o <repo>-<number>.mp4 --quiet` and give the user the file path.

## Rules

- Show one thing at a time. Each element appears when the voice names it, and things that stay on screen
  move, grow or transform into the next idea rather than cutting away.
- Code on screen is real lines from the diff, 4–12 per view, never a whole file. An excerpt may drop lines in
  the middle if a `⋯` line marks the gap. Text stays at 28px or larger, never clipped (about 80 characters of
  code fit at 30px).
- Diagrams show only what the PR and the code it touches show. Don't guess at motivation the PR doesn't
  state, and don't present tests or refactors as features.
- Speak names, not `@handles` or file paths; paths go on screen. Keep Diffusion's colors and fonts.
