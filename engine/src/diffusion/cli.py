from __future__ import annotations

import asyncio
import dataclasses
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path

import typer

from .config import Config, ConfigError, load_config

app = typer.Typer(no_args_is_help=True, add_completion=False)
ProfileOpt = typer.Option(
    None, "--profile", "-p", help="Config profile (default: config file, then auto-detect)."
)
BackendOpt = typer.Option(
    None,
    "--backend",
    help="Pin the model backend to claude-code or codex, using that CLI's own login, in place of the "
    "config default and auto-detection.",
)


@app.callback()
def main() -> None:
    """Turn a pull request (or a local branch) into a guided, linked review walkthrough."""


def _config(profile: str | None, backend: str | None = None) -> Config:
    try:
        return load_config(profile=profile, backend=backend)
    except ConfigError as e:
        typer.secho(str(e), fg="red", err=True)
        raise typer.Exit(1) from e


def _err(msg: str) -> None:
    typer.secho(msg, err=True, dim=True)


def _cli_version(path: str | None) -> str:
    if not path:
        return ""
    try:
        return subprocess.run([path, "--version"], capture_output=True, text=True, timeout=20).stdout.strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return f"unusable: {e}"


def resolve_target(target: str | None, base: str | None, head: str | None) -> str:
    """A PR URL / ``local:`` target as-is; otherwise a repo directory (default: cwd) in local mode."""
    from .pipeline import local_target

    if target and ("/pull/" in target or target.startswith("local:")):
        return target
    repo = Path(target).expanduser() if target else Path.cwd()
    if not repo.is_dir():
        raise typer.BadParameter(f"{target!r} is neither a PR URL nor a directory")
    return local_target(repo, base, head)


async def _run_guide(cfg: Config, prep, model: str, quiet: bool = False):
    from .agent import DoneEvent, ToolEvent, make_runner
    from .guide_agent import GuideDone, generate_guide

    done = None
    async for ev in generate_guide(
        prep.meta, prep.checkout, prep.index, make_runner(cfg), model, cfg.max_turns
    ):
        if isinstance(ev, ToolEvent) and not quiet:
            _err(f"  · {ev.summary}")
        elif isinstance(ev, DoneEvent) and ev.is_error:
            _err(f"  ! agent error: {ev.result}")
        elif isinstance(ev, GuideDone):
            done = ev
    assert done is not None
    return done


@app.command()
def doctor(
    profile: str = ProfileOpt,
    ping: bool = typer.Option(True, help="Send a tiny request to each model."),
    eval_: bool = typer.Option(
        False, "--eval", help="Generate a guide for a built-in sample change and score its line references."
    ),
) -> None:
    """Show which backend and models will be used, and check that they work."""
    cfg = _config(profile)
    for k, v in cfg.describe():
        typer.echo(f"{k:<9} {v}")
    if cfg.backend != "api" and cfg.cli_path:
        typer.echo(f"{'version':<9} {_cli_version(cfg.cli_path) or '?'}")

    ok = asyncio.run(_ping(cfg)) if ping else True
    if eval_:
        ok = _eval(cfg) and ok
    if not ok:
        raise typer.Exit(1)


async def _ping(cfg: Config) -> bool:
    from .agent import AgentRequest, DoneEvent, make_runner

    runner, ok = make_runner(cfg), True
    with tempfile.TemporaryDirectory() as d:
        for model in dict.fromkeys([cfg.guide_model, cfg.chat_model]):
            t = time.monotonic()
            req = AgentRequest("Reply with exactly: ok", "ping", model, Path(d), max_turns=1)
            result: DoneEvent | None = None
            try:
                async for ev in runner(req):
                    if isinstance(ev, DoneEvent):
                        result = ev
            except Exception as e:  # surface any backend failure
                result = DoneEvent(0, None, True, None, f"{type(e).__name__}: {e}")
            label = model or "(default)"
            if result and not result.is_error:
                typer.secho(f"{'ping':<9} {label}  ok  {time.monotonic() - t:.1f}s", fg="green")
            else:
                ok = False
                typer.secho(
                    f"{'ping':<9} {label}  FAILED  {result.result if result else 'no response'}", fg="red"
                )
    return ok


def _eval(cfg: Config) -> bool:
    from .pipeline import local_target, prepare
    from .sample import CODE_FILES, build_sample_repo

    t = time.monotonic()
    with tempfile.TemporaryDirectory() as d:
        repo = Path(d) / "sample"
        build_sample_repo(repo)
        sub = dataclasses.replace(cfg, cache_dir=Path(d) / "cache")
        prep = prepare(sub, local_target(repo, "main", "feature"))
        try:
            done = asyncio.run(_run_guide(sub, prep, cfg.guide_model, quiet=True))
        except Exception as e:
            typer.secho(f"{'eval':<9} FAILED  {e}", fg="red")
            return False
    g, v = done.guide, done.guide.validation
    must = {h.id for f in prep.index.files if f.path in CODE_FILES for h in f.hunks}
    covered = {r.hunk for s in g.steps for r in s.refs} | {h for s in g.skippable for h in s.hunks}
    valid = v.total_refs - v.invalid_refs
    accuracy = valid / v.total_refs if v.total_refs else 0.0
    coverage = len(must & covered) / len(must)
    good = accuracy >= 0.9 and coverage == 1.0 and bool(g.steps)
    cost = f" · ${done.cost_usd:.3f}" if done.cost_usd else ""
    typer.secho(
        f"{'eval':<9} refs {valid}/{v.total_refs} valid ({accuracy:.0%}) · {v.clamped_refs} clamped · "
        f"coverage {coverage:.0%} · {len(g.steps)} steps · {done.attempts} attempt(s) · "
        f"{time.monotonic() - t:.0f}s{cost}",
        fg="green" if good else "yellow",
    )
    if not good:
        typer.secho(f"{'':<9} this model may produce unreliable guides", fg="yellow")
    return good


