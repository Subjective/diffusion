# Diffusion

AI has made it cheaper than ever to write code, but that's only shifted the burden to reviewing it, which is still
largely done the same way it always has been.

Diffusion turns pull requests into guided, interactive walkthroughs that help you understand what changed, how it
works, and why.

See [`docs/design.md`](docs/design.md) for the design and [`docs/design/wireframe.html`](docs/design/wireframe.html)
for the UI reference.

## How it works

- **`engine/`**: a local Python service. For a PR it reads metadata (`gh`, or `GITHUB_TOKEN`) and checks out the
  head in a cached worktree; for a local branch it uses your repo. It splits the diff into stable hunks and runs
  an agent with read-only tools that produces the guide. Every reference is validated against the diff. It also
  powers the chat. HTTP + SSE API.
- **`web/`**: a React UI: the diff, the guide with live links, and the chat.
- **Backends**: `api` (our own agent loop over the Anthropic or any OpenAI-compatible API), `claude-code` (the
  Claude Agent SDK and your Claude Code CLI), or `codex` (the Codex CLI).

## Prerequisites

- **Model access**, any one of: `ANTHROPIC_API_KEY`; `OPENAI_API_KEY`; `OPENROUTER_API_KEY`; a gateway or local
  server; a signed-in `claude` or `codex` CLI. See [Configuration](#configuration).
- **git**, and for GitHub PRs either `gh` signed in (`gh auth status`) or a `GITHUB_TOKEN` (required for private
  repos). Local mode needs neither.
- **`uv`** (Python 3.12+). **Node 24+** only if you build the UI yourself.

## Run

```bash
make install        # uv sync + npm install
cd engine && uv run diffusion doctor   # what it will use; pings the models
```

Single port (build the UI, serve it from the engine):

```bash
make build
make serve          # http://127.0.0.1:8787
```

Then paste a PR URL into the top bar, or `local:/path/to/repo#main..my-branch` for a local branch (base and head
are optional: `local:/path/to/repo` compares the current branch with `origin/HEAD`, `main` or `master`).

Development, with hot reload (two processes; the Vite dev server proxies `/api`):

```bash
make dev            # engine on :8787, web on :5173
# open http://localhost:5173
```

`make wheel` builds a self-contained package with the UI included (`dist/diffusion_review-*.whl`); install it with
`pip install` or `uv tool install` and run `diffusion serve` with no Node or checkout.

## CLI

```bash
cd engine
uv run diffusion doctor [--profile P]           # resolved backend, models, key source; pings each model
uv run diffusion doctor --eval                  # score the model on a built-in sample change
uv run diffusion guide <pr-url>                 # generate a guide for a PR, print it
uv run diffusion guide <repo-dir> --base main   # a local branch (default dir: current, head: HEAD)
uv run diffusion guide <target> --json          # the validated guide as JSON
uv run diffusion serve [--port N] [--profile P] # web UI + API
```

## Configuration

With no config file, the first of these is used: `ANTHROPIC_API_KEY`; `ANTHROPIC_AUTH_TOKEN` with
`ANTHROPIC_BASE_URL` (a gateway with bearer auth); `OPENROUTER_API_KEY`; `OPENAI_API_KEY` with optional
`OPENAI_BASE_URL`; a `claude` CLI on `PATH`; a `codex` CLI on `PATH`.

For anything else, add profiles to `~/.config/diffusion/config.toml` (or `$DIFFUSION_CONFIG`) and choose one with
`default`, `--profile`, or `DIFFUSION_PROFILE`:

```toml
default = "openrouter"

# Any OpenAI-compatible API: OpenAI, OpenRouter, Gemini, Ollama, vLLM, LiteLLM, other gateways
[profiles.openrouter]
backend = "api"
protocol = "openai"
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"
guide_model = "anthropic/claude-opus-4.6"    # a strong model for guides
chat_model = "anthropic/claude-sonnet-4.6"   # a faster one for chat

[profiles.local]
backend = "api"
protocol = "openai"
base_url = "http://localhost:11434/v1"       # e.g. Ollama
no_key = true
guide_model = "qwen3-coder:30b"
chat_model = "qwen3-coder:30b"

# Anthropic Messages API, directly or through a gateway
[profiles.anthropic]
backend = "api"
protocol = "anthropic"
api_key_cmd = "op read op://dev/anthropic/key"   # or: api_key_env = "ANTHROPIC_API_KEY"

# Your Claude Code setup (API key, Bedrock, Vertex, a gateway, or your login)
[profiles.claude]
backend = "claude-code"
guide_model = "opus"
chat_model = "sonnet"

# Your Codex setup (API key, login, or any provider in ~/.codex/config.toml)
[profiles.codex]
backend = "codex"
```

| Key | Backends | Meaning |
|---|---|---|
| `backend` | all | `api` (default), `claude-code`, or `codex` |
| `protocol` | api | `anthropic` (default) or `openai` |
| `base_url` | api | API base URL (default: the provider's public API) |
| `api_key_env` | api | env var, or list of env vars, holding the key |
| `api_key_cmd` | api | command that prints the key (password managers, secret stores) |
| `auth` | api | `x-api-key` or `bearer` (default: `x-api-key` for Anthropic, `bearer` for OpenAI) |
| `headers` | api | extra HTTP headers, e.g. OpenRouter's `HTTP-Referer` |
| `no_key` | api | allow no key (local servers) |
| `guide_model`, `chat_model` | all | model names as the backend expects them |
| `cli_path` | claude-code, codex | CLI to run (default: the SDK's bundled Claude Code / `codex` on `PATH`) |
| `env` | claude-code, codex | extra environment for the CLI, e.g. `{ CLAUDE_CODE_USE_BEDROCK = "1" }` |
| `inherit_env_from` | all | JSON files whose `env` table supplies variables (earlier files win) |
| `max_turns` | all | agent turn limit (default 40) |

Environment overrides: `DIFFUSION_PROFILE`, `DIFFUSION_GUIDE_MODEL`, `DIFFUSION_CHAT_MODEL`, `DIFFUSION_CLI`,
`DIFFUSION_CACHE_DIR`, `DIFFUSION_CONFIG`.

## FAQ

### Can I reuse my existing Claude Code setup?

If Claude Code on your machine already talks to a gateway (base URL and
token in its settings files), point a profile at those files instead of copying secrets:

```toml
[profiles.gateway]
backend = "api"
protocol = "anthropic"
auth = "bearer"
api_key_env = "ANTHROPIC_AUTH_TOKEN"
inherit_env_from = ["~/.claude/settings.json", "/etc/claude-code/managed-settings.json"]
guide_model = "claude-opus-4-6"
chat_model = "claude-sonnet-4-6"
```

The same `inherit_env_from` works with `backend = "claude-code"`. If your gateway requires a recent Claude Code,
set `cli_path = "claude"` to use your installed CLI instead of the SDK's bundled one.

### Is my model good enough?

Guides need tool calling, a context window of ~64k tokens or more, and accurate line
references. Check any profile against a built-in sample change:

```bash
uv run diffusion doctor --profile local --eval
# eval      refs 11/11 valid (100%) · 0 clamped · coverage 100% · 3 steps · 1 attempt(s) · 12s
```

Invalid references are always dropped or retried before you see them, but a weaker model produces thinner guides.

### Can I use my Claude or ChatGPT subscription?

The `claude-code` and `codex` backends drive your installed CLI with whatever login it has.

## Develop

```bash
make test           # engine: ruff + pyright + pytest   |   web: biome + tsc + vitest
make fmt            # ruff and biome: format + autofix
cd engine && uv run pytest -m live   # tests that call your configured backend (skipped by default)
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
