# Configuration

With no config file, Diffusion uses the first of these it finds: `ANTHROPIC_API_KEY`; `ANTHROPIC_AUTH_TOKEN` with
`ANTHROPIC_BASE_URL` (a gateway with bearer auth); `OPENROUTER_API_KEY`; `OPENAI_API_KEY` with optional
`OPENAI_BASE_URL`; a `claude` CLI on `PATH`; a `codex` CLI on `PATH`. Run `diffusion doctor` to see which.

`/diffusion:review` always uses your Claude Code login, even when an API key is set.

## Profiles

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
guide_model = "anthropic/claude-opus-5.5"    # a strong model for guides
chat_model = "anthropic/claude-sonnet-5.5"   # a faster one for chat

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

## Reusing a Claude Code gateway

If Claude Code on your machine already talks to a gateway, point a profile at its settings files instead of copying
secrets:

```toml
[profiles.gateway]
backend = "api"
protocol = "anthropic"
auth = "bearer"
api_key_env = "ANTHROPIC_AUTH_TOKEN"
inherit_env_from = ["~/.claude/settings.json", "/etc/claude-code/managed-settings.json"]
guide_model = "claude-opus-5-5"
chat_model = "claude-sonnet-5-5"
```

The same `inherit_env_from` works with `backend = "claude-code"`. If your gateway requires a recent Claude Code,
set `cli_path = "claude"` to use your installed CLI instead of the SDK's bundled one.

## Checking a model

Guides need tool calling, a context window of ~64k tokens or more, and accurate line references. Score any profile
on a built-in sample change:

```bash
uv run diffusion doctor --profile local --eval
# eval      refs 11/11 valid (100%) · 0 clamped · coverage 100% · 3 steps · 1 attempt(s) · 12s
```

## Updating

The plugin runs the latest `diffusion-review` from PyPI through `uvx`. If it keeps an older one, run
`uv cache clean diffusion-review`.
