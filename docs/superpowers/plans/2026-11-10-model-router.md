# model-router 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** メインの Sonnet がタスクの種類と難易度を判定し、モデル×effort ごとの skill を呼んで、そのターンだけモデルと effort を切り替える Claude Code プラグインを作る。

**Architecture:** SessionStart hook が `hooks/routing.md`（振り分けルール）をコンテキストに注入する。Sonnet はそのルールに従って `use-<model>-<effort>` skill を 1 つ呼ぶ。skill の frontmatter の `model` / `effort` が、そのターンの残りに効く。

**Tech Stack:** Claude Code プラグイン（Markdown + JSON）、bash、python3 標準ライブラリのみ（テスト用）

**Spec:** [docs/superpowers/specs/2026-11-10-model-router-design.md](../specs/2026-11-10-model-router-design.md)

## Global Constraints

- プラグイン名: `model-router`。リポジトリのルートがプラグインのルート。
- skill は次の 6 個で、名前・`model`・`effort` は固定: `use-sonnet-high`（sonnet/high）、`use-opus-medium`（opus/medium）、`use-opus-high`（opus/high）、`use-opus-xhigh`（opus/xhigh）、`use-fable-high`（fable/high）、`use-fable-xhigh`（fable/xhigh）。
- `model` には alias（`sonnet` / `opus` / `fable`）を使う。完全なモデル ID は書かない。
- SessionStart hook には matcher を付けない（startup / resume / clear / compact のすべてで注入する）。
- `routing.md` は 10,000 文字未満（`additionalContext` の上限）。
- プラグイン内のパスは `${CLAUDE_PLUGIN_ROOT}` で参照する。
- 外部依存は増やさない（bash と python3 標準ライブラリのみ）。
- `tests/e2e.sh` は実際に API を呼ぶ。サンドボックス内では `claude -p` が動かない（このセッションで確認済み）ため、e2e はユーザーがターミナルで実行する。CI には入れない。

## Review Focus

1. **メインセッションが Sonnet 以外（例: Opus）で起動された場合** — 振り分けはそのまま動き、`/model sonnet` を勧める表示が 1 回出るべき。→ Task 4 の e2e `main-opus` で確かめる。
2. **「続けて」などの文脈依存プロンプト** — 直前のタスクの種類を引き継いで判定されるべき。→ Task 4 の e2e `continue` で確かめる（2 ターン、`--continue` を使う）。
3. **ユーザーがモデルを明示した場合（「Fable で」）** — 難易度の判定より明示が優先されるべき。→ Task 4 の cases.tsv に含める。
4. **compact / resume の後** — ルールが再注入されるべき。→ Task 3 の静的テストで、hooks.json に matcher が無いことを確かめる。
5. **routing.md を編集して上限を超えた場合** — 注入時に黙って切り捨てられるのを防ぐ。→ Task 3 の静的テストで 10,000 文字未満であることを確かめる。

effort は stream-json には出ないので、テスト専用の Stop hook が受け取る入力 JSON の `effort.level` で確かめる（Task 2）。値が取れない場合は「effort unknown」と表示し、FAIL にはしない。

---

### Task 1: プラグインの骨組みと 6 個の skill

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `skills/use-{sonnet-high,opus-medium,opus-high,opus-xhigh,fable-high,fable-xhigh}/SKILL.md`
- Test: `tests/test_static.py`

**Interfaces:**
- Produces: skill 名 `model-router:use-<model>-<effort>`（6 個）。frontmatter は `name` / `description` / `model` / `effort`。
- Produces: `tests/test_static.py` 内の定数 `SKILLS: dict[str, tuple[str, str]]`（skill 名 → (model, effort)）。Task 3 で再利用する。

- [ ] **Step 1: 失敗するテストを書く**

`tests/test_static.py`（unittest、frontmatter は `---` で挟まれた `key: value` 行を自前で読む）:

```python
SKILLS = {
    "use-sonnet-high": ("sonnet", "high"),
    "use-opus-medium": ("opus", "medium"),
    "use-opus-high": ("opus", "high"),
    "use-opus-xhigh": ("opus", "xhigh"),
    "use-fable-high": ("fable", "high"),
    "use-fable-xhigh": ("fable", "xhigh"),
}

def test_plugin_name(self):
    assert json.load(open(".claude-plugin/plugin.json"))["name"] == "model-router"

def test_skills_frontmatter(self):
    # skills/ 直下のディレクトリが SKILLS のキーと完全一致すること
    # 各 SKILL.md の name == ディレクトリ名、model / effort が SKILLS の値と一致すること
    # description が空でないこと
```

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `python3 -m unittest tests/test_static.py -v`
Expected: FAIL（`.claude-plugin/plugin.json` が無い）

