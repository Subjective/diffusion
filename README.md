# Diffusion

AI has made it cheaper than ever to write code, but that's only shifted the burden to reviewing it, which is still
largely done the same way it always has been.

Diffusion turns pull requests into guided, interactive walkthroughs that help you understand what changed, how it
works, and why.

## Demo

https://github.com/user-attachments/assets/1955089f-872b-4a9e-beda-c3bedfa6a1c0

## From your coding agent

Install the plugin once.

Claude Code:

```
/plugin marketplace add Subjective/diffusion
/plugin install diffusion@diffusion
```

Codex:

```
codex plugin marketplace add Subjective/diffusion
codex plugin add diffusion@diffusion
```

Cursor: `/add-plugin https://github.com/Subjective/diffusion` in Agent chat.

Then ask for a review, with a PR URL or nothing for the current branch:

```
/diffusion:review https://github.com/owner/repo/pull/123   # Claude Code
$diffusion:review https://github.com/owner/repo/pull/123   # Codex
/diffusion:review https://github.com/owner/repo/pull/123   # Cursor (Agent mode)
```

The guide is written by the agent you ran it from, on its own login.

For a short narrated, animated video of the change instead, run `/diffusion:video` the same way (`$diffusion:video`
in Codex). It renders locally with [HyperFrames](https://github.com/heygen-com/hyperframes) and a Kokoro voice, and
needs Node 22+, ffmpeg and uv.

## Prerequisites

- **Model access**: an Anthropic, OpenAI, or OpenRouter API key, or a signed-in Claude Code, Codex, or Cursor CLI. Gateways
  and local models work too; see [configuration](docs/configuration.md).
- **git**, and for GitHub PRs `gh` signed in or a `GITHUB_TOKEN`.
- **[`uv`](https://docs.astral.sh/uv/)**.

## Run from source

With Node 24+:

```bash
make install
make build
make serve          # http://127.0.0.1:8787
```

Paste a PR URL into the top bar, or `local:/path/to/repo` to review the current branch against its base
(`local:/path/to/repo#main..my-branch` to choose both).

## CLI

```bash
cd engine
uv run diffusion doctor                # which model it will use; pings it
uv run diffusion open [target]         # start or reuse the web UI and open a review
uv run diffusion guide <target>        # print a guide (--json for the raw guide)
uv run diffusion serve                 # web UI + API
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
