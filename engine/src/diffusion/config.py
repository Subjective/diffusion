"""Configuration: which model backend to use, and how to reach it.

A *profile* says how to talk to models:

- ``backend = "api"``: a Pydantic AI agent calling a model API directly. ``protocol`` is ``"anthropic"``
  (Messages API) or ``"openai"`` (Chat Completions: OpenAI, OpenRouter, Gemini, Ollama, vLLM, most gateways).
- ``backend = "claude-code"``: the Claude Agent SDK, using your Claude Code setup and login.
- ``backend = "codex"``: the Codex CLI (``codex exec``), using your Codex setup and login.

Profiles live in ``~/.config/diffusion/config.toml`` (or ``$DIFFUSION_CONFIG``)::

    default = "openrouter"

    [profiles.openrouter]
    backend = "api"
    protocol = "openai"
    base_url = "https://openrouter.ai/api/v1"
    api_key_env = "OPENROUTER_API_KEY"
    guide_model = "anthropic/claude-opus-5.5"
    chat_model = "anthropic/claude-sonnet-5.5"

With no config file a profile is auto-detected from the environment; ``diffusion doctor`` shows what was chosen.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

Backend = Literal["api", "claude-code", "codex"]
Protocol = Literal["anthropic", "openai"]
AuthStyle = Literal["x-api-key", "bearer"]

DEFAULT_MODELS: dict[tuple[str, str | None], tuple[str, str]] = {
    ("api", "anthropic"): ("claude-opus-5-5", "claude-sonnet-5-5"),
    ("api", "openai"): ("gpt-5", "gpt-5-mini"),
    ("claude-code", None): ("opus", "sonnet"),
    ("codex", None): ("", ""),  # empty = Codex's configured default model
}
DEFAULT_BASE_URLS: dict[str, str] = {
    "anthropic": "https://api.anthropic.com",
    "openai": "https://api.openai.com/v1",
}


class ConfigError(RuntimeError):
    pass


def config_path(environ: dict[str, str]) -> Path:
    if environ.get("DIFFUSION_CONFIG"):
        return Path(environ["DIFFUSION_CONFIG"]).expanduser()
    home = Path(environ.get("HOME") or Path.home())
    return Path(environ.get("XDG_CONFIG_HOME") or home / ".config") / "diffusion" / "config.toml"


def mask(secret: str | None) -> str:
    if not secret:
        return "<unset>"
    return secret[:4] + "…" + f"({len(secret)} chars)"


@dataclass(frozen=True)
class Config:
    profile: str
    source: str  # config file path, or why the profile was auto-detected
    backend: Backend
    guide_model: str
    chat_model: str
    protocol: Protocol | None = None
    base_url: str | None = None
    api_key: str | None = field(default=None, repr=False)
    key_source: str | None = None
    auth: AuthStyle = "x-api-key"
    headers: dict[str, str] = field(default_factory=dict, repr=False)
    cli_path: str | None = None
    env: dict[str, str] = field(default_factory=dict, repr=False)  # extra env for CLI backends
    cache_dir: Path = Path.home() / ".cache" / "diffusion"
    max_turns: int = 40

    def describe(self) -> list[tuple[str, str]]:
        rows = [("profile", f"{self.profile}  ({self.source})"), ("backend", self.backend)]
        if self.backend == "api":
            rows += [
                ("protocol", str(self.protocol)),
                ("base_url", str(self.base_url)),
                ("key", f"{mask(self.api_key)}  from {self.key_source}  (auth: {self.auth})"),
            ]
        else:
            rows.append(("cli", self.cli_path or "<bundled with the SDK>"))
            if self.env:
                rows.append(("env", ", ".join(sorted(self.env))))
        rows.append(
            (
                "models",
                f"guide={self.guide_model or '(cli default)'}  chat={self.chat_model or '(cli default)'}",
            )
        )
        rows.append(("cache", str(self.cache_dir)))
        return rows


def _read_toml(path: Path) -> dict:
    try:
        return tomllib.loads(path.read_text())
    except FileNotFoundError:
        return {}
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise ConfigError(f"{path}: {e}") from e


def env_from_files(paths: list[str]) -> dict[str, str]:
    """Merge the ``env`` table of JSON settings files (e.g. Claude Code settings). Earlier files win."""
    out: dict[str, str] = {}
    for p in reversed(paths):
        try:
            data = json.loads(Path(p).expanduser().read_text())
        except (OSError, ValueError):
            continue
        env = data.get("env") if isinstance(data, dict) else None
        if isinstance(env, dict):
            out.update({k: str(v) for k, v in env.items()})
    return out


def _resolve_key(
    p: dict, environ: dict[str, str], inherited: dict[str, str]
) -> tuple[str | None, str | None]:
    if p.get("api_key_cmd"):
        cmd = p["api_key_cmd"]
        try:
            out = subprocess.run(
                shlex.split(cmd) if isinstance(cmd, str) else cmd, capture_output=True, text=True, timeout=30
            )
        except (OSError, subprocess.TimeoutExpired) as e:
            raise ConfigError(f"api_key_cmd failed: {e}") from e
        if out.returncode != 0 or not out.stdout.strip():
            raise ConfigError(f"api_key_cmd failed: {out.stderr.strip() or 'no output'}")
        return out.stdout.strip(), "api_key_cmd"
    names = p.get("api_key_env") or []
    for name in [names] if isinstance(names, str) else names:
        if environ.get(name):
            return environ[name], f"env:{name}"
        if inherited.get(name):
            return inherited[name], f"inherited:{name}"
    return None, None


def _autodetect(environ: dict[str, str]) -> tuple[str, dict]:
    if environ.get("ANTHROPIC_API_KEY"):
        return "ANTHROPIC_API_KEY", {
            "protocol": "anthropic",
            "base_url": environ.get("ANTHROPIC_BASE_URL"),
            "api_key_env": "ANTHROPIC_API_KEY",
        }
    if environ.get("ANTHROPIC_AUTH_TOKEN"):  # gateways that take a bearer token on the Anthropic protocol
        return "ANTHROPIC_AUTH_TOKEN", {
            "protocol": "anthropic",
            "base_url": environ.get("ANTHROPIC_BASE_URL"),
            "api_key_env": "ANTHROPIC_AUTH_TOKEN",
            "auth": "bearer",
        }
    if environ.get("OPENROUTER_API_KEY"):
        return "OPENROUTER_API_KEY", {
            "protocol": "openai",
            "base_url": "https://openrouter.ai/api/v1",
            "api_key_env": "OPENROUTER_API_KEY",
            "guide_model": "anthropic/claude-opus-5.5",
            "chat_model": "anthropic/claude-sonnet-5.5",
        }
    if environ.get("OPENAI_API_KEY"):
        return "OPENAI_API_KEY", {
            "protocol": "openai",
            "base_url": environ.get("OPENAI_BASE_URL"),
            "api_key_env": "OPENAI_API_KEY",
        }
    if shutil.which("claude", path=environ.get("PATH")):
        return "claude CLI on PATH", {"backend": "claude-code"}
    if shutil.which("codex", path=environ.get("PATH")):
        return "codex CLI on PATH", {"backend": "codex"}
    raise ConfigError(
        "No model backend found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY, install the "
        "`claude` or `codex` CLI, or add a profile to ~/.config/diffusion/config.toml (see README)."
    )


def load_config(environ: dict[str, str] | None = None, profile: str | None = None) -> Config:
    env = dict(os.environ if environ is None else environ)
    path = config_path(env)
    data = _read_toml(path)
    profiles: dict[str, dict] = data.get("profiles", {})
    name = profile or env.get("DIFFUSION_PROFILE") or data.get("default")

    if name:
        if name not in profiles:
            raise ConfigError(
                f"Profile {name!r} not found in {path} (have: {', '.join(profiles) or 'none'})."
            )
        p, source = dict(profiles[name]), str(path)
    elif len(profiles) == 1:
        name, p = next(iter(profiles.items()))
        p, source = dict(p), str(path)
    else:
        reason, p = _autodetect(env)
        name, source = "auto", f"auto-detected from {reason}"

    backend = p.get("backend", "api")
    if backend not in ("api", "claude-code", "codex"):
        raise ConfigError(f"Profile {name!r}: unknown backend {backend!r} (api, claude-code, codex).")
    protocol = p.get("protocol", "anthropic") if backend == "api" else None
    if protocol not in (None, "anthropic", "openai"):
        raise ConfigError(f"Profile {name!r}: unknown protocol {protocol!r} (anthropic, openai).")

    inherited = env_from_files(p.get("inherit_env_from", []))
    extra_env = {**inherited, **{k: str(v) for k, v in p.get("env", {}).items()}}

    guide_default, chat_default = DEFAULT_MODELS[(backend, protocol)]
    guide_model = env.get("DIFFUSION_GUIDE_MODEL") or p.get("guide_model") or guide_default
    chat_model = env.get("DIFFUSION_CHAT_MODEL") or p.get("chat_model") or chat_default

    api_key = key_source = base_url = None
    auth = p.get("auth") or ("x-api-key" if protocol == "anthropic" else "bearer")
    if auth not in ("x-api-key", "bearer"):
        raise ConfigError(f"Profile {name!r}: unknown auth {auth!r} (x-api-key, bearer).")
    if protocol is not None:  # set exactly when backend == "api"
        api_key, key_source = _resolve_key(p, env, inherited)
        if not api_key and not p.get("no_key"):
            raise ConfigError(f"Profile {name!r}: no API key ({p.get('api_key_env') or 'set api_key_env'}).")
        inherited_url = inherited.get("ANTHROPIC_BASE_URL" if protocol == "anthropic" else "OPENAI_BASE_URL")
        base_url = (p.get("base_url") or inherited_url or DEFAULT_BASE_URLS[protocol]).rstrip("/")

    cli = env.get("DIFFUSION_CLI") or p.get("cli_path") or ("codex" if backend == "codex" else None)
    cli_path = (shutil.which(cli, path=env.get("PATH")) or cli) if cli else None
    home = Path(env.get("HOME") or Path.home())

    return Config(
        profile=name,
        source=source,
        backend=backend,
        guide_model=guide_model,
        chat_model=chat_model,
        protocol=protocol,
        base_url=base_url,
        api_key=api_key,
        key_source=key_source,
        auth=auth,
        headers={str(k): str(v) for k, v in p.get("headers", {}).items()},
        cli_path=cli_path if backend != "api" else None,
        env=extra_env if backend != "api" else {},
        cache_dir=Path(env.get("DIFFUSION_CACHE_DIR") or home / ".cache" / "diffusion"),
        max_turns=int(p.get("max_turns", 40)),
    )
