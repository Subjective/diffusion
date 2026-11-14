from diffusion.commands import codex_skills, raw_command


def test_commands_go_as_the_harness_takes_them():
    assert raw_command("claude-code", "/code-review focus on auth") == "/code-review focus on auth"
    assert raw_command("codex", "/playwright open the page") == "$playwright open the page"
    assert raw_command("claude-code", "what does /etc/hosts do?") is None
    assert raw_command("claude-code", "/ not a command") is None
    assert raw_command("cursor", "/x") is None
    assert raw_command("", "/code-review") is None  # forks: never


def test_codex_skills_are_listed_from_their_folders(tmp_path, monkeypatch):
    monkeypatch.delenv("CODEX_HOME", raising=False)
    user = tmp_path / "home" / ".codex" / "skills" / "playwright"
    user.mkdir(parents=True)
    (user / "SKILL.md").write_text("---\nname: playwright\ndescription: Drive a browser\n---\nbody")
    repo = tmp_path / "repo"
    (repo / ".codex" / "skills" / "release").mkdir(parents=True)
    (repo / ".codex" / "skills" / "release" / "SKILL.md").write_text("no front matter")
    got = codex_skills(repo, home=tmp_path / "home")
    assert got == [
        {"name": "playwright", "description": "Drive a browser", "hint": ""},
        {"name": "release", "description": "", "hint": ""},
    ]
