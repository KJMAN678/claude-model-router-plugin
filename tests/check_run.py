"""claude -p の stream-json 出力から、Agent ツールの呼び出しと subagent のモデルを判定する。

usage: check_run.py <run.jsonl> <allowed,combos|main>
  allowed: opus-high,opus-xhigh のようなカンマ区切りの組み合わせ、または main（subagent を使わない）
"""
import json
import sys
from dataclasses import dataclass, field

AGENT_TOOLS = ("Agent", "Task")


@dataclass
class Run:
    calls: list = field(default_factory=list)       # メインが呼んだ Agent の "<model>-<effort>"
    sub_models: list = field(default_factory=list)  # subagent の assistant メッセージの model


def _json_lines(lines):
    for line in lines:
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict):
            yield obj


def parse_run(lines):
    run = Run()
    for obj in _json_lines(lines):
        if obj.get("type") != "assistant":
            continue
        msg = obj.get("message", {})
        if obj.get("parent_tool_use_id"):
            if msg.get("model"):
                run.sub_models.append(msg["model"])
            continue
        for block in msg.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name") in AGENT_TOOLS:
                inp = block.get("input", {})
                run.calls.append(f"{inp.get('model', '?')}-{inp.get('effort', '?')}")
    return run


def check(run, allowed):
    if allowed == ["main"]:
        if run.calls:
            return False, f"subagent を使うべきでないのに呼んだ: {run.calls}"
        return True, "メインで実行"
    if not run.calls:
        return False, f"Agent が呼ばれなかった（期待: {allowed}）"
    bad = [c for c in run.calls if c not in allowed]
    if bad:
        return False, f"想定外の Agent 呼び出し: {bad}（許容: {allowed}）"
    model = run.calls[-1].split("-")[0]
    if not run.sub_models:
        return False, "subagent のメッセージがない"
    wrong = [m for m in run.sub_models if model not in m]
    if wrong:
        return False, f"{model} に切り替わらなかった: {wrong}"
    return True, f"{run.calls[-1]}: subagent は {model}"


def main(argv):
    with open(argv[1], encoding="utf-8") as f:
        run = parse_run(f.read().splitlines())
    ok, reason = check(run, argv[2].split(","))
    print(("PASS " if ok else "FAIL ") + reason)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
