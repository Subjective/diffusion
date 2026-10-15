# Upstream

Vendored from [warpdotdev/common-skills](https://github.com/warpdotdev/common-skills),
path `.agents/skills/write-pr-description`, commit
`7c4eb852de8d7c3e68c81802e1c59db9a611f914` (2026-10-09). MIT licensed; see `LICENSE`.

`SKILL.md` and `references/` are copied unchanged. The upstream `evals/evals.json` is
left out because every eval points at private Warp repositories.

Notes for this repository:

- `SKILL.md` mentions a `create-pr` skill. That skill is not vendored here.
- The `gh` commands in step 1 assume the GitHub CLI. Cloud sessions without `gh` can get
  the same commits, files, and diff from the GitHub MCP tools.

To update, copy the same paths from a newer upstream commit and change the hash above.
