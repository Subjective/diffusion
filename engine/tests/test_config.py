import stat

from diffusion.config import (
    Config,
    detect_harness,
    harness_session,
    installed_harness,
    load_config,
)


def test_detect_harness():
    assert detect_harness({}) is None
    assert detect_harness({"CLAUDECODE": "1"}) == "claude-code"
    assert detect_harness({"CODEX_THREAD_ID": "t"}) == "codex"
    assert detect_harness({"CODEX_SANDBOX": "seatbelt"}) == "codex"
    assert detect_harness({"CURSOR_AGENT": "1"}) == "cursor"
    # Claude Code or Codex running in Cursor's terminal is still Claude Code / Codex
    assert detect_harness({"CURSOR_TRACE_ID": "x", "CLAUDECODE": "1"}) == "claude-code"
    assert detect_harness({"CURSOR_AGENT": "1", "CODEX_THREAD_ID": "t"}) == "codex"


def test_harness_session():
    env = {"CLAUDE_CODE_SESSION_ID": "c1", "CODEX_THREAD_ID": "t1", "CURSOR_CONVERSATION_ID": "u1"}
    assert harness_session("claude-code", env) == "c1"
    assert harness_session("codex", env) == "t1"
    assert harness_session("cursor", env) == "u1"
    assert harness_session("codex", {"CODEX_THREAD_ID": ""}) is None
    assert harness_session(None, env) is None


def test_installed_harness(tmp_path):
    assert installed_harness({"PATH": str(tmp_path)}) is None
    exe = tmp_path / "cursor-agent"
    exe.write_text("#!/bin/sh\n")
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    assert installed_harness({"PATH": str(tmp_path)}) == "cursor"


def test_load_config_defaults_and_overrides(tmp_path):
    cfg = load_config({"HOME": str(tmp_path)})
    assert cfg.cache_dir == tmp_path / ".cache" / "diffusion"
    assert cfg.chat_model("claude-code") == "sonnet" and cfg.chat_model("codex") == ""
    assert cfg.chat_model("cursor") == "auto"
    assert cfg.cli_path("claude-code") is None  # the SDK's bundled CLI

    cfg = load_config(
        {
            "HOME": str(tmp_path),
            "DIFFUSION_CACHE_DIR": str(tmp_path / "c"),
            "DIFFUSION_CHAT_MODEL": "opus",
            "DIFFUSION_CLI": "/opt/my-claude",
        }
    )
    assert cfg.cache_dir == tmp_path / "c"
    assert cfg.chat_model("claude-code") == "opus" and cfg.chat_model("codex") == "opus"
    assert cfg.cli_path("claude-code") == "/opt/my-claude"


def test_cli_path_finds_the_agent_cli_on_path(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path))
    cfg = Config(cache_dir=tmp_path)
    assert cfg.cli_path("codex") == "codex"  # not installed: left to fail with a clear "not found"
    exe = tmp_path / "codex"
    exe.write_text("#!/bin/sh\n")
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    assert cfg.cli_path("codex") == str(exe)
