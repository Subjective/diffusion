"""A small built-in repository with a known change, used by the tests."""

from __future__ import annotations

import subprocess
from pathlib import Path

BASE_FILES: dict[str, str | bytes] = {
    "src/auth/session.ts": """\
import { Session, TokenPair } from "./types";

export class SessionManager {
  private session: Session | null = null;

  start(tokens: TokenPair) {
    this.session = { ...tokens, startedAt: Date.now() };
  }

  end() {
    this.session = null;
  }
}
""",
    "src/auth/types.ts": """\
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}
""",
    "src/api/client.ts": """\
export async function login(user: string, pass: string) {
  return http.post("/auth/login", { user, pass });
}
""",
    "src/legacy.ts": "export const OLD = 1;\n",
    "docs/notes.md": "notes\n",
    "package-lock.json": '{\n  "lockfileVersion": 3,\n  "version": "1.0.0"\n}\n',
}

HEAD_FILES: dict[str, str | bytes] = {
    "src/auth/session.ts": """\
import { Session, TokenPair } from "./types";
import { refreshTokens } from "../api/client";

export class SessionManager {
  private session: Session | null = null;
  private timer?: number;

  start(tokens: TokenPair) {
    this.session = { ...tokens, startedAt: Date.now() };
    this.schedule(tokens.expiresAt);
  }

  private schedule(at: number) {
    this.timer = setTimeout(() => this.refresh(), at - Date.now());
  }

  async refresh() {
    this.session = { ...this.session!, ...(await refreshTokens(this.session!.refreshToken)) };
  }

  end() {
    clearTimeout(this.timer);
    this.session = null;
  }
}
""",
    "src/auth/types.ts": """\
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}
""",
    "src/api/client.ts": """\
export async function login(user: string, pass: string) {
  return http.post("/auth/login", { user, pass });
}

export async function refreshTokens(token: string) {
  return http.post("/auth/refresh", { token });
}
""",
    "tests/session.test.ts": 'test("refreshes", () => {});\n',
    "package-lock.json": '{\n  "lockfileVersion": 3,\n  "version": "1.1.0"\n}\n',
    "docs/guide.md": "notes\n",  # pure rename of docs/notes.md
    "assets/logo.png": b"\x89PNG\r\n\x1a\n\x00\x00binary",
}
DELETED = ["src/legacy.ts", "docs/notes.md"]
# Hunks a good guide must cover (everything that isn't rule-skippable).
CODE_FILES = [
    "src/auth/session.ts",
    "src/auth/types.ts",
    "src/api/client.ts",
    "tests/session.test.ts",
    "src/legacy.ts",
]


def _write(root: Path, files: dict[str, str | bytes]) -> None:
    for rel, content in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            p.write_bytes(content)
        else:
            p.write_text(content)


def build_sample_repo(root: Path) -> tuple[str, str]:
    """Create the sample repo at ``root`` with branches ``main`` (base) and ``feature`` (head)."""

    def git(*a: str) -> str:
        return subprocess.run(["git", *a], cwd=root, check=True, capture_output=True, text=True).stdout

    root.mkdir(parents=True, exist_ok=True)
    git("init", "-q", "-b", "main")
    git("config", "user.email", "sample@example.com")
    git("config", "user.name", "Sample")
    git("config", "commit.gpgsign", "false")
    _write(root, BASE_FILES)
    git("add", "-A")
    git("commit", "-qm", "base")
    base = git("rev-parse", "HEAD").strip()
    git("checkout", "-qb", "feature")
    for rel in DELETED:
        (root / rel).unlink()
    _write(root, HEAD_FILES)
    git("add", "-A")
    git("commit", "-qm", "Add automatic token refresh")
    head = git("rev-parse", "HEAD").strip()
    git("checkout", "-q", "main")
    return base, head
