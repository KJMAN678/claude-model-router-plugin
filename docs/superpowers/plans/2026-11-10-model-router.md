# model-router 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** メインの Sonnet がタスクの種類と難易度を判定し、Agent ツールを表の `model` / `effort` で呼んで作業を subagent に任せる Claude Code プラグインを作る。

**Architecture:** SessionStart hook が `hooks/routing.md`（振り分けルール）をコンテキストに注入する。Sonnet はそのルールに従い、「メインで実行」か「Agent ツールを `model` と `effort` を付けて呼ぶ」かを選ぶ。モデル×effort ごとのファイルは置かない。

**Tech Stack:** Claude Code プラグイン（Markdown + JSON）、zsh、python3 標準ライブラリのみ（テスト用）

**Spec:** [docs/superpowers/specs/2026-11-10-model-router-design.md](../specs/2026-11-10-model-router-design.md)

## 改訂履歴

- 2026-11-11: skill 方式から subagent 方式へ変更（spec 7.1）。旧 Task 1（skill 6 個）と旧 Task 2（skill 用の判定器と probe）はコミット済みだが、この計画で置き換える。フィクスチャ（`tests/fixture/`）、`e2e.sh` の `run_case` の骨組み、marketplace 対応はそのまま使う。

## Global Constraints

- プラグイン名: `model-router`。リポジトリのルートがプラグインのルート。
- 組み合わせは次の 5 個と「メインで実行」だけ: `opus/medium`、`opus/high`、`opus/xhigh`、`fable/high`、`fable/xhigh`。
- Agent ツールの呼び出しは `subagent_type: general-purpose`。`model` には alias（`opus` / `fable`）を使う。
- SessionStart hook には matcher を付けない（startup / resume / clear / compact のすべてで注入する）。
- `routing.md` は 10,000 文字未満（`additionalContext` の上限）。
- プラグイン内のパスは `${CLAUDE_PLUGIN_ROOT}` で参照する。
- 外部依存は増やさない（zsh と python3 標準ライブラリのみ）。
- `tests/e2e.sh` は実際に API を呼び、v2.1.292 以上の CLI が必要（ユーザーの CLI は 2026-11-11 時点で 2.1.261 なので `claude update` が要る）。e2e はユーザーがターミナルで実行する。CI には入れない。

## Review Focus

1. **メインセッションが Sonnet 以外（例: Opus）で起動された場合** — 振り分けはそのまま動き、`/model sonnet` を勧める表示が 1 回出るべき。→ Task 4 の e2e `main-opus`。
2. **「続けて」などの文脈依存プロンプト** — 直前の種類と段階を引き継ぐべき。→ Task 4 の e2e `continue`（2 ターン、`--continue` を使う）。
3. **ユーザーがモデルを明示した場合（「Fable で」）** — 明示が優先されるべき。→ Task 4 の cases.tsv。
4. **compact / resume の後** — ルールが再注入されるべき。→ Task 3 の静的テストで、hooks.json に matcher が無いことを確かめる。
5. **routing.md を編集して上限を超えた場合** — 黙って切り捨てられるのを防ぐ。→ Task 3 の静的テストで 10,000 文字未満を確かめる。
6. **依頼文（spec 5.4）** — subagent が会話を読めない前提で書かれているか。→ Task 4 Step 3 で、e2e の出力から Agent ツールの `prompt` を数件読んで確かめる。

---

### Task 1: skill を削除する

**Files:**
- Delete: `skills/`（6 個の SKILL.md）
- Modify: `tests/test_static.py`（`SKILLS` と `test_skills_frontmatter` を削除し、`skills/` が無いことを確かめるテストに置き換える）
- Modify: `.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`（description を「タスクの種類と難易度に応じて、モデルと effort を指定した subagent に作業を任せる」に変える）

- [ ] **Step 1: テストを書き換える**

```python
def test_no_skills_dir(self):
    self.assertFalse((ROOT / "skills").exists())
```

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `python3 -m unittest tests/test_static.py -v`
Expected: `test_no_skills_dir` が FAIL

