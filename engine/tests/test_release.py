import json
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).parents[2]
PLUGIN = ROOT / "plugins/diffusion"


def test_plugin_pins_the_engine_version():
    """The skill runs the engine it was written for; uvx would otherwise reuse whatever version it cached."""
    version = tomllib.loads((ROOT / "engine/pyproject.toml").read_text())["project"]["version"]
    for manifest in PLUGIN.glob(".*-plugin/plugin.json"):
        assert json.loads(manifest.read_text())["version"] == version, manifest
    skill = (PLUGIN / "skills/review/SKILL.md").read_text()
    assert "uvx --from diffusion-review diffusion" not in skill
    assert set(re.findall(r"diffusion-review==([\w.]+)", skill)) == {version}
