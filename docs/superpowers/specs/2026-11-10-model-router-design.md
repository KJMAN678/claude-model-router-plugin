# model-router プラグイン 設計

- 日付: 2026-11-10（2026-11-11 改訂: skill 方式から subagent 方式へ変更。理由は 7 章）
- 元の要望: [docs/intent.md](../../intent.md)

## 1. 目的

Claude Code で、タスクの種類と難易度に応じてモデルと effort を自動で切り替える。コスト・品質・手動切替の手間を同程度に重視する。判定は Sonnet が行う（intent.md の「判定に Haiku か Sonnet」を満たす）。

## 2. 前提と制約

- プラグインからメインセッションのモデル・effort は直接変更できない。hook の `PreModelSwitch` は切替の許可・拒否しかできず、プラグインの `settings.json` は `model` / `effortLevel` を受け付けない。
- Claude が Skill ツールで呼んだ skill の frontmatter の `model` は効かない（7.1 で確認済み）。そのため skill ではなく subagent を使う。
- Agent ツールは呼び出しごとに `model`（alias: `sonnet` / `opus` / `haiku` / `fable`）と `effort`（`low` / `medium` / `high` / `xhigh` / `max`）を受け付ける。`effort` 引数は Claude Code v2.1.292 以上が必要。
- 組織の `availableModels` で禁止されたモデルを指定すると、Claude Code が別のモデルに置き換え、警告を表示する（sub-agents.md）。
- メインセッションは Sonnet で動かすことを前提にする。プラグインからは設定できないため、README で `/model sonnet` を案内する。

参照: https://code.claude.com/docs/en/sub-agents.md 、 https://code.claude.com/docs/en/hooks.md 、 https://code.claude.com/docs/en/model-config.md 、 https://code.claude.com/docs/en/plugins-reference.md

## 3. 構成

```
model-router/                      # リポジトリのルート = プラグインのルート
├── .claude-plugin/
│   ├── plugin.json                # {"name": "model-router", ...}
│   └── marketplace.json           # kjman678-plugins
├── hooks/
│   ├── hooks.json                 # SessionStart（matcher なし）で routing.md を注入
│   └── routing.md                 # 振り分け表・判定基準・ルール（Sonnet 向けの指示）
├── tests/
└── README.md
```

モデル×effort ごとのファイル（skill や `agents/*.md`）は置かない。組み合わせは routing.md の表に書き、Sonnet が Agent ツールの引数として渡す。

### 3.1 hooks.json

`SessionStart` に matcher を付けない command hook を 1 つ置く。startup / resume / clear / compact のどれで起動しても、`${CLAUDE_PLUGIN_ROOT}/hooks/routing.md` の内容を `additionalContext` として出力する。上限は 10,000 文字なので、routing.md はそれより短く保つ。

## 4. データの流れ

1. セッション開始・compact・resume・clear のたびに、hook が routing.md を注入する。
2. ユーザーがメッセージを送ると、メインの Sonnet が作業前に 1 回だけ判定する。
3. Sonnet が判定結果を 1 行で表示する（例: `→ Opus / high（設計・調査 2）`）。
4. 判定が「メインで実行」なら、Sonnet がそのまま作業する。
5. それ以外なら、Sonnet が Agent ツールを `subagent_type: general-purpose`、表の `model` と `effort`、依頼文（5.4）で呼ぶ。
6. subagent の結果が返ったら、Sonnet がユーザーに伝える。

## 5. 振り分けルール（routing.md の内容）

### 5.1 種類ごとの難易度の段階（1 が最も軽い）

| 種類 | 1 | 2 | 3 | 4 |
|--|--|--|--|--|
| 設計・調査 | opus / medium | opus / high | fable / high | fable / xhigh |
| 実装 | メインで実行 | opus / high | opus / xhigh | — |
| レビュー | opus / xhigh | fable / xhigh | — | — |

intent.md との対応:

- 設計・調査: シンプル = 段階 1〜2（Opus medium〜high）、複雑 = 段階 3〜4（Fable high〜xhigh）
- 実装: シンプル = 段階 1（Sonnet high。メインの Sonnet がそのまま実行する。subagent に渡すと文脈を依頼文に書き直す手間と費用がかかるため）、複雑 = 段階 2〜3（Opus high〜xhigh）
- レビュー: 段階 1〜2（Opus〜Fable、xhigh）

### 5.2 難易度の判定基準

- 軽い側: 対象が 1〜2 ファイル、既存のパターンを踏襲する、答えがほぼ 1 つに決まる。
- 重い側: 複数のコンポーネントにまたがる、トレードオフを比べる必要がある、未知の領域、並行処理・セキュリティ・データ移行が絡む。
- 迷ったら 1 段重い側を選ぶ。

### 5.3 判定のルール

1. ユーザーのメッセージを受けたら、作業を始める前に 1 回だけ判定する。
2. 判定結果を 1 行で表示する。
3. 雑談や短い質問など表のどれにも当てはまらない場合は、subagent を使わずにメインで答える。
4. ユーザーがモデルや effort を明示した場合（「Fable で」「もっと重く」など）は、その指定を優先する。
5. 「続けて」「そこを直して」など、直前に subagent に任せた作業の続きは、同じ種類と段階を引き継ぐ。SendMessage が使える環境なら同じ subagent に送り、使えなければ新しく Agent ツールを呼ぶ（その場合は直前の結果の要点も依頼文に入れる）。
6. subagent の作業中は、メインで同じ作業をしない。
7. 自分が Sonnet でない場合は、最初の 1 回だけ `/model sonnet` を勧める。振り分けはそのまま続ける。