- [ ] **Step 3: `skills/` を削除し、description を変える**

Run: `git rm -r skills`

- [ ] **Step 4: テストが通ることを確かめる**

Run: `python3 -m unittest tests/test_static.py -v`
Expected: PASS（3 tests）

- [ ] **Step 5: コミット**

```bash
git add -A skills tests/test_static.py .claude-plugin
git commit -m "refactor: skill 方式をやめ、skill を削除する"
```

---

### Task 2: 判定器を Agent ツール用に書き換え、probe で切り替えを確かめる（ゲート）

spec 7.2 の「opus / fable と xhigh」「CLI での動作」を確かめる。**ここで切り替えが確認できなければ、以降のタスクには進まず、ユーザーに報告する。**

**Files:**
- Modify: `tests/check_run.py`
- Modify: `tests/test_check_run.py`
- Modify: `tests/e2e.sh`

**Interfaces:**
- Produces: `python3 tests/check_run.py <run.jsonl> <allowed>`。PASS / FAIL と理由を 1 行表示し、PASS なら exit 0、FAIL なら exit 1。`<allowed>` はカンマ区切りの組み合わせ（`opus-high,opus-xhigh` など）か `main`。
- Produces: `tests/e2e.sh <mode>`（`probe` / `routing` / `all`）。各ケースの PASS / FAIL を 1 行ずつ表示し、最後に `passed N/M`。FAIL があれば exit 1。

- [ ] **Step 1: 判定器の失敗するテストを書く**

`tests/test_check_run.py` を書き換える。stream-json の行を組み立てるヘルパー:
- `agent_call(model, effort)`: メインの assistant 行。`content` に `{"type": "tool_use", "name": "Agent", "input": {"subagent_type": "general-purpose", "model": ..., "effort": ..., "prompt": "..."}}`。`parent_tool_use_id` は null。
- `sub_msg(model)`: subagent の assistant 行。`parent_tool_use_id` に任意の文字列、`message.model` に完全なモデル ID（例 `claude-opus-5-5`）。
- `main_msg(model)`: メインの assistant 行（テキストだけ）。

ケース:
1. `opus-high` を呼び、subagent が opus → PASS
2. `opus-high` を呼び、subagent が sonnet → FAIL（「切り替わらなかった」）
3. `fable-xhigh` を呼んだが許容は `opus-high` → FAIL（「想定外」）
4. Agent を呼ばず、許容が `main` → PASS
5. Agent を呼んだのに許容が `main` → FAIL
6. 許容が `opus-high` なのに Agent を呼ばない → FAIL
7. Agent を呼んだが subagent の行が無い → FAIL
8. ツール名が `Task`（旧名）でも Agent と同じに扱う → PASS
9. JSON でない行は無視する → PASS

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `python3 -m unittest tests/test_check_run.py -v`
Expected: FAIL

- [ ] **Step 3: `tests/check_run.py` を書き換える**

- `parse_run(lines)` → `Run(calls: list[str], sub_models: list[str])`。`calls` は `parent_tool_use_id` が null の assistant 行にある、名前が `Agent` か `Task` の tool_use の `f"{model}-{effort}"`。`sub_models` は `parent_tool_use_id` が付いた assistant 行の `message.model`。
- `check(run, allowed)`: Step 1 のケースどおり。切り替えの判定は、最後の呼び出しの model alias（`opus` など）が `sub_models` のすべてに含まれること。
- 旧版の `stop_efforts` と hooks.jsonl の引数は削除する（spec 8 章の 3）。

- [ ] **Step 4: テストが通ることを確かめる**

Run: `python3 -m unittest tests/test_check_run.py -v`
Expected: PASS（9 tests）

- [ ] **Step 5: `tests/e2e.sh` を書き換える**

