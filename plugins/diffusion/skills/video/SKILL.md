---
name: video
description: Make a short narrated explainer video of a pull request, or of the current branch, for reviewers.
argument-hint: "[PR URL | repository directory]"
allowed-tools: Bash(npx:*), Bash(npm:*), Bash(uv:*), Bash(gh:*), Bash(git:*), Bash(ffprobe:*), Bash(ffmpeg:*)
disable-model-invocation: true
---

# PR video

Make a short narrated video that walks a reviewer through the change: what it does, why, and the few pieces of
code that matter. It should feel like the author explaining the PR to a colleague, not a reading of the diff.

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
```

It needs Node 22+, ffmpeg and uv. If one is missing, tell the user which and stop.

## Steps

1. **Read the change.** For a PR, `gh pr view TARGET --json title,body,commits,files` and `gh pr diff TARGET`
   (if `gh pr view` fails, `gh api repos/OWNER/REPO/pulls/N` gives the same); for a branch, `git log` and
   `git diff` against the default branch. Skip lockfiles and generated files.
2. **Write the narration** as segments of about 20 words (9 s), one idea each. Open on what changes, then why,
   then the code, then anything a reviewer should double-check. A small PR is 3–4 segments (about 30–45 s), a
   large one up to 10 (about 90 s).
3. **Set up the folder.** Copy `example/` from this skill to `~/.cache/diffusion/videos/<repo>-<number or branch>/`
   and work inside it. Vendor GSAP once: `npm pack gsap@3.14.2 --pack-destination /tmp`, then
   `tar -xzf /tmp/gsap-3.14.2.tgz -C /tmp && mkdir -p assets && cp /tmp/package/dist/gsap.min.js assets/`.
4. **Speak it.** For each segment N, from 0: `$HF tts "<segment>" -v am_michael -o assets/vo-N.wav --json`,
   and note `durationSeconds`.
5. **Build the scenes** in `index.html`, one `<section>` per segment, following the comment in the example for
   durations, audio tags and reveal times. Reveal things as the voice names them, not all at once. Layout,
   emphasis and scene types are yours to choose; keep Diffusion's colors and fonts.
6. **Check and look.** `$HF check` and fix every error. `nested_structure_needs_subcomposition` and
   `timeline_track_too_dense` are expected. Then `$HF snapshot --review` and look at the contact sheet.
7. **Render** with `$HF render -o <repo>-<number>.mp4 --quiet` and give the user the file path.

## Rules

- Code on screen is real lines from the diff, 4–12 per scene, never a whole file. Use 1–4 code scenes. An
  excerpt may drop lines in the middle (a docstring, say) if a `⋯` line marks the gap.
- Code stays at 28px or larger and is never clipped: about 80 characters fit at 30px. For longer lines, pick
  a different excerpt or wrap the line by hand.
- Say only what the diff and PR show. Don't guess at motivation the PR doesn't state, and don't present tests
  or refactors as features.
- Speak names, not `@handles` or file paths; paths go on screen.
