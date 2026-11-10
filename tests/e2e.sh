#!/usr/bin/env zsh
# usage: zsh tests/e2e.sh <probe|routing|all>
PLUGIN=$(cd "$(dirname "$0")/.." && pwd)
MAIN=${MAIN:-sonnet}
EXTRA=${EXTRA:-}
OUT=$PLUGIN/tests/out
mkdir -p "$OUT"
PASSED=0
TOTAL=0

# run_case NAME ALLOWED PROMPT  (ALLOWED: カンマ区切りの skill 名 または none)
run_case() {
  local name=$1 allowed=$2 prompt=$3 work
  work=$(mktemp -d)
  cp -R "$PLUGIN/tests/fixture/." "$work/"
  (cd "$work" && git init -q && git add -A && git commit -qm init) >/dev/null 2>&1
  echo "// uncommitted change" >> "$work/src/user.js"
  rm -f "$OUT/$name.hooks.jsonl"
  cat > "$OUT/$name.settings.json" <<JSON
{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"{ cat; echo; } >> \"$OUT/$name.hooks.jsonl\""}]}]}}
JSON
  (cd "$work" && claude -p --plugin-dir "$PLUGIN" --model "$MAIN" --max-turns 6 ${=EXTRA} \
    --settings "$OUT/$name.settings.json" \
    --disallowedTools "Edit Write NotebookEdit Bash" \
    --output-format stream-json --verbose "$prompt" > "$OUT/$name.jsonl" 2> "$OUT/$name.err")
  local result
  result=$(python3 "$PLUGIN/tests/check_run.py" "$OUT/$name.jsonl" "$allowed" "$OUT/$name.hooks.jsonl")
  TOTAL=$((TOTAL + 1))
  if [[ $result == PASS* ]]; then PASSED=$((PASSED + 1)); fi
  echo "${result%% *} $name: ${result#* }"
}

mode_probe() {
  local p="model-router:use-opus-high を Skill ツールで呼んでから、1 語で挨拶して"
  run_case probe use-opus-high "$p"
  EXTRA="--permission-mode auto" run_case probe-auto use-opus-high "$p"
}

case ${1:-} in
  probe) mode_probe ;;
  *) echo "usage: zsh tests/e2e.sh <probe>" >&2; exit 2 ;;
esac

echo "passed $PASSED/$TOTAL"
[[ $PASSED -eq $TOTAL ]]
