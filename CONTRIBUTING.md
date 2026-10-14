# Contributing

Thanks for helping. Bug reports, model/backend compatibility results, and pull requests are all welcome.

## Setup

You need `git`, [`uv`](https://docs.astral.sh/uv/) (Python 3.12+), and Node 20+.

```bash
make install        # engine deps (uv sync) + web deps (npm install)
make test           # what CI runs: ruff + pytest, tsc + vitest
make dev            # engine on :8787 with auto-reload, Vite on :5173 (open this one)
```

`make test` needs no model access or network: tests use fake runners, a scripted model, and a generated sample
repo, with `HOME` isolated so your own config and credentials are never read.

## Layout

```
engine/src/diffusion/
  pipeline.py, github.py, repo.py   targets (PR URL or local branch) → worktree + diff
  hunks.py, classify.py             stable hunk IDs; rule-based skippable files
  schema.py, validate.py            guide schema; reference validation and coverage
  guide_agent.py, chat_agent.py     prompts (prompts/*.md) and turn handling
  agent.py                          backend-neutral Runner interface, events, sandbox helper
  backends/                         api (own loop + providers + tools), claude_code, codex
  config.py                         profiles and auto-detection
  app.py, jobs.py, store.py, cli.py HTTP/SSE API, background jobs, on-disk store, CLI
web/src/                            React UI (store.ts, chat.ts, ui.ts; components/; lib/)
docs/design.md                      design and functional spec
```

## Guidelines

- **Keep the agent read-only.** Tools must stay confined to the worktree (see `agent.within`), with no writes,
  no network beyond the model API, and no new shell access. PR content is untrusted input.
- **References must resolve.** Anything the model returns that points at code goes through `validate.py`.
  New guide fields with refs need validation and tests there.
- **Backends implement `Runner`** (`agent.py`): take an `AgentRequest`, yield `ToolEvent`/`TextEvent`, end with
  one `DoneEvent`. Add a fake-driven test in `tests/test_backends.py`, and run `diffusion doctor --eval` against a
  real model before opening the PR.
- **Prompt changes** (`prompts/*.md`) can shift guide quality. Include `diffusion doctor --eval` output from at least
  one model, before and after.
- **UI changes** should keep the existing design language: neutral palette, hairline borders, icons over labels.
  `docs/design/wireframe.html` is the visual reference.
- Run `make fmt` before committing. Keep commits focused, with messages that explain why.

## Live tests

Tests marked `live` call a real backend from your config and are skipped by default:

```bash
cd engine && uv run pytest -m live
```

## Reporting model compatibility

`diffusion doctor --profile <p> --eval` prints a one-line score. Results for models and providers not yet covered
in the README are very useful: open an issue with the line, the model, and the backend/protocol.
