"""On-disk JSON store under the cache dir. Guides are keyed by PR and head SHA."""

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

    def guide_path(self, pr_key: str, head_sha: str) -> Path:
        return self.root / "guides" / f"{pr_key}-{head_sha[:12]}.json"

    def load_guide(self, pr_key: str, head_sha: str) -> dict | None:
        return self._read(self.guide_path(pr_key, head_sha))

    def save_guide(self, pr_key: str, head_sha: str, record: dict) -> None:
        self._write(self.guide_path(pr_key, head_sha), record)

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