### 5.4 subagent への依頼文

subagent はこの会話を読めない。依頼文だけで作業できるように、次を書く。

- ユーザーの依頼（原文のまま）
- 会話の中で決まったこと・制約・関係するファイルのパス
- 何を返してほしいか（設計なら結論と理由、実装なら変更したファイルと確認結果、レビューなら指摘の一覧）
- ユーザーに確かめないと決められないことが出たら、作業を止めて質問として返すこと（subagent はユーザーに直接質問できない）

## 6. 失敗時の扱い

| 起きうること | 対処 |
|--|--|
| 指定のモデルが使えない（`availableModels` 制限、プランで Fable が使えない など） | Claude Code が別のモデルに置き換えて警告を出す（2 章）。プラグイン側では何もしない |
| CLI が v2.1.292 より古く、`effort` 引数が使えない | README に必要な版を書く。どうしても古い版で使う場合は、組み合わせごとに `agents/*.md`（frontmatter に `model` と `effort`）を置く方式に切り替える |
| 依頼文に必要な文脈が足りず、subagent の結果がずれる | 5.4 の項目を routing.md に書く。結果がずれたら、ユーザーが追加の指示を出し、ルール 5 で同じ subagent に続けてもらう |
| メインセッションが Sonnet ではない | ルール 7 で案内する。振り分けはそのまま動く |
| compact などでルールが消える | SessionStart に matcher を付けず、どの起動元でも注入し直す |
| 判定を誤った | 判定結果を 1 行表示しているので、ユーザーがルール 4 で上書きできる |

## 7. 検証の記録と未検証のリスク

### 7.1 確認済み（2026-11-11、デスクトップアプリの Code タブ、Claude Code 2.1.321、メインは Opus 5.5）

確認には、セッション記録（`~/.claude/projects/<project>/<session>.jsonl`）の assistant 行にある `requestedModel`（送ったモデル）、`message.model`（応答したモデル）、`effort` を使った。

| 試したこと | 権限モード | 結果 |
|--|--|--|
| Claude が Skill ツールで `use-sonnet-high`（`model: sonnet`）を呼ぶ | auto | 切り替わらない。skill の後も opus-5-5 に送られた |
| 同上 | default | 切り替わらない（2 回目の呼び出しは「読み込み済み」として省略された） |
| Agent ツールを `model: sonnet`、`effort: medium` で呼ぶ | default | 切り替わる。subagent は sonnet-5-5 に送られ、effort は medium だった |

- skill を呼ぶと、システムプロンプトの名乗り（「Sonnet 5.5 で動いている」）とコミット署名だけは書き換わった。実際の送り先は変わらなかった。そのため、モデルの自己申告では切り替わったかどうかを判断できない。
- ユーザーが `/` で skill を呼んだ場合は、CLI 2.1.119 で初期化時のモデルが haiku に変わった（改訂前に確認）。自動の振り分けには使えないので、この設計では使わない。

### 7.2 未検証のリスク

- **opus / fable と xhigh を Agent ツールの引数で渡した場合。** 確認したのは sonnet / medium だけ。e2e の probe（8 章）で確かめる。
- **CLI（`claude -p`）での動作。** 確認したのはデスクトップアプリだけ。e2e の probe で確かめる。
- **判定と依頼文の質。** Sonnet が表どおりに判定し、5.4 を満たす依頼文を書けるか。e2e の routing（8 章）で判定を確かめる。依頼文の質は運用しながら見る。
- **費用。** 振り分けが起きたターンでは、Sonnet の判定と依頼文作成、subagent の作業、Sonnet による結果の伝達が加わる。一方、subagent は会話全体を読まずに依頼文から始めるため、skill 方式で心配していた「モデルを変えると会話全体をキャッシュなしで読み直す」問題は起きない。どちらが安いかは測っていない（9 章）。

## 8. テスト

1. `python3 -m unittest discover tests` と `claude plugin validate .` が通ること。
2. `tests/e2e.sh`（ログイン済みの v2.1.292 以上の CLI が必要。API を呼ぶので CI には入れず、手動で実行する）。`claude -p --plugin-dir . --model sonnet --output-format stream-json --verbose` で実行し、`tests/check_run.py` で次を判定する。
   - Agent ツールに渡した `model` / `effort` が期待どおりか（判定の精度）。期待値は `opus-high` のような組み合わせ、または subagent を使わないことを表す `main`。
   - subagent の assistant メッセージ（stream-json で `parent_tool_use_id` が付いたもの）の `model` が、渡した `model` と一致するか（切り替えの効果）。
   - probe: 「Agent ツールを model=opus, effort=xhigh で呼ぶ」「model=fable, effort=high で呼ぶ」の 2 ケース。既定の権限モードと auto モードの両方で実行する。
   - routing: 種類と難易度ごとの代表プロンプト 8 本ほど。各ケースは小さなフィクスチャ（git リポジトリ）をコピーした一時ディレクトリで実行する。
3. subagent の実際の effort は stream-json に出ないため、e2e では渡した値だけを確かめる。実際に効くことは 7.1 で一度確かめた。

## 9. 対象外

- Haiku による判定。Sonnet による判定の精度が足りないと分かったときに検討する。
- 判定結果の記録や統計。
- 振り分けによって費用が増えたか減ったかの測定（7.2）。
- 振り分け表のユーザー設定化（routing.md を直接編集すれば変えられる）。
