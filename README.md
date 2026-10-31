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

Your agent explores the change, writes the guide, and opens it in the browser. Say what you care about and it
shapes the guide around it: `/diffusion:review just the parser`, or `/diffusion:review my uncommitted changes`.
Ask it (or the chat next to the guide) to regroup steps or refocus, and the page switches to the new version;
earlier versions stay in its history.

For a short narrated, animated video of the change instead, run `/diffusion:video` the same way (`$diffusion:video`
in Codex). It renders locally with [HyperFrames](https://github.com/heygen-com/hyperframes) and a Kokoro voice, and
needs Node 22+, ffmpeg and uv.

## Prerequisites

- **Claude Code, Codex or Cursor**, signed in. Chat runs on the same agent; see [configuration](docs/configuration.md).
- **git**, and for GitHub PRs `gh` signed in or a `GITHUB_TOKEN`.
- **[`uv`](https://docs.astral.sh/uv/)**.

## Run from source

With Node 24+:

```bash
make install
make build
make serve          # http://127.0.0.1:8787
```

## CLI

The plugin's skill drives these; you rarely need them yourself.

```bash
cd engine
uv run diffusion submit GUIDE.json [target]   # check a guide against the diff, save it as a version, open it
uv run diffusion open [target]                # open a review; prints where the latest guide's JSON is
uv run diffusion serve                        # web UI + API
```

A target is a PR URL or a repository directory (default: the current directory), compared with its base;
`--base`/`--head` choose the refs, and `--uncommitted` includes work that isn't committed yet.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