- [ ] **Step 3: plugin.json と 6 個の SKILL.md を作る**

`plugin.json`: `{"name": "model-router", "version": "0.1.0", "description": "タスクの種類と難易度に応じて、ターンごとにモデルと effort を切り替える"}`

各 SKILL.md（`<M>` はモデル表示名 Sonnet / Opus / Fable、`<E>` は effort）:

```markdown
---
name: use-<model>-<effort>
description: model-router の振り分けで「<M> / <E>」と判定したときに呼ぶ。このターンの残りを <M> / <E> で実行する。
model: <model>
effort: <effort>
---
このターンは <M> / <E> で実行中です。ユーザーの依頼をそのまま続けてください。

あなたが <M> でない場合は、「model-router: <M> に切り替わりませんでした（現在のモデルで続行します）」と 1 行だけ表示し、現在のモデルで続けてください。
```

- [ ] **Step 4: テストが通ることを確かめる**

Run: `python3 -m unittest tests/test_static.py -v`
Expected: PASS（2 tests）

Run: `claude plugin validate .`
Expected: エラーなし。サンドボックスで動かない場合は、その旨を記録してユーザーに実行を依頼する。

- [ ] **Step 5: コミット**

```bash
git add .claude-plugin skills tests/test_static.py
git commit -m "feat: プラグインの骨組みとモデル×effort の skill 6 個を追加"
```

---

### Task 2: e2e の判定器と切り替えの検証（ゲート）

spec 7 章のリスクを確かめるタスク。**ここで切り替えが確認できなければ、以降のタスクには進まず、ユーザーに報告して spec を改訂する**（subagent 方式に置き換える）。

**Files:**
- Create: `tests/check_run.py`
- Create: `tests/test_check_run.py`
- Create: `tests/e2e.sh`
- Create: `tests/fixture/README.md`（誤字「インストール」→「インストーる」を 1 か所含む短い README）
- Create: `tests/fixture/src/user.js`（`function getUser(id)` と、それを呼ぶ箇所を 1 つ含む）

**Interfaces:**
- Consumes: Task 1 の skill 名。
- Produces: `python3 tests/check_run.py <run.jsonl> <allowed> [<hooks.jsonl>]` を実行すると、PASS / FAIL と理由を 1 行表示し、PASS なら exit 0、FAIL なら exit 1 で終わる。`<allowed>` はカンマ区切りの skill 名（接頭辞 `model-router:` は付けない）か `none`。`<hooks.jsonl>` はテスト専用 hook が記録した入力 JSON（1 行 1 イベント）。
- Produces: `tests/e2e.sh <mode>`。`<mode>` は `probe` / `routing` / `all`。各ケースの PASS / FAIL を 1 行ずつ表示し、最後に `passed N/M` を出す。FAIL が 1 件でもあれば exit 1 で終わる。

- [ ] **Step 1: 判定器の失敗するテストを書く**

`tests/test_check_run.py`（unittest）。stream-json の行を合成して、次の 3 つを検証する。
- `check_run.parse_run(lines: list[str]) -> Run`
- `check_run.stop_efforts(hook_lines: list[str]) -> list[str]`：`hook_event_name == "Stop"` の行の `effort.level` を順に返す
- `check_run.check(run: Run, allowed: list[str], efforts: list[str] | None = None) -> tuple[bool, str]``Run` は `skills: list[str]`（呼ばれた skill 名。接頭辞を除いたもの）、`models_after_skill: list[str]`、`all_models: list[str]` を持つ dataclass。

