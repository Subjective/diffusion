import json
import stat

import pytest

from diffusion.config import ConfigError, load_config, mask


@pytest.fixture
def home(tmp_path):
    h = tmp_path / "h"
    (h / ".config" / "diffusion").mkdir(parents=True)
    return h


def env(home, **kw):
    return {"HOME": str(home), "PATH": "", **kw}


def write_cfg(home, text):
    (home / ".config" / "diffusion" / "config.toml").write_text(text)


AUTODETECT = [
    ({"ANTHROPIC_API_KEY": "sk-a"}, "anthropic", "https://api.anthropic.com", "x-api-key", "env:ANTHROPIC_API_KEY"),
    (
        {"ANTHROPIC_AUTH_TOKEN": "tok", "ANTHROPIC_BASE_URL": "https://gw/"},
        "anthropic", "https://gw", "bearer", "env:ANTHROPIC_AUTH_TOKEN",
    ),
    ({"OPENROUTER_API_KEY": "or"}, "openai", "https://openrouter.ai/api/v1", "bearer", "env:OPENROUTER_API_KEY"),
    ({"OPENAI_API_KEY": "oa"}, "openai", "https://api.openai.com/v1", "bearer", "env:OPENAI_API_KEY"),
]  # fmt: skip


@pytest.mark.parametrize("keys,protocol,base,auth,src", AUTODETECT)
def test_autodetect_api_keys(home, keys, protocol, base, auth, src):
    cfg = load_config(env(home, **keys))
    assert (cfg.backend, cfg.protocol, cfg.base_url, cfg.auth, cfg.key_source) == (
        "api",
        protocol,
        base,
        auth,
        src,
    )
    assert cfg.profile == "auto" and "auto-detected" in cfg.source


def test_autodetect_prefers_anthropic_then_openrouter(home):
    cfg = load_config(env(home, OPENAI_API_KEY="o", OPENROUTER_API_KEY="r", ANTHROPIC_API_KEY="a"))
    assert cfg.protocol == "anthropic"
    cfg = load_config(env(home, OPENAI_API_KEY="o", OPENROUTER_API_KEY="r"))
    assert cfg.base_url == "https://openrouter.ai/api/v1" and cfg.guide_model.startswith("anthropic/")


