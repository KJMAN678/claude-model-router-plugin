#!/usr/bin/env zsh
# usage: zsh tests/e2e.sh <probe>
# claude v2.1.292 以上（Agent ツールの effort 引数）とログインが必要。API を呼ぶ。
PLUGIN=$(cd "$(dirname "$0")/.." && pwd)
MAIN=${MAIN:-sonnet}
EXTRA=${EXTRA:-}
OUT=$PLUGIN/tests/out
mkdir -p "$OUT"
PASSED=0
TOTAL=0

# run_case NAME ALLOWED PROMPT  (ALLOWED: カンマ区切りの組み合わせ または main)
run_case() {
  local name=$1 allowed=$2 prompt=$3 work
  work=$(mktemp -d)
  cp -R "$PLUGIN/tests/fixture/." "$work/"
  (cd "$work" && git init -q && git add -A && git commit -qm init) >/dev/null 2>&1
  echo "// uncommitted change" >> "$work/src/user.js"
  (cd "$work" && claude -p --plugin-dir "$PLUGIN" --model "$MAIN" --max-turns 10 ${=EXTRA} \
    --disallowedTools "Edit Write NotebookEdit Bash" \
    --output-format stream-json --verbose "$prompt" > "$OUT/$name.jsonl" 2> "$OUT/$name.err")
  local result
  result=$(python3 "$PLUGIN/tests/check_run.py" "$OUT/$name.jsonl" "$allowed")
  TOTAL=$((TOTAL + 1))
  if [[ $result == PASS* ]]; then PASSED=$((PASSED + 1)); fi
  echo "${result%% *} $name: ${result#* }"
}

mode_probe() {
  local opus="Agent ツールを subagent_type=general-purpose, model=opus, effort=xhigh で呼び、subagent に 1 語で挨拶させて"
  local fable="Agent ツールを subagent_type=general-purpose, model=fable, effort=high で呼び、subagent に 1 語で挨拶させて"
  run_case probe-opus opus-xhigh "$opus"
  run_case probe-fable fable-high "$fable"
  EXTRA="--permission-mode auto" run_case probe-opus-auto opus-xhigh "$opus"
  EXTRA="--permission-mode auto" run_case probe-fable-auto fable-high "$fable"
}

echo "claude $(claude --version 2>&1 | head -1)"
case ${1:-} in
  probe) mode_probe ;;
  *) echo "usage: zsh tests/e2e.sh <probe>" >&2; exit 2 ;;
esac

echo "passed $PASSED/$TOTAL"
[[ $PASSED -eq $TOTAL ]]