```python
def asst(model, content): return json.dumps({"type": "assistant", "message": {"model": model, "content": content}})
SKILL_CALL = [{"type": "tool_use", "name": "Skill", "input": {"skill": "model-router:use-opus-high"}}]
TEXT = [{"type": "text", "text": "hi"}]

def test_switch_ok(self):
    run = parse_run([asst("claude-sonnet-5-5", SKILL_CALL), asst("claude-opus-5-5", TEXT)])
    assert run.skills == ["use-opus-high"]
    assert check(run, ["use-opus-high", "use-opus-xhigh"])[0] is True

def test_skill_called_but_model_not_switched(self):
    run = parse_run([asst("claude-sonnet-5-5", SKILL_CALL), asst("claude-sonnet-5-5", TEXT)])
    ok, reason = check(run, ["use-opus-high"])
    assert ok is False and "opus" in reason

def test_wrong_skill(self):
    run = parse_run([asst("claude-sonnet-5-5", SKILL_CALL), asst("claude-opus-5-5", TEXT)])
    assert check(run, ["use-fable-xhigh"])[0] is False

def test_none_expected_no_skill(self):
    run = parse_run([asst("claude-sonnet-5-5", TEXT)])
    assert check(run, ["none"])[0] is True

def test_none_expected_but_skill_called(self):
    run = parse_run([asst("claude-sonnet-5-5", SKILL_CALL), asst("claude-opus-5-5", TEXT)])
    assert check(run, ["none"])[0] is False

def test_ignores_non_json_and_other_types(self):
    run = parse_run(["garbage", json.dumps({"type": "system", "subtype": "init"}), asst("claude-sonnet-5-5", TEXT)])
    assert run.all_models == ["claude-sonnet-5-5"]

def hook(event, level): return json.dumps({"hook_event_name": event, "effort": {"level": level}})

def test_stop_efforts(self):
    assert stop_efforts([hook("PostToolUse", "high"), hook("Stop", "high"), "garbage"]) == ["high"]

def test_effort_mismatch_fails(self):
    run = parse_run([asst("claude-sonnet-5-5", SKILL_CALL), asst("claude-opus-5-5", TEXT)])
    ok, reason = check(run, ["use-opus-high"], efforts=["medium"])
    assert ok is False and "effort" in reason

def test_effort_unknown_is_not_failure(self):
    run = parse_run([asst("claude-sonnet-5-5", SKILL_CALL), asst("claude-opus-5-5", TEXT)])
    ok, reason = check(run, ["use-opus-high"], efforts=[])
    assert ok is True and "effort unknown" in reason
```

規則:
- skill を呼んだ場合、期待するモデルは skill 名の 2 番目の要素（`use-opus-high` → `opus`）。`models_after_skill` のすべてがその文字列を含めば、モデルは PASS。
- `efforts` が空でなければ、最後の値が skill 名の 3 番目の要素（`high`）と一致すること。空か `None` なら、reason に `effort unknown` を含め、FAIL にはしない。
- `none` の場合は、skill を 1 つも呼ばなければ PASS。
- Skill の入力は `input["skill"]` を見て、無ければ `input["command"]` を見る（Step 6 で実際のキー名を確かめる）。

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `python3 -m unittest tests/test_check_run.py -v`
Expected: FAIL（`check_run` が無い）

- [ ] **Step 3: `tests/check_run.py` を実装する**

`parse_run`、`check`、`Run` と、上の CLI（`sys.argv[1]` の jsonl、`sys.argv[2]` の許容リスト）を実装する。

- [ ] **Step 4: テストが通ることを確かめる**

Run: `python3 -m unittest tests/test_check_run.py -v`
Expected: PASS（9 tests）

- [ ] **Step 5: フィクスチャと `tests/e2e.sh` の `probe` モードを実装する**

ケースごとの準備（関数 `run_case NAME ALLOWED PROMPT`）:
1. `WORK=$(mktemp -d)` に `tests/fixture/` をコピーし、`git init -q && git add -A && git commit -qm init` を実行する。その後 `src/user.js` に 1 行追記し、未コミットの変更を 1 つ残す（review ケース用）。
2. テスト専用の settings を `$OUT/$NAME.settings.json` に書き出す。Stop hook が 1 つだけで、そのコマンドは `{ cat; echo; } >> "$OUT/$NAME.hooks.jsonl"`。
3. 次のコマンドを `$WORK` で実行する（`PLUGIN=$(cd "$(dirname "$0")/.." && pwd)` で絶対パスを渡す）。

```bash
claude -p --plugin-dir "$PLUGIN" --model "$MAIN" --max-turns 6 $EXTRA \
  --settings "$OUT/$NAME.settings.json" \
  --disallowedTools "Edit Write NotebookEdit Bash" \
  --output-format stream-json --verbose "$PROMPT" > "$OUT/$NAME.jsonl" 2> "$OUT/$NAME.err"
```

