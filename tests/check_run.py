"""claude -p の stream-json 出力から、skill 呼び出しとモデル切り替えを判定する。

usage: check_run.py <run.jsonl> <allowed,skills|none> [<hooks.jsonl>]
"""
import json
import sys
from dataclasses import dataclass, field


@dataclass
class Run:
    skills: list = field(default_factory=list)
    models_after_skill: list = field(default_factory=list)
    all_models: list = field(default_factory=list)


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
        model = msg.get("model")
        if model:
            run.all_models.append(model)
            if run.skills:  # skill 呼び出しを含むメッセージ自身は含めない（先に追加される）
                run.models_after_skill.append(model)
        for block in msg.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name") == "Skill":
                inp = block.get("input", {})
                name = inp.get("skill") or inp.get("command") or ""
                run.skills.append(name.split(":", 1)[-1])
    return run


def stop_efforts(hook_lines):
    return [
        obj.get("effort", {}).get("level")
        for obj in _json_lines(hook_lines)
        if obj.get("hook_event_name") == "Stop" and obj.get("effort", {}).get("level")
    ]


def check(run, allowed, efforts=None):
    if allowed == ["none"]:
        if run.skills:
            return False, f"skill を呼ぶべきでないのに呼んだ: {run.skills}"
        return True, "skill なし"
    if not run.skills:
        return False, f"skill が呼ばれなかった（期待: {allowed}）"
    bad = [s for s in run.skills if s not in allowed]
    if bad:
        return False, f"想定外の skill: {bad}（許容: {allowed}）"
    _, model, effort = run.skills[-1].split("-")
    if not run.models_after_skill:
        return False, "skill の後に assistant メッセージがない"
    wrong = [m for m in run.models_after_skill if model not in m]
    if wrong:
        return False, f"{model} に切り替わらなかった: {wrong}"
    if efforts:
        if efforts[-1] != effort:
            return False, f"effort が違う: {efforts[-1]}（期待 {effort}）"
        return True, f"{run.skills[-1]}: model {model}, effort {effort}"
    return True, f"{run.skills[-1]}: model {model}, effort unknown"


def main(argv):
    with open(argv[1], encoding="utf-8") as f:
        run = parse_run(f.read().splitlines())
    efforts = None
    if len(argv) > 3:
        try:
            with open(argv[3], encoding="utf-8") as f:
                efforts = stop_efforts(f.read().splitlines())
        except FileNotFoundError:
            pass
    ok, reason = check(run, argv[2].split(","), efforts)
    print(("PASS " if ok else "FAIL ") + reason)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
