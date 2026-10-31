"""Split a unified diff into files and hunks with stable IDs.

Hunk IDs (``H1..Hn``) are assigned in diff order, which is deterministic for a given merge-base/head pair,
so the refs a guide makes against them can be checked exactly.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

from unidiff.patch import PatchSet

LineType = Literal["add", "del", "ctx"]


@dataclass
class Line:
    type: LineType
    old: int | None
    new: int | None
    text: str


@dataclass
class Hunk:
    id: str
    file: str
    old_start: int
    old_len: int
    new_start: int
    new_len: int
    symbol: str
    lines: list[Line]

    @property
    def new_end(self) -> int:
        return self.new_start + max(self.new_len, 1) - 1

    @property
    def old_end(self) -> int:
        return self.old_start + max(self.old_len, 1) - 1

    @property
    def additions(self) -> int:
        return sum(ln.type == "add" for ln in self.lines)

    @property
    def deletions(self) -> int:
        return sum(ln.type == "del" for ln in self.lines)

    def annotated(self) -> str:
        """Hunk text with line numbers, as shown to the model."""
        head = (
            f"[{self.id}] {self.file} @@ -{self.old_start},{self.old_len} +{self.new_start},{self.new_len} @@"
        )
        if self.symbol:
            head += f" {self.symbol}"
        out = [head]
        for ln in self.lines:
            if ln.type == "del":
                out.append(f"{'':>5} {ln.old:>5} - {ln.text}")
            elif ln.type == "add":
                out.append(f"{ln.new:>5} {'':>5} + {ln.text}")
            else:
                out.append(f"{ln.new:>5} {ln.old:>5}   {ln.text}")
        return "\n".join(out)


FileStatus = Literal["added", "deleted", "modified", "renamed"]


@dataclass
class FileDiff:
    path: str
    old_path: str | None
    status: FileStatus
    binary: bool
    additions: int
    deletions: int
    hunks: list[Hunk] = field(default_factory=list)

    @property
    def pure_rename(self) -> bool:
        return self.status == "renamed" and not self.hunks


@dataclass
class DiffIndex:
    files: list[FileDiff]

    def __post_init__(self) -> None:
        self.by_id: dict[str, Hunk] = {h.id: h for f in self.files for h in f.hunks}

    @property
    def hunks(self) -> list[Hunk]:
        return [h for f in self.files for h in f.hunks]

    def file(self, path: str) -> FileDiff | None:
        return next((f for f in self.files if f.path == path), None)

    def resolve(self, path: str) -> FileDiff | None:
        """Exact path, else the unique diff file whose path ends with ``/path`` (agents often cite short paths)."""
        path = path.strip().removeprefix("./")
        if f := self.file(path):
            return f
        hits = [f for f in self.files if f.path.endswith("/" + path)]
        return hits[0] if len(hits) == 1 else None

    def to_dict(self) -> dict:
        return {"files": [asdict(f) for f in self.files]}

    def table(self) -> str:
        """Compact one-line-per-hunk index for prompts."""
        rows = []
        for f in self.files:
            for h in f.hunks:
                sym = f"  {h.symbol}" if h.symbol else ""
                rows.append(
                    f"{h.id:>4}  {f.path}  +{h.new_start}..{h.new_end}  (+{h.additions}/-{h.deletions}){sym}"
                )
        return "\n".join(rows)


def _strip(path: str | None) -> str | None:
    if path is None or path == "/dev/null":
        return None
    return path[2:] if path[:2] in ("a/", "b/") else path


def parse_diff(diff: str) -> DiffIndex:
    files: list[FileDiff] = []
    n = 0
    for pf in PatchSet(diff):
        target, source = _strip(pf.target_file), _strip(pf.source_file)
        path = target or source or pf.path
        if pf.is_added_file:
            status: FileStatus = "added"
        elif pf.is_removed_file:
            status = "deleted"
        elif pf.is_rename:
            status = "renamed"
        else:
            status = "modified"
        fd = FileDiff(
            path=path,
            old_path=source if status == "renamed" else None,
            status=status,
            binary=pf.is_binary_file,
            additions=pf.added,
            deletions=pf.removed,
        )
        for h in pf:
            n += 1
            lines: list[Line] = []
            for ln in h:
                if ln.is_added:
                    lines.append(Line("add", None, ln.target_line_no, ln.value.rstrip("\n")))
                elif ln.is_removed:
                    lines.append(Line("del", ln.source_line_no, None, ln.value.rstrip("\n")))
                elif ln.is_context:
                    lines.append(Line("ctx", ln.source_line_no, ln.target_line_no, ln.value.rstrip("\n")))
            fd.hunks.append(
                Hunk(
                    id=f"H{n}",
                    file=path,
                    old_start=h.source_start,
                    old_len=h.source_length,
                    new_start=h.target_start,
                    new_len=h.target_length,
                    symbol=(h.section_header or "").strip(),
                    lines=lines,
                )
            )
        files.append(fd)
    return DiffIndex(files)
