---
description: Open a guided review of a pull request, or of the current branch, in Diffusion.
argument-hint: "[PR URL | repository directory]"
allowed-tools: Bash(uvx:*)
disable-model-invocation: true
---

## Diffusion

!`uvx --from diffusion-review diffusion open --backend claude-code $ARGUMENTS`

## Your task

Diffusion was launched above. Tell the user, in one or two lines, the review link it printed and that the guide
generates in the browser. Don't open, fetch or summarize the link yourself.

- If the output says `uvx` was not found, Diffusion needs uv. Tell the user to install it
  (`curl -LsSf https://astral.sh/uv/install.sh | sh` on macOS or Linux, or see https://docs.astral.sh/uv/) and
  run `/diffusion:review` again.
- For any other error, quote the error lines and stop. Don't retry with other arguments or install anything.
