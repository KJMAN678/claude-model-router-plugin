import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load(rel):
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))


class StaticTest(unittest.TestCase):
    def test_plugin_name(self):
        self.assertEqual(load(".claude-plugin/plugin.json")["name"], "model-router")

    def test_marketplace_lists_this_plugin(self):
        market, plugin = load(".claude-plugin/marketplace.json"), load(".claude-plugin/plugin.json")
        self.assertEqual(market["name"], "kjman678-plugins")
        self.assertTrue(market["owner"]["name"])
        self.assertEqual([(p["name"], p["source"]) for p in market["plugins"]], [(plugin["name"], "./")])
        self.assertEqual(market["plugins"][0]["version"], plugin["version"])

    def test_no_skills_dir(self):
        self.assertFalse((ROOT / "skills").exists())

    def test_hooks_json_loads_only_the_mod_module(self):
        self.assertEqual(load("hooks/hooks.json"), {"modules": ["./register.ts"]})
        self.assertTrue((ROOT / "hooks/register.ts").is_file())

    def test_module_hooks_both_events(self):
        src = (ROOT / "hooks/register.ts").read_text(encoding="utf-8")
        self.assertIn("on('prompt.submit'", src)
        self.assertIn("on('turn.step'", src)


if __name__ == "__main__":
    unittest.main()
