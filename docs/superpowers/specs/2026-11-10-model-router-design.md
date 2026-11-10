# model-router プラグイン 設計

- 日付: 2026-11-10
- 元の要望: [docs/intent.md](../../intent.md)

## 1. 目的

Claude Code で、タスクの種類と難易度に応じてモデルと effort を自動で切り替える。コスト・品質・手動切替の手間を同程度に重視する。判定は Sonnet が行う（intent.md の「判定に Haiku か Sonnet」を満たす）。

## 2. 前提と制約

- プラグインからメインセッションのモデル・effort は直接変更できない。hook の `PreModelSwitch` は切替の許可・拒否しかできず、プラグインの `settings.json` は `model` / `effortLevel` を受け付けない。
- skill の frontmatter の `model` / `effort` は、その skill を呼んだターンの残りにだけ効く。次のターンはセッションのモデルに戻る。
- frontmatter の `effort` は 1 つの値しか書けない。effort に範囲を持たせたい場合は、組み合わせごとに skill を分ける。
- メインセッションは Sonnet で動かすことを前提にする。プラグインからは設定できないため、README で `/model sonnet` を案内する。

参照: https://code.claude.com/docs/en/skills.md 、 https://code.claude.com/docs/en/hooks.md 、 https://code.claude.com/docs/en/model-config.md 、 https://code.claude.com/docs/en/plugins-reference.md

## 3. 構成

```
model-router/                      # リポジトリのルート = プラグインのルート
├── .claude-plugin/plugin.json     # {"name": "model-router", ...}
├── hooks/
│   ├── hooks.json                 # SessionStart（matcher なし）で routing.md を注入
│   └── routing.md                 # 振り分け表・判定基準・ルール（Sonnet 向けの指示）
├── skills/
│   ├── use-sonnet-high/SKILL.md   # model: sonnet  effort: high
│   ├── use-opus-medium/SKILL.md   # model: opus    effort: medium
│   ├── use-opus-high/SKILL.md     # model: opus    effort: high
│   ├── use-opus-xhigh/SKILL.md    # model: opus    effort: xhigh
│   ├── use-fable-high/SKILL.md    # model: fable   effort: high
│   └── use-fable-xhigh/SKILL.md   # model: fable   effort: xhigh
├── tests/e2e.sh
└── README.md
```

### 3.1 hooks.json

`SessionStart` に matcher を付けない command hook を 1 つ置く。startup / resume / clear / compact のどれで起動しても、`${CLAUDE_PLUGIN_ROOT}/hooks/routing.md` の内容を `additionalContext` として出力する。上限は 10,000 文字なので、routing.md はそれより短く保つ。

### 3.2 skill（6 個）

それぞれの skill は、モデルと effort を切り替えるスイッチの役割だけを持つ。どのタスクでどれを使うかは routing.md に書く。

- frontmatter: `name`、`description`（「model-router の振り分けで選ばれたときに呼ぶ」旨）、`model`、`effort`
- 本文（短く）:
  - 「このターンは <モデル> / <effort> で実行中。ユーザーの依頼を続けよ」
  - 「自分が <モデル> でなければ、その旨を 1 行表示し、現在のモデルで続けよ」

## 4. データの流れ

1. セッション開始・compact・resume・clear のたびに、hook が routing.md を注入する。
2. ユーザーがメッセージを送ると、メインの Sonnet が作業前に 1 回だけ判定する。
3. Sonnet が判定結果を 1 行で表示し（例: `→ Opus / high（設計・調査 2）`）、該当する `use-*` skill を Skill ツールで呼ぶ。
4. そのターンの残りは、skill で指定したモデルと effort で実行される。
5. 次のターンはセッションのモデル（Sonnet）に戻り、2 から繰り返す。

## 5. 振り分けルール（routing.md の内容）

### 5.1 種類ごとの難易度の段階（1 が最も軽い）

| 種類 | 1 | 2 | 3 | 4 |
|--|--|--|--|--|
| 設計・調査 | use-opus-medium | use-opus-high | use-fable-high | use-fable-xhigh |
| 実装 | use-sonnet-high | use-opus-high | use-opus-xhigh | — |
| レビュー | use-opus-xhigh | use-fable-xhigh | — | — |

intent.md との対応:

- 設計・調査: シンプル = 段階 1〜2（Opus medium〜high）、複雑 = 段階 3〜4（Fable high〜xhigh）
- 実装: シンプル = 段階 1（Sonnet high）、複雑 = 段階 2〜3（Opus high〜xhigh）
- レビュー: 段階 1〜2（Opus〜Fable、xhigh）

### 5.2 難易度の判定基準

- 軽い側: 対象が 1〜2 ファイル、既存のパターンを踏襲する、答えがほぼ 1 つに決まる。
- 重い側: 複数のコンポーネントにまたがる、トレードオフを比べる必要がある、未知の領域、並行処理・セキュリティ・データ移行が絡む。
- 迷ったら 1 段重い側を選ぶ。

