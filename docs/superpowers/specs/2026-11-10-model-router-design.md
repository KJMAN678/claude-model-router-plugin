# model-router プラグイン 設計

- 日付: 2026-11-10（改訂: 2026-11-11 skill → subagent、2026-11-12 subagent → mod。経緯は 9 章）
- 元の要望: [docs/intent.md](../../intent.md)

## 1. 目的

Claude Code で、タスクの種類と難易度に応じて、モデルと effort を自動で切り替える。コスト・品質・手動切替の手間を同程度に重視する。判定は Haiku が行う（intent.md の「判定に Haiku か Sonnet」を満たす）。

## 2. 方式

プラグインに mod（`hooks/hooks.json` の `modules` に書いた hooks モジュール）を入れ、2 つのフックで切り替える。

- `prompt.submit`: プロンプトの本文を `$.model.classify`（既定は小さく速いモデル、つまり Haiku）で分類し、ラベルから、そのターンのモデルと effort を決めてモジュール変数に持つ。
- `turn.step`: メインのリクエストを送る直前に、`model` と `effort` を持っている値に書き換える。`effort` の書き換えは次のステップに引き継がれないので、毎ステップ指定する。

subagent に作業を任せる方式と違い、会話しているモデル自体が替わるので、文脈を依頼文に書き直す必要がなく、途中経過もそのまま画面に流れる。

### 要件

- Claude Code v2.1.309 以上。根拠は、別に得た調査レポートにある「mod は v2.1.287 以降、`opus` のような短い名前は v2.1.309 以降」で、公式ドキュメントでは確かめていない。確認できているのは、2.1.321 で動くことと、2.1.261 には `claude plugin test` がないこと。
- mod が動くのは、ターミナルと Claude Desktop の Code タブ。

## 3. 構成

```
model-router/                      # リポジトリのルート = プラグインのルート
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json           # kjman678-plugins
├── hooks/
│   ├── hooks.json                 # {"modules": ["./register.ts"]}
│   ├── register.ts                # ラベル表と 2 つのフック
│   └── register.test.ts           # claude plugin test で実行する単体テスト
├── tests/test_static.py           # manifest などの静的な確認
└── README.md
```

## 4. 振り分けルール（`hooks/register.ts`）

### 4.1 ラベルとモデル・effort（種類ごとの難易度の段階）

| ラベル | モデル / effort |
|--|--|
| design-simple / moderate / complex / hardest | opus / medium、opus / high、fable / high、fable / xhigh |
| implement-simple / moderate / complex | sonnet / high、opus / high、opus / xhigh |
| review-standard / deep | opus / xhigh、fable / xhigh |
| chat-or-question | 切り替えない（セッションのモデルのまま） |

intent.md との対応: 設計・調査のシンプル = Opus medium〜high、複雑 = Fable high〜xhigh。実装のシンプル = Sonnet high、複雑 = Opus high〜xhigh。レビュー = Opus〜Fable の xhigh。

`$.model.classify` は、ラベルを選ぶだけで基準の文章は渡せない。そのため、ラベル名で意味が分かるようにしている。

### 4.2 判定のルール

1. スラッシュコマンドと、人が打っていないプロンプト（`e.command`、`e.isMeta`）では、判定を変えない。
2. 「Fable で」「opus を使って」のようなモデルの明示は、分類より優先する（effort は high）。
3. 30 文字以下で「続けて」「そこ」「それ」「さっき」などで始まる短い続きは、分類せず、直前の判定を引き継ぐ。
4. それ以外は Haiku で分類する。ラベルが得られない、または分類に失敗したときは、切り替えない。
5. subagent のステップ（`agentId` が付く）には手を出さない。
6. 判定結果をステータス行に `→ opus / high` の形で出す。

## 5. 失敗時の扱い

| 起きうること | 対処 |
|--|--|
| 分類が失敗した、ラベルが決まらない | 切り替えず、セッションのモデルで続ける |
| 指定のモデルが使えない（`availableModels` の制限、プランで Fable が使えない など） | Claude Code が別のモデルに置き換える |
| mod を再読み込みした | モジュール変数が消えるので、続けて、の引き継ぎが 1 回外れる |
| 続けて、の言い方が想定外 | 分類される。誤分類は、モデルを明示して上書きできる |
| 古い Claude Code | mod が動かない（要件は 2 章） |

## 6. 未検証のリスク

