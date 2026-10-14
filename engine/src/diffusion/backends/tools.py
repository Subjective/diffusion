"""Read-only repository tools for the ``api`` backend, confined to the repository root."""

from __future__ import annotations

import fnmatch
import os
import re
import shutil
import subprocess
from pathlib import Path

from ..agent import SandboxError, ToolSpec, within

MAX_READ_LINES = 400
MAX_GREP_MATCHES = 200
MAX_GLOB = 300
MAX_OUT_CHARS = 60_000
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".mypy_cache", ".tox"}


def _cap(text: str) -> str:
    return text if len(text) <= MAX_OUT_CHARS else text[:MAX_OUT_CHARS] + "\n… (truncated)"


def _rel(root: Path, p: Path) -> str:
    return str(p.relative_to(root.resolve())) or "."


def read_file(root: Path, path: str, offset: int = 1, limit: int = MAX_READ_LINES) -> str:
    p = within(root, path)
    if not p.is_file():
        raise SandboxError(f"{path}: not a file")
    try:
        lines = p.read_text(errors="replace").splitlines()
    except OSError as e:
        raise SandboxError(f"{path}: {e}") from e
    offset = max(1, int(offset or 1))
    limit = max(1, min(int(limit or MAX_READ_LINES), MAX_READ_LINES))
    chunk = lines[offset - 1 : offset - 1 + limit]
    body = "\n".join(f"{i:>6}\t{ln}" for i, ln in enumerate(chunk, start=offset))
    more = (
        f"\n… ({len(lines) - (offset - 1 + len(chunk))} more lines; use offset)"
        if offset - 1 + len(chunk) < len(lines)
        else ""
    )
    return _cap(f"{_rel(root, p)} ({len(lines)} lines)\n{body}{more}")


def _walk(root: Path, base: Path):
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for f in filenames:
            yield Path(dirpath) / f


def glob(root: Path, pattern: str, path: str = ".") -> str:
    if pattern.startswith(("/", "~")) or ".." in Path(pattern).parts:
        raise SandboxError("glob patterns must be relative to the repository")
    base = within(root, path)
    rroot = root.resolve()
    hits = []
    for f in _walk(rroot, base):
        rel = str(f.relative_to(base))
        if fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(f.name, pattern):
            hits.append(_rel(rroot, f))
            if len(hits) >= MAX_GLOB:
                break
    hits.sort()
    suffix = f"\n… (first {MAX_GLOB})" if len(hits) >= MAX_GLOB else ""
    return "\n".join(hits) + suffix if hits else "(no matches)"


def grep(
    root: Path, pattern: str, path: str = ".", glob_pat: str | None = None, ignore_case: bool = False
) -> str:
    base = within(root, path)
    rroot = root.resolve()
    rg = shutil.which("rg")
    if rg:
        cmd = [rg, "--line-number", "--no-heading", "--color=never", "--max-count=50", "--no-follow"]
        cmd += [arg for d in sorted(SKIP_DIRS) for arg in ("--glob", f"!{d}/")]
        cmd += ["-e", pattern]
        if ignore_case:
            cmd.append("-i")
        if glob_pat:
            cmd += ["--glob", glob_pat]
        cmd.append(str(base))
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if out.returncode not in (0, 1):
            raise SandboxError(out.stderr.strip() or "grep failed")
        lines = [ln.replace(str(rroot) + os.sep, "", 1) for ln in out.stdout.splitlines()]
    else:
        try:
            rx = re.compile(pattern, re.IGNORECASE if ignore_case else 0)
        except re.error as e:
            raise SandboxError(f"bad regex: {e}") from e
        lines = []
        files = [base] if base.is_file() else _walk(rroot, base)
        for f in files:
            if glob_pat and not fnmatch.fnmatch(f.name, glob_pat):
                continue
            try:
                for i, ln in enumerate(f.read_text(errors="ignore").splitlines(), 1):
                    if rx.search(ln):
                        lines.append(f"{_rel(rroot, f)}:{i}:{ln}")
                        if len(lines) >= MAX_GREP_MATCHES:
                            break
            except OSError:
                continue
            if len(lines) >= MAX_GREP_MATCHES:
                break
    if not lines:
        return "(no matches)"
    more = f"\n… (first {MAX_GREP_MATCHES})" if len(lines) > MAX_GREP_MATCHES else ""
    return _cap("\n".join(lines[:MAX_GREP_MATCHES]) + more)


def repo_tools(root: Path) -> list[ToolSpec]:
    async def _read(a: dict) -> str:
        return read_file(root, a["path"], a.get("offset", 1), a.get("limit", MAX_READ_LINES))

    async def _grep(a: dict) -> str:
        return grep(root, a["pattern"], a.get("path", "."), a.get("glob"), bool(a.get("ignore_case")))

    async def _glob(a: dict) -> str:
        return glob(root, a["pattern"], a.get("path", "."))

    rel = {"type": "string", "description": "Path relative to the repository root."}
    return [
        ToolSpec(
            "read_file",
            f"Read a file in the repository, with line numbers. Up to {MAX_READ_LINES} lines per call.",
            {
                "type": "object",
                "properties": {
                    "path": rel,
                    "offset": {"type": "integer", "description": "1-based first line (default 1)."},
                    "limit": {"type": "integer", "description": f"Lines to read (max {MAX_READ_LINES})."},
                },
                "required": ["path"],
            },
            _read,
        ),
        ToolSpec(
            "grep",
            "Search file contents with a regular expression. Returns path:line:text.",
            {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regular expression."},
                    "path": {**rel, "description": "Directory or file to search (default: repository root)."},
                    "glob": {"type": "string", "description": "Only files matching this glob, e.g. '*.py'."},
                    "ignore_case": {"type": "boolean"},
                },
                "required": ["pattern"],
            },
            _grep,
        ),
        ToolSpec(
            "glob",
            "List repository files matching a glob pattern, e.g. 'src/**/*.ts' or '*.md'.",
            {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string"},
                    "path": {**rel, "description": "Base directory."},
                },
                "required": ["pattern"],
            },
            _glob,
        ),
    ]