4. `python3 tests/check_run.py "$OUT/$NAME.jsonl" "$ALLOWED" "$OUT/$NAME.hooks.jsonl"` で判定する。

`$MAIN` の既定値は `sonnet`、`$EXTRA` の既定値は空。`$OUT` は `tests/out/`（`.gitignore` に追加する）。

`probe` モードは 2 ケースを実行する。どちらもプロンプトは「model-router:use-opus-high を Skill ツールで呼んでから、1 語で挨拶して」、許容は `use-opus-high`。
- `probe`：既定の権限モード
- `probe-auto`：`EXTRA="--permission-mode auto"`。CLI がこの値を受け付けない場合は、`claude --help` で正しい書き方を確かめて直す

- [ ] **Step 6: ユーザーに probe を実行してもらう（ゲート）**

ユーザーにターミナルでの実行を依頼する: `zsh tests/e2e.sh probe`（ログイン済みで新しい版の CLI が必要）
Expected: `PASS probe`、`PASS probe-auto`、`passed 2/2`

あわせて、デスクトップアプリの Code タブで 1 回、手動で確かめてもらう。プラグインを読み込んだセッションをモデル Sonnet で開き、同じプロンプトを送る。応答が Opus からのものか（skill 本文の「切り替わりませんでした」の行が出ないか）を見る。

- `probe` がモデル切り替えで FAIL した場合 → **ここで停止**。結果と `tests/out/probe.jsonl` の該当行をユーザーに報告し、spec の改訂（subagent 方式）を提案する。
- `probe-auto` だけが FAIL した場合も停止して報告する。ユーザーは auto モードで使っているので、対象外にするか方式を変えるかはユーザーが決める。
- effort が `effort unknown` だった場合や一致しなかった場合は、その結果を spec 7 章に追記してから先に進む。
- `tests/out/probe.jsonl` で Skill の入力キー名を確かめ、`skill` 以外だった場合は check_run.py とテストを直す。

- [ ] **Step 7: コミット**

```bash
git add tests/check_run.py tests/test_check_run.py tests/e2e.sh tests/fixture .gitignore
git commit -m "test: e2e の判定器と、モデル切り替えの probe を追加"
```

---

### Task 3: SessionStart hook と routing.md

**Files:**
- Create: `hooks/hooks.json`
- Create: `hooks/routing.md`
- Modify: `tests/test_static.py`（テストを追加）

**Interfaces:**
- Consumes: Task 1 の `SKILLS`。
- Produces: SessionStart のたびに、routing.md の全文がコンテキストに入る。

- [ ] **Step 1: 失敗するテストを追加する**

```python
def test_hook_has_no_matcher_and_cats_routing(self):
    h = json.load(open("hooks/hooks.json"))["hooks"]["SessionStart"]
    assert len(h) == 1 and "matcher" not in h[0]
    cmd = h[0]["hooks"][0]
    assert cmd["type"] == "command" and "${CLAUDE_PLUGIN_ROOT}/hooks/routing.md" in cmd["command"]

def test_hook_command_outputs_routing(self):
    # cmd["command"] を CLAUDE_PLUGIN_ROOT=<repo root> の環境で subprocess（shell=True）実行し、
    # stdout が hooks/routing.md の内容と一致すること

def test_routing_size_and_skill_names(self):
    text = open("hooks/routing.md", encoding="utf-8").read()
    assert len(text) < 10000
    for name in SKILLS: assert f"model-router:{name}" in text
```

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `python3 -m unittest tests/test_static.py -v`
Expected: 新しく追加した 3 tests が FAIL（ファイルが無い）

- [ ] **Step 3: hooks.json と routing.md を作る**

hooks.json:

```json
{"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "cat \"${CLAUDE_PLUGIN_ROOT}/hooks/routing.md\""}]}]}}
```

routing.md: spec の 5.1〜5.3 章を、Claude への命令文として書き直したもの。表のセルには skill の完全な名前（`model-router:use-opus-high` など）を書く。冒頭に「毎回ユーザーのメッセージを受けたら、作業の前にこの手順で判定し、該当する skill を Skill ツールで呼ぶ」と書く。判定結果の 1 行表示の書式は `→ <モデル> / <effort>（<種類> <段階>）`。

- [ ] **Step 4: テストが通ることを確かめる**

Run: `python3 -m unittest tests/test_static.py -v`
Expected: PASS（5 tests）