- **費用。** モデルが変わるターンでは、プロンプトキャッシュがモデルごとに分かれているため、会話全体を読み直す。分類の Haiku 呼び出しも毎回加わる。会話が長いほど影響が大きく、切り替えで得られる節約と、どちらが大きいかは測っていない（8 章の対象外）。
- **分類の精度。** テストでは分類結果を差し替えているので、Haiku が表どおりのラベルを選ぶかは、実機の確認が 3 ケース（7 章）だけ。実装とレビューの分類は、実機では試していない。
- **続けて、の判定。** 先頭の語を見る簡単な方法。「その件だけど…」のような言い方は取りこぼす。
- **名乗りとのずれ。** 切り替えたモデルは、自分をセッションのモデルだと名乗る。コミット署名もセッションのモデルになる（7.2）。
- **別のモデルに置き換えるフックとの併用。** 他の mod が `turn.step` で `model` を書き換えると、後に動くものが優先される。

## 7. 検証

### 7.1 単体テスト（API は呼ばない）

- `python3 -m unittest discover tests`: manifest、marketplace、`hooks.json` が mod のモジュールだけを読むこと。
- `claude plugin test .`（2.1.321 で実行。2.1.261 にはない）: 分類結果を差し替えて、次の 6 ケースを確かめる。
  - 分類によるモデルと effort の切り替え
  - 雑談は切り替えない
  - 短い続きは、分類せず直前の判定を引き継ぐ
  - 明示したモデルは分類より優先する
  - subagent のステップは書き換えない
  - 分類が失敗したら切り替えない
- `claude plugin validate .`: `prompt.submit` と `turn.step` を hook し、`$.model.classify` と `$.ui.status` を呼ぶことの確認。

### 7.2 実機の確認（2026-11-12、デスクトップアプリ、Claude Code 2.1.321）

このセッションに mod を読み込んで、プロンプトを送り、セッション記録の `requestedModel`、`message.model`、`effort` を見た。

| プロンプト | 想定 | 実際 |
|--|--|--|
| こんにちは | 切り替えない | sonnet-5-5 / high |
| README.md の構成案を簡単に考えて | opus / medium | opus-5-5 / medium |
| Fable で、一言あいさつして | fable / high | fable-5-2 / high |

- 記録には、分類の Haiku 呼び出しが残らない。1 つ目は、切り替わっていないことしか言えない。2 つ目と 3 つ目で、mod が動いていることが確かめられた。
- 試験で使った mod は `~/.claude/dev-mods/` の下にあったもので、このリポジトリの `hooks/` に取り込んだものと同じ中身。

インストールした 0.2.0 での確認（2026-11-13、デスクトップアプリ、GitHub の `main` から取得）:

| セッション | プロンプト | 想定 | 実際 |
|--|--|--|--|
| インストール前から動いていたセッション（`/reload-plugins` 後） | Fable で、一言あいさつして | fable / high | opus-5-5 / high（切り替わらない） |
| 新しく開いたセッション（メインは Sonnet） | Fable で、一言あいさつして | fable / high | fable-5-2 / high |

- すでに動いているセッションには、`/reload-plugins` をしても、インストールした版の mod は読み込まれなかった。新しく開いたセッションでは動く。
- mod は送り先のモデルを変えるが、システムプロンプトの名乗り（「Sonnet 5.5 で動いている」）とコミット署名は変えない。新しいセッションの Fable は、自分を Sonnet だと答えた。モデルの自己申告で切り替えを判断してはいけない。

## 8. 対象外

- 判定結果の記録や統計。
- 振り分けによって費用が増えたか減ったかの測定（6 章）。
- 振り分け表のユーザー設定化（`hooks/register.ts` を直接編集すれば変えられる）。
- 古い Claude Code（v2.1.309 より前）への対応。

## 9. 経緯: skill 方式と subagent 方式

最初の案は、モデル×effort ごとの skill を Sonnet が呼ぶ方式だった。Claude が自分で（Skill ツールで）呼んだ skill では、`model` が効かないことが分かり、subagent 方式（Agent ツールに `model` と `effort` を渡し、作業を subagent に任せる）に変えた。subagent 方式は、デスクトップで 10 ケースすべて期待どおりに動いた。その後、mod の `turn.step` で、メインのモデルそのものを切り替えられると分かり、文脈を書き直す必要がなく、途中経過も見えるため、mod 方式に置き換えた。

subagent 方式の長所は、モデルが変わってもキャッシュを読み直さないことと、古い Claude Code でも動くこと。短所は、依頼文に文脈を書き直す必要があり、途中経過が見えないこと。コミット `4ebd3cd` までが、この方式の実装。