@app.command()
def guide(
    target: str = typer.Argument(
        None, help="PR URL, or a repository directory (default: current directory)."
    ),
    base: str = typer.Option(None, help="Local mode: base ref (default: origin/HEAD, main, or master)."),
    head: str = typer.Option(None, help="Local mode: head ref (default: HEAD)."),
    as_json: bool = typer.Option(False, "--json", help="Print the validated guide as JSON."),
    model: str = typer.Option(None, help="Override the guide model."),
    profile: str = ProfileOpt,
) -> None:
    """Generate a review guide for a PR, or for a local branch against its base."""
    from .pipeline import prepare

    cfg = _config(profile)
    t = time.monotonic()
    prep = prepare(cfg, resolve_target(target, base, head))
    m = prep.meta
    what = f"{m.head_ref} vs {m.base_ref}" if m.ref.is_local else f"{m.ref.slug}#{m.ref.number}"
    _err(f"prepared {what} @ {m.head_sha[:12]}: {len(prep.index.files)} files, {len(prep.index.hunks)} hunks")
    via = f"{cfg.backend}/{cfg.protocol}" if cfg.protocol else cfg.backend
    _err(f"using {cfg.profile} ({via}) · {model or cfg.guide_model or 'default model'}")

    done = asyncio.run(_run_guide(cfg, prep, model or cfg.guide_model))
    g, v = done.guide, done.guide.validation
    cost = f" · ${done.cost_usd:.2f}" if done.cost_usd else ""
    _err(
        f"done in {time.monotonic() - t:.0f}s · {done.turns} turns{cost} · attempts={done.attempts} · "
        f"refs {v.total_refs - v.invalid_refs}/{v.total_refs} valid, {v.clamped_refs} clamped · "
        f"uncovered={g.uncovered or 'none'}"
    )
    if as_json:
        typer.echo(json.dumps(g.model_dump(by_alias=True), indent=2))
        return
    typer.secho(g.tldr, bold=True)
    for c in g.context:
        typer.echo(f"  [{c.icon}] {c.text}")
    for s in g.steps:
        refs = ", ".join(r.hunk + (f":{r.start}-{r.end}" if r.start else "") for r in s.refs)
        typer.echo(f"{s.id}. ({s.kind}) {s.title}: {s.summary}  [{refs}]")
        for b in s.substeps:
            typer.echo(f"   {s.id}.{b.id} {b.title}: {b.summary}")
    for k in g.skippable:
        typer.echo(f"  skip {k.file} ({k.reason})")


@app.command()
def serve(
    port: int = typer.Option(8787, help="Port on 127.0.0.1."),
    profile: str = ProfileOpt,
    backend: str = BackendOpt,
    reload: bool = typer.Option(False, help="Auto-reload on code changes (dev)."),
) -> None:
    """Run the local web UI and API on 127.0.0.1."""
    import uvicorn

    cfg = _config(profile, backend)  # fail fast on bad config
    if profile:
        os.environ["DIFFUSION_PROFILE"] = profile
    if backend:
        os.environ["DIFFUSION_BACKEND"] = backend
    _err(f"using {cfg.profile} ({cfg.backend}) · http://127.0.0.1:{port}")
    uvicorn.run("diffusion.app:create_app", factory=True, host="127.0.0.1", port=port, reload=reload)


@app.command("open")
def open_(
    target: str = typer.Argument(
        None, help="PR URL, or a repository directory (default: current directory)."
    ),
    base: str = typer.Option(None, help="Local mode: base ref (default: origin/HEAD, main, or master)."),
    head: str = typer.Option(None, help="Local mode: head ref (default: HEAD)."),
    port: int = typer.Option(8787, help="First port to try on 127.0.0.1."),
    browser: bool = typer.Option(True, help="Open a browser (skipped over SSH or with no display)."),
    profile: str = ProfileOpt,
    backend: str = BackendOpt,
) -> None:
    """Open a review in the browser, starting the web UI in the background if it isn't running."""
    import webbrowser

    from .github import GitHubError, parse_pr_url
    from .launcher import LaunchError, can_open_browser, find_or_start

    cfg = _config(profile, backend)  # fail fast on bad config, before starting anything
    resolved = resolve_target(target, base, head)
    if not resolved.startswith("local:"):
        try:
            parse_pr_url(resolved)
        except GitHubError as e:
            raise typer.BadParameter(str(e)) from e
    try:
        server = find_or_start(port, cfg.cache_dir / "logs", backend, profile)
    except LaunchError as e:
        typer.secho(str(e), fg="red", err=True)
        raise typer.Exit(1) from e

    url = server.review_url(resolved)
    how = f"started in the background (logs: {server.log})" if server.started else "already running"
    typer.echo(f"Diffusion: {url}")
    typer.echo(f"Server on port {server.port}, {how}; backend {server.backend}.")
    if browser and can_open_browser() and webbrowser.open(url):
        typer.echo("Opened in your browser; the guide starts generating there.")
    else:
        typer.echo("Open the link above in a browser; the guide starts generating when the page loads.")


if __name__ == "__main__":
    app()
