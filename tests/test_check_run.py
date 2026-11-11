import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from check_run import check, parse_run


def agent_call(model, effort, tool="Agent"):
    block = {"type": "tool_use", "name": tool,
             "input": {"subagent_type": "general-purpose", "model": model, "effort": effort, "prompt": "p"}}
    return json.dumps({"type": "assistant", "parent_tool_use_id": None,
                       "message": {"model": "claude-sonnet-5-5", "content": [block]}})


def send_message():
    block = {"type": "tool_use", "name": "SendMessage", "input": {"to": "agent1", "message": "続き"}}
    return json.dumps({"type": "assistant", "parent_tool_use_id": None,
                       "message": {"model": "claude-sonnet-5-5", "content": [block]}})


def sub_msg(model):
    return json.dumps({"type": "assistant", "parent_tool_use_id": "toolu_1",
                       "message": {"model": model, "content": [{"type": "text", "text": "hi"}]}})


def main_msg(model="claude-sonnet-5-5"):
    return json.dumps({"type": "assistant", "parent_tool_use_id": None,
                       "message": {"model": model, "content": [{"type": "text", "text": "hi"}]}})


class CheckRunTest(unittest.TestCase):
    def test_switch_ok(self):
        run = parse_run([agent_call("opus", "high"), sub_msg("claude-opus-5-5")])
        self.assertEqual(run.calls, ["opus-high"])
        self.assertTrue(check(run, ["opus-high", "opus-xhigh"])[0])

    def test_subagent_on_wrong_model(self):
        ok, reason = check(parse_run([agent_call("opus", "high"), sub_msg("claude-sonnet-5-5")]), ["opus-high"])
        self.assertFalse(ok)
        self.assertIn("切り替わらなかった", reason)

    def test_unexpected_combo(self):
        run = parse_run([agent_call("fable", "xhigh"), sub_msg("claude-fable-5-2")])
        ok, reason = check(run, ["opus-high"])
        self.assertFalse(ok)
        self.assertIn("想定外", reason)

    def test_main_expected_and_no_agent(self):
        self.assertTrue(check(parse_run([main_msg()]), ["main"])[0])

    def test_main_expected_but_agent_called(self):
        run = parse_run([agent_call("opus", "high"), sub_msg("claude-opus-5-5")])
        self.assertFalse(check(run, ["main"])[0])

    def test_agent_expected_but_not_called(self):
        ok, reason = check(parse_run([main_msg()]), ["opus-high"])
        self.assertFalse(ok)
        self.assertIn("呼ばれなかった", reason)

    def test_agent_called_but_no_subagent_message(self):
        ok, reason = check(parse_run([agent_call("opus", "high")]), ["opus-high"])
        self.assertFalse(ok)
        self.assertIn("subagent", reason)

    def test_task_tool_name_is_treated_as_agent(self):
        run = parse_run([agent_call("opus", "high", tool="Task"), sub_msg("claude-opus-5-5")])
        self.assertTrue(check(run, ["opus-high"])[0])

    def test_send_message_counts_as_continuing_subagent(self):
        ok, reason = check(parse_run([send_message()]), ["fable-high", "fable-xhigh"])
        self.assertTrue(ok)
        self.assertIn("SendMessage", reason)

    def test_send_message_not_ok_when_main_expected(self):
        self.assertFalse(check(parse_run([send_message()]), ["main"])[0])

    def test_ignores_non_json_and_other_types(self):
        run = parse_run(["garbage", json.dumps({"type": "system", "subtype": "init"}), main_msg()])
        self.assertEqual(run.calls, [])
        self.assertEqual(run.sub_models, [])


if __name__ == "__main__":
    unittest.main()
