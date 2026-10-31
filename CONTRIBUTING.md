# Contributing

Thanks for helping. Bug reports, results from different agents and models, and pull requests are all welcome.

## Setup

You need `git`, [`uv`](https://docs.astral.sh/uv/) (Python 3.12+), and Node 24+ (pinned in `.node-version`).

```bash
make install        # engine deps (uv sync) + web deps (npm install)
make test           # what CI runs: ruff + pyright + pytest, biome + tsc + vitest
make dev            # engine on :8787 with auto-reload, Vite on :5173 (open this one)
make wheel          # a self-contained package with the UI included, in dist/
```

`make test` needs no model access or network: tests use fake agent CLIs and a generated sample repo, with `HOME`
isolated so your own caches and credentials are never read.

## Layout

```
engine/src/diffusion/
  pipeline.py, github.py, repo.py   targets (PR URL or local branch) → worktree + diff
  hunks.py, classify.py             stable hunk IDs; rule-based skippable files
  schema.py, validate.py            guide schema (as agents write it, and as the UI renders it); checking refs
  chat_agent.py                     chat prompt (prompts/chat.md) and turn handling
  agent.py                          agent-neutral Runner interface, events, sandbox helper
  backends/                         the agent CLIs chat runs on: claude_code, codex, cursor
  config.py                         which agent this runs under, and environment overrides
  app.py, store.py, cli.py          HTTP/SSE API, on-disk store (guide versions, chats), CLI
  launcher.py                       reuse or start a background server, open the browser
web/src/                            React UI (store.ts, chat.ts, ui.ts; components/; lib/)
docs/design.md                      design and functional spec
plugins/diffusion/                  the plugin: skills/review/ (SKILL.md, schema.json) writes guides
```

## Guidelines

- **Keep chat read-only.** Its tools must stay confined to the worktree (see `agent.within`), with no writes,
  no network beyond the model API, and no new shell access. PR content is untrusted input.
- **References must resolve.** Everything an agent submits that points at code goes through `validate.py`.
  New guide fields with refs need validation and tests there. Schema changes regenerate the skill's copy:
  `cd engine && uv run diffusion schema > ../plugins/diffusion/skills/review/schema.json` (a test checks it).
- **Backends implement `Runner`** (`agent.py`): take an `AgentRequest`, yield `ToolEvent`/`TextEvent`, end with
  one `DoneEvent`. Add a fake-driven test in `tests/test_backends.py`.
- **Skill and prompt changes** (`plugins/diffusion/skills/review/SKILL.md`, `prompts/chat.md`) can shift guide
  and answer quality. Try them on a real change with at least one agent, and say which in the PR.
- **UI changes** should keep the existing design language: neutral palette, hairline borders, icons over labels.
  `docs/design/wireframe.html` is the visual reference.
- Run `make fmt` before committing. Keep commits focused, with messages that explain why.

## Live tests

Tests marked `live` run chat on your installed Claude Code and are skipped by default:

```bash
cd engine && uv run pytest -m live
```

## Releasing

Bump `version` in `engine/pyproject.toml` (and in the `plugin.json` files under `plugins/diffusion/`), merge, then push
a matching tag: `git tag v0.2.0 && git push origin v0.2.0`. The `Release` workflow builds the wheel with the UI,
publishes it to PyPI as `diffusion-review` (trusted publishing, from the `pypi` environment), and attaches it to a
GitHub release.
