import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SKILLS = {
    "use-sonnet-high": ("sonnet", "high"),
    "use-opus-medium": ("opus", "medium"),
    "use-opus-high": ("opus", "high"),
    "use-opus-xhigh": ("opus", "xhigh"),
    "use-fable-high": ("fable", "high"),
    "use-fable-xhigh": ("fable", "xhigh"),
}


def frontmatter(path):
    lines = path.read_text(encoding="utf-8").split("\n")
    assert lines[0] == "---", f"{path}: frontmatter がない"
    end = lines.index("---", 1)
    return dict(l.split(": ", 1) for l in lines[1:end] if ": " in l)


class StaticTest(unittest.TestCase):
    def test_plugin_name(self):
        data = json.loads((ROOT / ".claude-plugin/plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(data["name"], "model-router")

    def test_marketplace_lists_this_plugin(self):
        market = json.loads((ROOT / ".claude-plugin/marketplace.json").read_text(encoding="utf-8"))
        plugin = json.loads((ROOT / ".claude-plugin/plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(market["name"], "kjman678-plugins")
        self.assertTrue(market["owner"]["name"])
        self.assertEqual([(p["name"], p["source"]) for p in market["plugins"]], [(plugin["name"], "./")])

    def test_skills_frontmatter(self):
        dirs = {p.name for p in (ROOT / "skills").iterdir() if p.is_dir()}
        self.assertEqual(dirs, set(SKILLS))
        for name, (model, effort) in SKILLS.items():
            fm = frontmatter(ROOT / "skills" / name / "SKILL.md")
            self.assertEqual(fm["name"], name)
            self.assertEqual(fm["model"], model)
            self.assertEqual(fm["effort"], effort)
            self.assertTrue(fm["description"].strip())


if __name__ == "__main__":
    unittest.main()