- `run_case NAME ALLOWED PROMPT` から、Stop hook 用の settings の書き出しと `--settings` を削除する。`check_run.py` の第 3 引数も削除する。それ以外（フィクスチャのコピー、`--disallowedTools "Edit Write NotebookEdit Bash"`、stream-json）はそのまま。subagent の作業も数えるため `--max-turns` は 10 にする。
- `probe` モードは 4 ケース:
  - `probe-opus`: プロンプト「Agent ツールを subagent_type=general-purpose, model=opus, effort=xhigh で呼び、subagent に 1 語で挨拶させて」、許容 `opus-xhigh`
  - `probe-fable`: 同じく model=fable, effort=high、許容 `fable-high`
  - `probe-opus-auto` / `probe-fable-auto`: 上の 2 つに `EXTRA="--permission-mode auto"` を付ける

- [ ] **Step 6: ユーザーに probe を実行してもらう（ゲート）**

ユーザーにターミナルでの実行を依頼する: `claude update` の後、`zsh tests/e2e.sh probe`
Expected: `passed 4/4`

- FAIL の場合 → **ここで停止**。`tests/out/<name>.jsonl` の該当行（Agent の入力と subagent の `model`）を報告する。
- `tests/out/probe-opus.jsonl` で、subagent の行に `parent_tool_use_id` が付いていること、Agent の入力キー名が `model` / `effort` であることを確かめる。違えば check_run.py とテストを直す。
- 結果を spec 7.1 の表に追記する。

- [ ] **Step 7: コミット**

```bash
git add tests/check_run.py tests/test_check_run.py tests/e2e.sh docs/superpowers/specs
git commit -m "test: 判定器を Agent ツール用に書き換え、probe を opus / fable で確かめる"
```

---

### Task 3: SessionStart hook と routing.md

**Files:**
- Create: `hooks/hooks.json`
- Create: `hooks/routing.md`
- Modify: `tests/test_static.py`

- [ ] **Step 1: 失敗するテストを追加する**

```python
COMBOS = ["opus/medium", "opus/high", "opus/xhigh", "fable/high", "fable/xhigh"]

def test_hook_has_no_matcher_and_cats_routing(self):
    h = json.loads((ROOT / "hooks/hooks.json").read_text())["hooks"]["SessionStart"]
    self.assertEqual(len(h), 1); self.assertNotIn("matcher", h[0])
    cmd = h[0]["hooks"][0]
    self.assertEqual(cmd["type"], "command")
    self.assertIn("${CLAUDE_PLUGIN_ROOT}/hooks/routing.md", cmd["command"])

def test_hook_command_outputs_routing(self):
    # cmd["command"] を CLAUDE_PLUGIN_ROOT=<ROOT> の環境で subprocess（shell=True）実行し、
    # stdout が hooks/routing.md の内容と一致すること

def test_routing_size_and_combos(self):
    text = (ROOT / "hooks/routing.md").read_text(encoding="utf-8")
    self.assertLess(len(text), 10000)
    for c in COMBOS: self.assertIn(c, text)
    self.assertIn("メインで実行", text)
```

- [ ] **Step 2: テストが失敗することを確かめる**

Run: `python3 -m unittest tests/test_static.py -v`
Expected: 新しく追加した 3 tests が FAIL（ファイルが無い）

- [ ] **Step 3: hooks.json と routing.md を作る**

hooks.json:

```json
{"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "cat \"${CLAUDE_PLUGIN_ROOT}/hooks/routing.md\""}]}]}}
```

routing.md: spec 5.1〜5.4 章を、Claude への命令文として書き直したもの。
- 冒頭: 「毎回ユーザーのメッセージを受けたら、作業の前にこの手順で判定する。表のセルが `メインで実行` ならそのまま作業し、それ以外なら Agent ツールを `subagent_type: general-purpose` と、セルの `model` / `effort` で呼ぶ」
- 表のセルは `opus / high` の形で書く。
- 判定結果の 1 行表示の書式: `→ <モデル> / <effort>（<種類> <段階>）`。メインで実行するときは `→ メインで実行（実装 1）`。
- 5.4 の依頼文の項目は箇条書きで、そのまま写す。

- [ ] **Step 4: テストが通ることを確かめる**

Run: `python3 -m unittest tests/test_static.py -v`
Expected: PASS（6 tests）

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
- Delete: `.spike/`

- [ ] **Step 1: `tests/cases.tsv` を書く**

