import json
import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMBOS = ["opus / medium", "opus / high", "opus / xhigh", "fable / high", "fable / xhigh"]


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

    def _hook_cmd(self):
        h = json.loads((ROOT / "hooks/hooks.json").read_text(encoding="utf-8"))["hooks"]["SessionStart"]
        self.assertEqual(len(h), 1)
        self.assertNotIn("matcher", h[0])  # startup / resume / clear / compact のすべてで注入する
        cmd = h[0]["hooks"][0]
        self.assertEqual(cmd["type"], "command")
        return cmd["command"]

    def test_hook_has_no_matcher_and_cats_routing(self):
        self.assertIn("${CLAUDE_PLUGIN_ROOT}/hooks/routing.md", self._hook_cmd())

    def test_hook_command_outputs_routing(self):
        out = subprocess.run(self._hook_cmd(), shell=True, capture_output=True, text=True, check=True,
                             env={**os.environ, "CLAUDE_PLUGIN_ROOT": str(ROOT)}).stdout
        self.assertEqual(out, (ROOT / "hooks/routing.md").read_text(encoding="utf-8"))

    def test_routing_size_and_combos(self):
        text = (ROOT / "hooks/routing.md").read_text(encoding="utf-8")
        self.assertLess(len(text), 10000)  # additionalContext の上限
        for c in COMBOS:
            self.assertIn(c, text)
        self.assertIn("メインで実行", text)

    def test_cases_tsv(self):
        rows = [l.split("\t") for l in (ROOT / "tests/cases.tsv").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(rows[0], ["name", "allowed", "prompt"])
        valid = {c.replace(" / ", "-") for c in COMBOS} | {"main"}
        for row in rows[1:]:
            self.assertEqual(len(row), 3, row)
            self.assertTrue(set(row[1].split(",")) <= valid, row)


if __name__ == "__main__":
    unittest.main()