### 5.3 判定のルール

1. ユーザーのメッセージを受けたら、作業を始める前に 1 回だけ判定する。
2. 判定結果を 1 行で表示する。
3. 雑談や短い質問など表のどれにも当てはまらない場合は、skill を呼ばずに現在のモデルのまま答える。
4. ユーザーがモデルや effort を明示した場合（「Fable で」「もっと重く」など）は、その指定を優先する。
5. 自分が Sonnet でない場合は、最初の 1 回だけ `/model sonnet` を勧める。振り分けはそのまま続ける。

## 6. 失敗時の扱い

| 起きうること | 対処 |
|--|--|
| Claude が自分で呼んだ skill ではモデルが切り替わらない（未検証のリスク、7 章） | 実装の最初に e2e で確かめる。切り替わらなければ、6 個の skill を同じモデル×effort の subagent（`agents/*.md`）に置き換える設計に戻る |
| skill の `model` が無視される（組織の `availableModels` 制限、プランで Fable が使えない など） | skill 本文の指示で 1 行表示し、現在のモデルで続ける |
| 権限モードが auto のとき（plan モードで classifier が動いているときも同じ）、auto モードが対応していないモデルは使われない（skills.md に明記） | 同上。実装の最初に、auto モードでも e2e の probe を実行して確かめる |
| メインセッションが Sonnet ではない | ルール 5 で案内する。振り分けはそのまま動く |
| compact などでルールが消える | SessionStart に matcher を付けず、どの起動元でも注入し直す |
| 判定を誤った | 判定結果を 1 行表示しているので、ユーザーがルール 4 で上書きできる |

## 7. 未検証のリスク

- **Claude が自分で（Skill ツール経由で）呼んだ skill の `model` / `effort` が、そのターンに効くか。** ユーザーが `/` で呼んだ場合に `model` が効くことは確認済み（CLI 2.1.119、初期化時のモデルが haiku になった）。Claude が自分で呼んだ場合は、CLI が未ログインだったため確認できていない。
- 確認方法: 実装計画の最初のタスクとして `tests/e2e.sh` を作って実行し、Skill ツールを呼んだ後の assistant メッセージの `model` を見る。
- 結果が否定的だった場合は、6 章の代替案（subagent 方式）に切り替え、この spec を改訂する。
- **コストが増える場面がある。** 次の 2 つが重なる。
  - 振り分けが起きたターンでは、まず Sonnet が判定のために 1 回呼ばれ、その後に指定のモデルが動く。
  - プロンプトキャッシュはモデルごとに分かれている（Anthropic API の仕様）。そのため、モデルが切り替わったターンの最初のリクエストでは、会話全体をキャッシュなしで読み直す。effort を途中で変えた場合も、メッセージ部分のキャッシュが無効になる。
  - 会話が長いほど影響が大きい。短いタスクを Opus や Fable から Sonnet に下ろして得られる節約と、どちらが大きいかはまだ測っていない。測定は対象外（9 章）とし、運用してみて費用が増えたと感じたら検討する。
- **skill の effort が実際に効いたか。** e2e では、テスト専用の hook（Stop イベントの入力にある `effort.level`）で確かめる。そこに skill の effort が反映されない場合は、その結果をこの章に追記する。

## 8. テスト

1. `claude plugin validate .` が通ること。
2. `tests/e2e.sh`: 種類と難易度ごとの代表プロンプトを 8 本ほど用意し、それぞれに期待する skill 名を対応させる。`claude -p --plugin-dir . --model sonnet --output-format stream-json --verbose` で実行し、次の 2 点を確かめる。
   - 呼ばれた skill が期待どおりか（判定の精度）
   - skill を呼んだ後の assistant メッセージの `model` が期待どおりか（切り替えの効果）
   - テスト専用の Stop hook で記録した `effort.level` が、skill の effort と一致するか
   - プロンプトが実在するファイルを前提にできるよう、各ケースは小さなフィクスチャ（git リポジトリ）をコピーした一時ディレクトリで実行する。
   - 切り替えの probe は、既定の権限モードと auto モードの両方で実行する。加えて、デスクトップアプリの Code タブでも 1 回、手動で確かめる。
3. e2e.sh はログイン済みで新しい版の CLI を必要とし、1 回の実行で API を 8〜16 回ほど呼ぶ。そのため CI には入れず、手動で実行する。

## 9. 対象外

- Haiku による判定（アプローチ B / C）。Sonnet による判定の精度が足りないと分かったときに検討する。
- 判定結果の記録や統計。
- 振り分けによって費用が増えたか減ったかの測定（7 章）。
- 振り分け表のユーザー設定化（routing.md を直接編集すれば変えられる）。
