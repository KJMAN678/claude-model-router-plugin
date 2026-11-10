#!/bin/zsh
# 使い捨て spike: skill の model/effort 切替と prompt hook の挙動を確認する
set -u
S="$(cd "$(dirname "$0")" && pwd)"
P="$S/plug"
mkdir -p "$P/.claude-plugin" "$P/skills/route-haiku" "$P/hooks"
echo '{"name":"spike-router"}' > "$P/.claude-plugin/plugin.json"
cat > "$P/skills/route-haiku/SKILL.md" <<'EOF'
---
name: route-haiku
description: Use this skill whenever the user asks for a light task routed to haiku.
model: haiku
effort: low
---
You are now running under the routed model. Answer briefly and state which model you are.
EOF
cat > "$P/hooks/hooks.json" <<'EOF'
{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"prompt","model":"haiku","prompt":"Classify this user prompt as SIMPLE or COMPLEX. Prompt: $ARGUMENTS. Respond with ok=true and put the label in reason."}]}]}}
EOF

summarize() {
  python3 - "$1" <<'PY'
import json,sys
for l in open(sys.argv[1]):
    try: d=json.loads(l)
    except: continue
    t=d.get('type'); m=d.get('message',{}) or {}
    if t=='assistant':
        print('assistant', m.get('model'), [c.get('type')+':'+(c.get('name') or c.get('text','') or '')[:60] for c in m.get('content',[])])
    elif t=='system':
        if d.get('subtype')=='hook_started': continue
        print('system', d.get('subtype'), d.get('model'), d.get('hook_name'), str(d.get('output') or d.get('stdout') or '')[:300])
    elif t=='result':
        print('result', list((d.get('modelUsage') or {}).keys()), (d.get('result') or '')[:150])
PY
}

cd "$S"
echo "=== run1: Claude が自分で skill を呼ぶ ==="
claude -p --plugin-dir "$P" --model sonnet --output-format stream-json --verbose --include-hook-events \
  "Invoke the spike-router:route-haiku skill using the Skill tool, then say hello in one word." > run1.jsonl 2> run1.err
summarize run1.jsonl; head -c 400 run1.err

echo "=== run2: ユーザーが /skill で呼ぶ ==="
claude -p --plugin-dir "$P" --model sonnet --output-format stream-json --verbose --include-hook-events \
  "/spike-router:route-haiku say hello in one word" > run2.jsonl 2> run2.err
summarize run2.jsonl; head -c 400 run2.err
echo "=== done ==="
