"""On-disk JSON store under the cache dir.

Guides are kept per target and head commit as numbered versions: every submit, and every guide edit made from
chat, adds one. ``<n>.json`` is the checked guide the UI renders; ``<n>.draft.json`` is the guide as the agent
wrote it (refs by path and line), which is what an agent edits to make the next version.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


class Store:
    def __init__(self, root: Path):
        self.root = root

    def _write(self, path: Path, data: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        with os.fdopen(fd, "w") as fh:
            json.dump(data, fh, ensure_ascii=False)
        os.replace(tmp, path)

    def _read(self, path: Path) -> Any | None:
        try:
            return json.loads(path.read_text())
        except (OSError, ValueError):
            return None

    # ---------- guides ----------

    def guide_dir(self, pr_key: str, head_sha: str) -> Path:
        return self.root / "guides" / f"{pr_key}-{head_sha[:12]}"

    def _numbers(self, pr_key: str, head_sha: str) -> list[int]:
        d = self.guide_dir(pr_key, head_sha)
        return sorted(int(p.stem) for p in d.glob("*.json") if p.stem.isdigit()) if d.exists() else []

    def guide_path(self, pr_key: str, head_sha: str, version: int | None = None) -> Path | None:
        """A version's file, or the latest one's; None if there is none."""
        ns = self._numbers(pr_key, head_sha)
        n = version if version is not None else (ns[-1] if ns else None)
        return self.guide_dir(pr_key, head_sha) / f"{n}.json" if n in ns else None

    def load_guide(self, pr_key: str, head_sha: str, version: int | None = None) -> dict | None:
        path = self.guide_path(pr_key, head_sha, version)
        return self._read(path) if path else None

    def draft_path(self, pr_key: str, head_sha: str, version: int) -> Path:
        return self.guide_dir(pr_key, head_sha) / f"{version}.draft.json"

    def load_draft(self, pr_key: str, head_sha: str, version: int) -> dict | None:
        return self._read(self.draft_path(pr_key, head_sha, version))

    def latest_head(self, pr_key: str) -> str | None:
        """The head commit the last guide for this target was saved against."""
        try:
            return (self.root / "guides" / f"{pr_key}.head").read_text().strip() or None
        except OSError:
            return None

    def save_guide(self, pr_key: str, head_sha: str, record: dict, draft: dict) -> int:
        """Store ``record`` (and the ``draft`` it was checked from) as the next version; return its number."""
        d = self.guide_dir(pr_key, head_sha)
        d.mkdir(parents=True, exist_ok=True)
        n = (self._numbers(pr_key, head_sha) or [0])[-1] + 1
        while True:  # another process (a submit, a chat edit) may take a number first
            try:
                with open(d / f"{n}.json", "x") as fh:
                    json.dump({**record, "version": n}, fh, ensure_ascii=False)
                self._write(self.draft_path(pr_key, head_sha, n), draft)
                (self.root / "guides" / f"{pr_key}.head").write_text(head_sha)
                return n
            except FileExistsError:
                n += 1

    def list_guides(self, pr_key: str, head_sha: str) -> list[dict]:
        """Every version, oldest first: number, label, scope and when it was made."""
        out = []
        for n in self._numbers(pr_key, head_sha):
            g = self._read(self.guide_dir(pr_key, head_sha) / f"{n}.json") or {}
            meta = g.get("meta") or {}
            out.append(
                {
                    "version": n,
                    "label": g.get("label") or "",
                    "scope": g.get("scope"),
                    "source": meta.get("source", "agent"),
                    "created_at": meta.get("created_at"),
                }
            )
        return out

    # ---------- chats ----------

    def chat_dir(self, pr_key: str) -> Path:
        return self.root / "chats" / pr_key

    def list_chats(self, pr_key: str) -> list[dict]:
        d = self.chat_dir(pr_key)
        chats = [c for p in d.glob("*.json") if (c := self._read(p))] if d.exists() else []
        return sorted(chats, key=lambda c: c.get("updated_at", 0), reverse=True)

    def load_chat(self, pr_key: str, chat_id: str) -> dict | None:
        return self._read(self.chat_dir(pr_key) / f"{chat_id}.json")

    def save_chat(self, pr_key: str, chat: dict) -> None:
        self._write(self.chat_dir(pr_key) / f"{chat['id']}.json", chat)