def test_autodetect_cli_backends(home, tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name in ("codex", "claude"):
        exe = bin_dir / name
        exe.write_text("#!/bin/sh\n")
        exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    assert load_config({"HOME": str(home), "PATH": str(bin_dir)}).backend == "claude-code"
    (bin_dir / "claude").unlink()
    cfg = load_config({"HOME": str(home), "PATH": str(bin_dir)})
    assert cfg.backend == "codex" and cfg.cli_path == str(bin_dir / "codex")


def test_nothing_found_is_helpful(home):
    with pytest.raises(ConfigError, match="ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY"):
        load_config(env(home))


PROFILES = """
default = "or"
[profiles.or]
backend = "api"
protocol = "openai"
base_url = "https://openrouter.ai/api/v1/"
api_key_env = "OPENROUTER_API_KEY"
guide_model = "g"
chat_model = "c"
headers = { "HTTP-Referer" = "https://example.com" }

[profiles.cc]
backend = "claude-code"
cli_path = "/opt/claude"
env = { CLAUDE_CODE_USE_BEDROCK = "1" }
"""


def test_profiles_default_and_override(home):
    write_cfg(home, PROFILES)
    cfg = load_config(env(home, OPENROUTER_API_KEY="k"))
    assert (cfg.profile, cfg.base_url, cfg.guide_model, cfg.chat_model) == (
        "or", "https://openrouter.ai/api/v1", "g", "c",
    )  # fmt: skip
    assert cfg.headers == {"HTTP-Referer": "https://example.com"}
    cc = load_config(env(home), profile="cc")
    assert (cc.backend, cc.cli_path, cc.guide_model) == ("claude-code", "/opt/claude", "opus")
    assert cc.env == {"CLAUDE_CODE_USE_BEDROCK": "1"}
    assert load_config(env(home, DIFFUSION_PROFILE="cc")).profile == "cc"
    assert load_config(env(home, OPENROUTER_API_KEY="k", DIFFUSION_GUIDE_MODEL="x")).guide_model == "x"


def test_single_profile_is_used_without_default(home):
    write_cfg(home, '[profiles.only]\nbackend = "api"\nprotocol = "openai"\napi_key_env = "K"\n')
    assert load_config(env(home, K="v")).profile == "only"


def test_unknown_profile_backend_and_missing_key(home):
    write_cfg(home, '[profiles.a]\nbackend = "nope"\n[profiles.b]\napi_key_env = "MISSING"\n')
    with pytest.raises(ConfigError, match="not found"):
        load_config(env(home), profile="zzz")
    with pytest.raises(ConfigError, match="unknown backend"):
        load_config(env(home), profile="a")
    with pytest.raises(ConfigError, match="no API key"):
        load_config(env(home), profile="b")


def test_api_key_cmd(home):
    write_cfg(home, '[profiles.a]\napi_key_cmd = "echo sk-from-cmd"\n')
    cfg = load_config(env(home))
    assert cfg.api_key == "sk-from-cmd" and cfg.key_source == "api_key_cmd"
    write_cfg(home, '[profiles.a]\napi_key_cmd = "false"\n')
    with pytest.raises(ConfigError, match="api_key_cmd failed"):
        load_config(env(home))


def test_inherit_env_from_settings_files(home, tmp_path):
    """E.g. reuse a Claude Code setup that already points at a gateway."""
    user, org = tmp_path / "user.json", tmp_path / "org.json"
    user.write_text(json.dumps({"env": {"ANTHROPIC_AUTH_TOKEN": "tok-user"}}))
    org.write_text(
        json.dumps(
            {"env": {"ANTHROPIC_BASE_URL": "https://gateway.example/", "ANTHROPIC_AUTH_TOKEN": "tok-org"}}
        )
    )
    write_cfg(
        home,
        f"""
[profiles.gw]
backend = "api"
protocol = "anthropic"
auth = "bearer"
api_key_env = "ANTHROPIC_AUTH_TOKEN"
inherit_env_from = ["{user}", "{org}"]

[profiles.gw-cc]
backend = "claude-code"
inherit_env_from = ["{user}", "{org}"]
""",
    )
    cfg = load_config(env(home), profile="gw")
    assert (cfg.api_key, cfg.key_source, cfg.base_url) == (
        "tok-user", "inherited:ANTHROPIC_AUTH_TOKEN", "https://gateway.example",
    )  # fmt: skip
    cc = load_config(env(home), profile="gw-cc")
    assert cc.env == {"ANTHROPIC_AUTH_TOKEN": "tok-user", "ANTHROPIC_BASE_URL": "https://gateway.example/"}


def test_bad_toml_reported(home):
    write_cfg(home, "default = ")
    with pytest.raises(ConfigError, match="config.toml"):
        load_config(env(home))


def test_secrets_never_shown(home):
    write_cfg(
        home,
        '[profiles.cc]\nbackend = "claude-code"\nenv = { ANTHROPIC_AUTH_TOKEN = "sk-secret-value", X = "1" }\n',
    )
    cc = load_config(env(home))
    shown = "\n".join(v for _, v in cc.describe())
    assert "sk-secret-value" not in shown and "ANTHROPIC_AUTH_TOKEN" in shown and "X" in shown
    assert "sk-secret-value" not in repr(cc)
    api = load_config(
        env(home, ANTHROPIC_API_KEY="sk-secret-value", DIFFUSION_CONFIG=str(home / "none.toml"))
    )
    assert "sk-secret-value" not in repr(api) and "sk-secret-value" not in str(api.describe())
    assert mask("sk-secret-value").startswith("sk-s…")


def test_pinned_backend_beats_api_keys_and_config_default(home):
    write_cfg(home, PROFILES)
    keys = {"ANTHROPIC_API_KEY": "a", "OPENROUTER_API_KEY": "r"}
    cfg = load_config(env(home, **keys), backend="claude-code")
    assert (cfg.backend, cfg.profile, cfg.api_key) == ("claude-code", "claude-code", None)
    assert "pinned" in cfg.source
    assert load_config(env(home, DIFFUSION_BACKEND="codex", **keys)).backend == "codex"


def test_named_profile_beats_pinned_backend(home):
    write_cfg(home, PROFILES)
    cfg = load_config(env(home, OPENROUTER_API_KEY="r"), profile="or", backend="claude-code")
    assert (cfg.profile, cfg.backend) == ("or", "api")


def test_only_cli_backends_can_be_pinned(home):
    with pytest.raises(ConfigError, match="Can't pin backend 'api'"):
        load_config(env(home, ANTHROPIC_API_KEY="a"), backend="api")
