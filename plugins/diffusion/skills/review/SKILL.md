---
name: review
description: Open a guided review of a pull request, or of the current branch, in Diffusion.
argument-hint: "[PR URL | repository directory]"
allowed-tools: Bash(uvx:*)
disable-model-invocation: true
---

# Diffusion

Run this from the current directory, with the user's PR URL or repository directory in place of `TARGET`
(drop it to review the current branch):

```
uvx --from diffusion-review diffusion open TARGET
```

It needs network access and starts a local server that keeps running, so if your shell is sandboxed, run it
outside the sandbox. The guide is generated with your own agent's CLI and login.

Then tell the user, in one or two lines, the review link it printed and that the guide generates in the
browser. Don't open, fetch or summarize the link yourself.

- If `uvx` was not found, Diffusion needs uv. Tell the user to install it
  (`curl -LsSf https://astral.sh/uv/install.sh | sh` on macOS or Linux, or see https://docs.astral.sh/uv/) and
  try again.
- For any other error, quote the error lines and stop. Don't retry with other arguments or install anything.
