#!/usr/bin/env zsh
# usage: zsh tests/e2e.sh <probe|routing|all>
# claude v2.1.292 以上（Agent ツールの effort 引数）とログインが必要。API を呼ぶ。
PLUGIN=$(cd "$(dirname "$0")/.." && pwd)
MAIN=${MAIN:-sonnet}
EXTRA=${EXTRA:-}
OUT=$PLUGIN/tests/out
mkdir -p "$OUT"
PASSED=0
TOTAL=0

# 小さな git リポジトリ（未コミットの変更が 1 つ）を作って、そのパスを出力する
new_work() {
  local work
  work=$(mktemp -d)
  cp -R "$PLUGIN/tests/fixture/." "$work/"
  (cd "$work" && git init -q && git add -A && git commit -qm init) >/dev/null 2>&1
  echo "// uncommitted change" >> "$work/src/user.js"
  echo "$work"
}

# run_claude NAME WORK PROMPT [claude の追加オプション...]
run_claude() {
  local name=$1 work=$2 prompt=$3
  shift 3
  (cd "$work" && claude -p --plugin-dir "$PLUGIN" --model "$MAIN" --max-turns 10 ${=EXTRA} "$@" \
    --disallowedTools "Edit Write NotebookEdit Bash" \
    --output-format stream-json --verbose "$prompt" < /dev/null > "$OUT/$name.jsonl" 2> "$OUT/$name.err")
}

# judge NAME ALLOWED [GREP]  (ALLOWED: カンマ区切りの組み合わせ または main。GREP: 出力に含まれるべき文字列)
judge() {
  local name=$1 allowed=$2 grep_for=${3:-} result
  result=$(python3 "$PLUGIN/tests/check_run.py" "$OUT/$name.jsonl" "$allowed")
  if [[ $result == PASS* && -n $grep_for ]] && ! grep -q -- "$grep_for" "$OUT/$name.jsonl"; then
    result="FAIL 出力に「$grep_for」がない"
  fi
  TOTAL=$((TOTAL + 1))
  if [[ $result == PASS* ]]; then PASSED=$((PASSED + 1)); fi
  echo "${result%% *} $name: ${result#* }"
}

# run_case NAME ALLOWED PROMPT [GREP]
run_case() {
  run_claude "$1" "$(new_work)" "$3"
  judge "$1" "$2" "${4:-}"
}

mode_probe() {
  local opus="Agent ツールを subagent_type=general-purpose, model=opus, effort=xhigh で呼び、subagent に 1 語で挨拶させて"
  local fable="Agent ツールを subagent_type=general-purpose, model=fable, effort=high で呼び、subagent に 1 語で挨拶させて"
  run_case probe-opus opus-xhigh "$opus"
  run_case probe-fable fable-high "$fable"
  EXTRA="--permission-mode auto" run_case probe-opus-auto opus-xhigh "$opus"
  EXTRA="--permission-mode auto" run_case probe-fable-auto fable-high "$fable"
}

mode_routing() {
  local name allowed prompt
  while IFS=$'\t' read -r name allowed prompt; do
    run_case "$name" "$allowed" "$prompt"
  done < <(tail -n +2 "$PLUGIN/tests/cases.tsv")

  # メインが Sonnet 以外でも振り分けは動き、/model sonnet を勧める
  local heavy
  heavy=$(awk -F'\t' '$1=="impl-heavy"{print $3}' "$PLUGIN/tests/cases.tsv")
  MAIN=opus run_case main-opus "opus-high,opus-xhigh" "$heavy" "/model sonnet"

  # 「続けて」は直前の種類と段階を引き継ぐ（2 ターン）
  local work design
  work=$(new_work)
  design=$(awk -F'\t' '$1=="design-heavy"{print $3}' "$PLUGIN/tests/cases.tsv")
  run_claude continue-1 "$work" "$design"
  run_claude continue "$work" "続けて" --continue
  judge continue "fable-high,fable-xhigh"
}

echo "claude $(claude --version 2>&1 | head -1)"
case ${1:-} in
  probe) mode_probe ;;
  routing) mode_routing ;;
  all) mode_probe; mode_routing ;;
  *) echo "usage: zsh tests/e2e.sh <probe|routing|all>" >&2; exit 2 ;;
esac

echo "passed $PASSED/$TOTAL"
[[ $PASSED -eq $TOTAL ]]
