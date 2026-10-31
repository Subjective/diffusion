# Configuration

Nothing needs configuring. Guides are written by the coding agent you ask for a review (Claude Code, Codex or
Cursor), with its own tools and login. Chat in the browser runs on that same agent's CLI:

- **Claude Code** and **Codex**: chat continues from a fork of the session that wrote the guide, so it starts out
  knowing everything the agent read. The session itself is left untouched.
- **Cursor**: its CLI can't fork a session, so chat starts a fresh one, seeded with the guide and what you told
  the agent you care about. Cursor needs the [`cursor-agent` CLI](https://cursor.com/cli) signed in.

A guide submitted outside an agent (from your own shell) is chatted about with the first of `claude`, `codex` or
`cursor-agent` on `PATH`, falling back to the Claude Code that ships with the Claude Agent SDK.

## Environment overrides

| Variable | Meaning |
|---|---|
| `DIFFUSION_CACHE_DIR` | where checkouts, guides and chats are kept (default `~/.cache/diffusion`) |
| `DIFFUSION_CHAT_MODEL` | the model chat asks the agent CLI for (default: `sonnet` for Claude Code, `auto` for Cursor, Codex's configured default) |
| `DIFFUSION_CLI` | the agent CLI to run for chat, e.g. a wrapper script or your installed `claude` instead of the bundled one |

Provider settings your agent already uses (`CLAUDE_CODE_USE_BEDROCK`, `~/.codex/config.toml`, a gateway's
`ANTHROPIC_BASE_URL`, …) apply to chat too, because chat runs the same CLI.

## Updating

The plugin runs the latest `diffusion-review` from PyPI through `uvx`. If it keeps an older one, run
`uv cache clean diffusion-review`.