### 9.1 skill 方式と subagent 方式の確認（2026-11-11、デスクトップアプリの Code タブ、Claude Code 2.1.321、メインは Opus 5.5）

確認には、セッション記録（`~/.claude/projects/<project>/<session>.jsonl`）の assistant 行にある `requestedModel`（送ったモデル）、`message.model`（応答したモデル）、`effort` を使った。

| 試したこと | 権限モード | 結果 |
|--|--|--|
| Claude が Skill ツールで `use-sonnet-high`（`model: sonnet`）を呼ぶ | auto | 切り替わらない。skill の後も opus-5-5 に送られた |
| 同上 | default | 切り替わらない（2 回目の呼び出しは「読み込み済み」として省略された） |
| Agent ツールを `model: sonnet`、`effort: medium` で呼ぶ | default | 切り替わる。subagent は sonnet-5-5 に送られ、effort は medium だった |
| Agent ツールを `model: opus`、`effort: xhigh` で呼ぶ | default | 切り替わる。opus-5-5 に送られ、effort は xhigh だった |
| Agent ツールを `model: fable`、`effort: high` で呼ぶ | default | 切り替わる。fable-5-2 に送られ、effort は high だった |

#### 9.1.1 プラグイン 0.1.1 を使った振り分けの実機確認（2026-11-12、デスクトップアプリ）

デスクトップに入れた model-router 0.1.1（e995abe）で、メインを Sonnet 5.5、権限モードを plan にした新しいセッションに、`tests/cases.tsv` のプロンプトを送った。判定は assistant の表示、渡した引数と実送信は記録の `Agent` の入力と subagent の `api-request` で見た。

| ケース | 判定の表示 | Agent に渡した値 | subagent の実送信 | 結果 |
|--|--|--|--|--|
| design-heavy | fable / xhigh（設計・調査 4） | fable / xhigh | fable-5-2 / xhigh | PASS |
| design-light | opus / medium（設計・調査 1） | opus / medium | opus-5-5 / medium | PASS |
| impl-light | メインで実行（実装 1） | なし | — | PASS |
| impl-rename | メインで実行（実装 1） | なし | — | PASS |
| review | opus / xhigh（レビュー 1） | opus / xhigh | opus-5-5 / xhigh | PASS |
| explicit-fable | fable / high（設計・調査 3） | fable / high | fable-5-2 / high | PASS |
| chat | 表示なし | なし | — | PASS |
| continue（design-heavy の後に「続けて」） | — | 新しい Agent は呼ばず、SendMessage で同じ subagent に続けた | fable-5-2 / xhigh | PASS |
| impl-heavy | opus / xhigh（実装 3） | Explore（モデル指定なし） | sonnet-5-5 / high | plan モードでは未確認（下の再確認で PASS） |
| main-opus（メインが Opus） | opus / xhigh（実装 3）、`/model sonnet` を案内 | なし | — | plan モードでは未確認（下の再確認で PASS） |

- impl-heavy と main-opus は、plan モードのため「実装は subagent に任せられない」とメインが判断し、先に調査をした。判定は正しいが、委譲は plan モードでは確かめられていない。default モードで再実行した結果は次の表。

再実行（default モード、2026-11-12）:

| ケース | 判定の表示 | Agent に渡した値 | subagent の実送信 | 結果 |
|--|--|--|--|--|
| impl-heavy（メインは Sonnet） | opus / xhigh（実装 3） | opus / xhigh | opus-5-5 / xhigh | PASS |
| main-opus（メインは Opus） | opus / xhigh（実装 3）、`/model sonnet` を案内 | opus / xhigh | opus-5-5 / xhigh | PASS |

- メインが Opus でも、ルールどおり同じモデルの subagent に任せた。メインと subagent が同じモデルになるので、この場合は費用が減らず、依頼文の作成分だけ増える。気になる場合は、routing.md に「メインがすでに表のモデルなら、メインで実行」を足す。
- 「続けて」は、別セッションから SendMessage で送ったため、ユーザーが直接入力した場合とは経路が違う。
- 依頼文は、原文、制約、返してほしいもの、質問を返す注記がそろっていた（design-heavy で確認）。

- skill を呼ぶと、システムプロンプトの名乗り（「Sonnet 5.5 で動いている」）とコミット署名だけは書き換わった。実際の送り先は変わらなかった。そのため、モデルの自己申告では切り替わったかどうかを判断できない。
- ユーザーが `/` で skill を呼んだ場合は、CLI 2.1.119 で初期化時のモデルが haiku に変わった（改訂前に確認）。自動の振り分けには使えないので、この設計では使わない。

