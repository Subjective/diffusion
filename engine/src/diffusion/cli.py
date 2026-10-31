from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import typer

from .config import Config, detect_harness, harness_session, load_config

app = typer.Typer(no_args_is_help=True, add_completion=False)
TargetArg = typer.Argument(None, help="PR URL, or a repository directory (default: current directory).")
BaseOpt = typer.Option(None, help="Local mode: base ref (default: origin/HEAD, main, or master).")
HeadOpt = typer.Option(None, help="Local mode: head ref (default: HEAD).")
UncommittedOpt = typer.Option(
    False, "--uncommitted", help="Local mode: review the working tree, uncommitted changes included."
)
PortOpt = typer.Option(8787, help="First port to try on 127.0.0.1.")
BrowserOpt = typer.Option(True, help="Open a browser (skipped over SSH or with no display).")


@app.callback()
def main() -> None:
    """Guided, linked review walkthroughs of a pull request or local branch, written by your coding agent."""


def _err(msg: str) -> None:
    typer.secho(msg, err=True, dim=True)


def _fail(msg: str) -> typer.Exit:
    typer.secho(msg, fg="red", err=True)
    return typer.Exit(1)


def resolve_target(target: str | None, base: str | None, head: str | None, uncommitted: bool = False) -> str:
    """A PR URL / ``local:`` target as-is; otherwise a repo directory (default: cwd) in local mode."""
    from .github import GitHubError, parse_pr_url
    from .pipeline import WORKTREE, local_target

    if target and target.startswith("local:"):
        return target
    if target and "/pull/" in target:
        try:
            parse_pr_url(target)
        except GitHubError as e:
            raise typer.BadParameter(str(e)) from e
        return target
    repo = Path(target).expanduser() if target else Path.cwd()
    if not repo.is_dir():
        raise typer.BadParameter(f"{target!r} is neither a PR URL nor a directory")
    return local_target(repo, base, WORKTREE if uncommitted else head)


def _prepare(cfg: Config, target: str, fresh: bool = False):
    from .github import GitHubError
    from .pipeline import prepare
    from .repo import RepoError

    try:
        return prepare(cfg, target, fresh=fresh)
    except (GitHubError, RepoError) as e:
        raise _fail(str(e)) from e


def _open_browser(cfg: Config, target: str, port: int, browser: bool, version: int | None = None) -> None:
    import webbrowser

    from .launcher import LaunchError, can_open_browser, find_or_start

    try:
        server = find_or_start(port, cfg.cache_dir / "logs")
    except LaunchError as e:
        raise _fail(str(e)) from e
    url = server.review_url(target, version)
    typer.echo(f"Diffusion: {url}")
    if server.started:
        _err(f"Server started in the background on port {server.port} (logs: {server.log}).")
    if browser and can_open_browser() and webbrowser.open(url):
        _err("Opened in your browser.")


@app.command()
def submit(
    guide: str = typer.Argument(
        ..., help="The guide JSON your agent wrote (see schema.json), or - for stdin."
    ),
    target: str = TargetArg,
    base: str = BaseOpt,
    head: str = HeadOpt,
    uncommitted: bool = UncommittedOpt,
    allow_issues: bool = typer.Option(
        False,
        "--allow-issues",
        help="Save the guide even if some refs don't match the diff (they're dropped).",
    ),
    port: int = PortOpt,
    browser: bool = BrowserOpt,
) -> None:
    """Check a guide against the diff, save it as a new version, and open it in the browser.

    If a ref doesn't match the diff, or a change in scope isn't covered, nothing is saved: the problems are
    printed, and the exit code is 1."""
    from .store import Store
    from .validate import DraftError, check, feedback

    cfg = load_config()
    resolved = resolve_target(target, base, head, uncommitted)
    try:
        raw = sys.stdin.read() if guide == "-" else Path(guide).read_text()
    except OSError as e:
        raise _fail(f"Couldn't read {guide}: {e}") from e
    prep = _prepare(cfg, resolved, fresh=True)
    try:
        draft, g = check(raw, prep.index)
    except DraftError as e:
        raise _fail(str(e)) from e
    problems = feedback(g, prep.index)
    if problems and not allow_issues:
        typer.echo(problems, err=True)
        raise _fail("Nothing saved: fix these and submit the whole guide again.")

    harness = detect_harness(dict(os.environ))
    record = {
        **g.model_dump(by_alias=True),
        "meta": {
            "head_sha": prep.meta.head_sha,
            "source": "agent",
            "harness": harness,
            "session": harness_session(harness, dict(os.environ)),
            "cwd": os.getcwd(),
            "created_at": time.time(),
        },
    }
    store = Store(cfg.cache_dir)
    n = store.save_guide(prep.meta.ref.key, prep.meta.head_sha, record, draft.model_dump(by_alias=True))
    v = g.validation
    _err(
        f"Saved version {n}: {len(g.steps)} steps, refs {v.total_refs - v.invalid_refs}/{v.total_refs} valid"
        + (f", {len(g.uncovered)} changes uncovered" if g.uncovered else "")
    )
    _open_browser(cfg, resolved, port, browser, n)


@app.command("open")
def open_(
    target: str = TargetArg,
    base: str = BaseOpt,
    head: str = HeadOpt,
    uncommitted: bool = UncommittedOpt,
    port: int = PortOpt,
    browser: bool = BrowserOpt,
) -> None:
    """Open a review in the browser, starting Diffusion in the background if it isn't running.

    Prints where the latest guide's draft is, for an agent to edit and submit as the next version."""
    from .store import Store

    cfg = load_config()
    resolved = resolve_target(target, base, head, uncommitted)
    prep = _prepare(cfg, resolved)
    store = Store(cfg.cache_dir)
    versions = store.list_guides(prep.meta.ref.key, prep.meta.head_sha)
    if versions:
        n = versions[-1]["version"]
        _err(
            f"Latest guide: version {n}, draft at {store.draft_path(prep.meta.ref.key, prep.meta.head_sha, n)}"
        )
    else:
        _err("No guide yet: write one and run `diffusion submit`.")
    _open_browser(cfg, resolved, port, browser)


@app.command()
def serve(
    port: int = typer.Option(8787, help="Port on 127.0.0.1."),
    reload: bool = typer.Option(False, help="Auto-reload on code changes (dev)."),
) -> None:
    """Run the local web UI and API on 127.0.0.1."""
    import uvicorn

    _err(f"Diffusion on http://127.0.0.1:{port}")
    uvicorn.run("diffusion.app:create_app", factory=True, host="127.0.0.1", port=port, reload=reload)


@app.command(hidden=True)
def schema() -> None:
    """Print the JSON schema of a guide, as an agent writes it."""
    import json

    from .schema import GuideDraft

    typer.echo(json.dumps(GuideDraft.model_json_schema(by_alias=True), indent=2))


if __name__ == "__main__":
    app()
