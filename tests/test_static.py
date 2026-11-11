import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


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
        self.assertEqual(market["plugins"][0]["version"], plugin["version"])

    def test_no_skills_dir(self):
        self.assertFalse((ROOT / "skills").exists())


if __name__ == "__main__":
    unittest.main()
