import json
import unittest

from check_run import check, parse_run, stop_efforts


def asst(model, content):
    return json.dumps({"type": "assistant", "message": {"model": model, "content": content}})


def hook(event, level):
    return json.dumps({"hook_event_name": event, "effort": {"level": level}})


SKILL_CALL = [{"type": "tool_use", "name": "Skill", "input": {"skill": "model-router:use-opus-high"}}]
TEXT = [{"type": "text", "text": "hi"}]
SWITCHED = [asst("claude-sonnet-5-5", SKILL_CALL), asst("claude-opus-5-5", TEXT)]


class CheckRunTest(unittest.TestCase):
    def test_switch_ok(self):
        run = parse_run(SWITCHED)
        self.assertEqual(run.skills, ["use-opus-high"])
        self.assertTrue(check(run, ["use-opus-high", "use-opus-xhigh"])[0])

    def test_skill_called_but_model_not_switched(self):
        run = parse_run([asst("claude-sonnet-5-5", SKILL_CALL), asst("claude-sonnet-5-5", TEXT)])
        ok, reason = check(run, ["use-opus-high"])
        self.assertFalse(ok)
        self.assertIn("opus", reason)

    def test_wrong_skill(self):
        self.assertFalse(check(parse_run(SWITCHED), ["use-fable-xhigh"])[0])

    def test_none_expected_no_skill(self):
        self.assertTrue(check(parse_run([asst("claude-sonnet-5-5", TEXT)]), ["none"])[0])

    def test_none_expected_but_skill_called(self):
        self.assertFalse(check(parse_run(SWITCHED), ["none"])[0])

    def test_ignores_non_json_and_other_types(self):
        run = parse_run(["garbage", json.dumps({"type": "system", "subtype": "init"}), asst("claude-sonnet-5-5", TEXT)])
        self.assertEqual(run.all_models, ["claude-sonnet-5-5"])

    def test_stop_efforts(self):
        self.assertEqual(stop_efforts([hook("PostToolUse", "high"), hook("Stop", "high"), "garbage"]), ["high"])

    def test_effort_mismatch_fails(self):
        ok, reason = check(parse_run(SWITCHED), ["use-opus-high"], efforts=["medium"])
        self.assertFalse(ok)
        self.assertIn("effort", reason)

    def test_effort_unknown_is_not_failure(self):
        ok, reason = check(parse_run(SWITCHED), ["use-opus-high"], efforts=[])
        self.assertTrue(ok)
        self.assertIn("effort unknown", reason)


if __name__ == "__main__":
    unittest.main()