書式は `name<TAB>allowed<TAB>prompt`（1 行目はヘッダ）。

| name | allowed | prompt |
|--|--|--|
| design-light | opus-medium,opus-high | README.md の見出し構成をどう分けるとよいか、簡単に案を出して |
| design-heavy | fable-high,fable-xhigh | 複数リージョンにまたがるイベント駆動の決済システムで、整合性と障害復旧のトレードオフを比べて設計方針を考えて |
| impl-light | main | README.md の誤字を 1 か所直して |
| impl-rename | main | src/user.js の関数名 getUser を fetchUser にリネームして |
| impl-heavy | opus-high,opus-xhigh | 並行リクエストでの二重課金を防ぐため、決済 API に冪等キーとロックを実装して |
| review | opus-xhigh,fable-xhigh | このリポジトリの未コミットの変更をレビューして |
| explicit-fable | fable-high,fable-xhigh | Fable で、README.md の構成案を考えて |
| chat | main | こんにちは |

ファイルを編集するツールは `--disallowedTools` で禁止しているので、実装ケースでも実際のファイルは変わらない。判定と切り替えさえ起きれば十分。

- [ ] **Step 2: e2e.sh に `routing` モードを追加する**

cases.tsv の各行を `run_case` で実行する。特別ケースを 2 つ追加する。
- `main-opus`: `MAIN=opus` で `impl-heavy` のプロンプトを実行する。許容は `opus-high,opus-xhigh`。加えて、出力のテキストに `/model sonnet` が含まれることを grep で確かめる。
- `continue`: 同じ作業ディレクトリで、まず `design-heavy` のプロンプトを実行し、続けて `claude -p --continue ...`（他のオプションは共通と同じ）で「続けて」を実行する。2 回目の結果を許容 `fable-high,fable-xhigh` で判定する。2 回目で SendMessage が使われた場合は、Agent の呼び出しが無くても PASS とする（check_run.py に `SendMessage` の扱いを足し、テストも 1 つ足す）。

`all` は `probe` と `routing` を順に実行する。

- [ ] **Step 3: ユーザーに routing を実行してもらう**

ユーザーにターミナルでの実行を依頼する: `zsh tests/e2e.sh routing`
Expected: `passed 10/10`

FAIL があれば、`tests/out/<name>.jsonl` の判定結果の行を見て routing.md の判定基準を直し、もう一度実行してもらう。3 回直しても通らないケースは、ユーザーに報告して許容リストを変えるか判断を仰ぐ。あわせて、Agent の `prompt` を 2〜3 件読み、spec 5.4 の項目が入っているかを確かめる。

- [ ] **Step 4: README.md を書く**

含める内容（それぞれ数行）:
- 何をするプラグインか（spec 1 章の要約）
- 使い方: マーケットプレイス `kjman678-plugins` から入れるか、`claude --plugin-dir <このリポジトリ>` で起動する。メインのモデルは `/model sonnet`、effort は `/effort high` にする。Claude Code v2.1.292 以上が必要
- 振り分け表（spec 5.1 章の表）。変えたいときは `hooks/routing.md` を編集する
- 制約: 重い作業は subagent が行うため、途中経過はメインの画面に流れず、結果を Sonnet が伝える。組織の `availableModels` 制限やプランによっては、指定のモデルが別のモデルに置き換えられる
- 費用について: 振り分けが起きたターンでは、Sonnet の判定・依頼文・結果の伝達が加わる（spec 7.2）
- テスト: `python3 -m unittest discover tests` と `zsh tests/e2e.sh all`（API を呼ぶ。ログインが必要）

- [ ] **Step 5: 全体を確かめる**

Run: `python3 -m unittest discover tests -v`
Expected: PASS（16 tests）

Run: `claude plugin validate .`
Expected: エラーなし

- [ ] **Step 6: `.spike/` を削除してコミットする**

```bash
git rm -r -q .spike
git add tests/cases.tsv tests/e2e.sh tests/check_run.py tests/test_check_run.py README.md
git commit -m "test: 振り分けの e2e ケースと README を追加"
```