- [ ] **Step 5: コミット**

```bash
git add hooks tests/test_static.py
git commit -m "feat: SessionStart hook で振り分けルールを注入する"
```

---

### Task 4: 振り分けの e2e と README

**Files:**
- Create: `tests/cases.tsv`
- Modify: `tests/e2e.sh`（`routing` / `all` モードと特別ケースを追加）
- Create: `README.md`
- Delete: `.spike/`（コミットしていない使い捨てのフォルダ）

**Interfaces:**
- Consumes: Task 2 の `check_run.py` CLI と e2e.sh の共通の実行コマンド。

- [ ] **Step 1: `tests/cases.tsv` を書く**

書式は `name<TAB>allowed<TAB>prompt`（1 行目はヘッダ）。

| name | allowed | prompt |
|--|--|--|
| design-light | use-opus-medium,use-opus-high | README.md の見出し構成をどう分けるとよいか、簡単に案を出して |
| design-heavy | use-fable-high,use-fable-xhigh | 複数リージョンにまたがるイベント駆動の決済システムで、整合性と障害復旧のトレードオフを比べて設計方針を考えて |
| impl-light | use-sonnet-high | README.md の誤字を 1 か所直して |
| impl-rename | use-sonnet-high | src/user.js の関数名 getUser を fetchUser にリネームして |
| impl-heavy | use-opus-high,use-opus-xhigh | 並行リクエストでの二重課金を防ぐため、決済 API に冪等キーとロックを実装して |
| review | use-opus-xhigh,use-fable-xhigh | このリポジトリの未コミットの変更をレビューして |
| explicit-fable | use-fable-high,use-fable-xhigh | Fable で、README.md の構成案を考えて |
| chat | none | こんにちは |

ファイルを編集するツールは `--disallowedTools` で禁止しているので、実装ケースでも実際のファイルは変わらない。判定と切り替えさえ起きれば十分。

- [ ] **Step 2: e2e.sh に `routing` モードを追加する**

cases.tsv の各行を、共通の実行コマンドで実行してから `check_run.py` で判定する。特別ケースを 2 つ追加する。
- `main-opus`: `MAIN=opus` で `impl-heavy` のプロンプトを実行する。許容は `use-opus-high,use-opus-xhigh`。加えて、出力のテキストに `/model sonnet` が含まれることを grep で確かめる。
- `continue`: 同じ作業ディレクトリで、まず `design-heavy` のプロンプトを実行し、続けて `claude -p --continue ...`（他のオプションは共通と同じ）で「続けて」を実行する。2 回目の結果を許容 `use-fable-high,use-fable-xhigh` で判定する。

`all` は `probe` と `routing` を順に実行する。

- [ ] **Step 3: ユーザーに routing を実行してもらう**

ユーザーにターミナルでの実行を依頼する: `zsh tests/e2e.sh routing`
Expected: `passed 10/10`

FAIL があれば、`tests/out/<name>.jsonl` の判定結果の行を見て routing.md の判定基準を直し、もう一度実行してもらう。3 回直しても通らないケースは、ユーザーに報告して許容リストを変えるか判断を仰ぐ。

- [ ] **Step 4: README.md を書く**

含める内容（それぞれ数行）:
- 何をするプラグインか（spec 1 章の要約）
- 使い方: `claude --plugin-dir <このリポジトリ>` で起動し、メインのモデルを `/model sonnet` にする
- 振り分け表（spec 5.1 章の表）。変えたいときは `hooks/routing.md` を編集する
- 制約: 切り替わるのはそのターンだけ。組織の `availableModels` 制限、プラン、auto モードの対応状況によっては、指定のモデルが使えない
- 費用について: 振り分けが起きたターンでは、Sonnet の判定が 1 回加わる。モデルが変わるとプロンプトキャッシュが効かず、会話全体を読み直す（spec 7 章）
- テスト: `python3 -m unittest discover tests` と `zsh tests/e2e.sh all`（API を呼ぶ。ログインが必要）

- [ ] **Step 5: 全体を確かめる**

Run: `python3 -m unittest discover tests -v`
Expected: PASS（14 tests）

Run: `claude plugin validate .`
Expected: エラーなし

- [ ] **Step 6: `.spike/` を削除してコミットする**

```bash
rm -rf .spike
git add tests/cases.tsv tests/e2e.sh README.md
git commit -m "test: 振り分けの e2e ケースと README を追加"
```
