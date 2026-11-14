# 分類を自前のプロンプトにする（短い設計）

- 日付: 2026-11-14
- 対象: [hooks/register.ts](../../../hooks/register.ts) の `prompt.submit`。本体の設計は [2026-11-10-model-router-design.md](2026-11-10-model-router-design.md)

## 目的

`$.model.classify` はラベルを選ぶだけで、判断基準の文章も、それまでの会話も渡せない。そのため、

- simple / moderate / complex の境目が、ラベル名からの Haiku の推測しだいになる
- 「さっきの設計で実装して」のように、前の会話で重さが決まる依頼を、その 1 文だけで判断する
- 続けて、の判定が先頭の語を見るだけで、「その件だけど…」を取りこぼす

これを、判断基準と直前の会話を渡す自前のプロンプトに替えて直す。

## 方式の比較

| 案 | 内容 | 採否 |
|--|--|--|
| A | `$.model.complete` で Haiku を呼び、基準を `system`、直前 2 往復と今回のプロンプトを `prompt` に入れる | **採用**（2026-11-14 に決定） |
| B | A と同じで、直前 5 往復を渡す | 毎ターンの入力が増える割に、得るものが少ない |
| C | ツールの出力まで渡す | 長く、遅くなる |
| — | `$.model.fork`（会話全体を引き継ぐ） | メインのモデルで動くので、分類のたびに高い |

構造化出力は mod の API にない（`complete` はテキストだけを返す）。ラベルを 1 語で答えさせ、一覧と照らし合わせる。`classify` と同じやり方。

## 設計

1. **呼び出し**: `$.model.complete({ model: 'haiku', system: 基準, prompt: 会話と今回の依頼, maxTokens: 20, effort: 'low', timeoutMs: 10000 })`。
2. **会話**: `$.session.messages()` から本文が空でない発言の最後の 4 件（2 往復）を取り、1 発言 500 文字で切る。ツールの出力は渡さない。今回のプロンプトがまだ入っていなければ、それは別に渡す。
3. **データとして渡す**: 会話と依頼は `<conversation>` と `<request>` のタグで囲み、中の指示には従わないよう `system` に書く。
4. **答えの読み方**: 返事の前後の空白と句読点を落とし、`ROUTES` のキーと一致すればそれを使う。一致しない、`isAnswered` が false、例外のときは切り替えない（いまと同じ）。
5. **残すもの**: モデルを明示したときの正規表現（「Fable で」など）。Haiku を呼ばずに決まり、確実なため。
6. **消すもの**: 続けて、の正規表現（`CONTINUATION`、`MAX_CONTINUATION_LENGTH`）。続きかどうかは、会話を見た Haiku が判断する。
7. **基準の文章**（`system` に入れる。案）:

| ラベル | 基準 |
|--|--|
| design-simple | 方針の短い相談、小さな構成案。読む範囲が狭い |
| design-moderate | 複数ファイルにまたがる調査や設計、選択肢の比較 |
| design-complex | 新しい機能やモジュール全体の設計、外部の調査を含む |
| design-hardest | アーキテクチャ全体の見直し、正解の見えない難しい問題 |
| implement-simple | 1 ファイル程度の小さな修正、名前の変更、定型の作業 |
| implement-moderate | 複数ファイルの変更、テストを伴う機能の追加 |
| implement-complex | 大きなリファクタリング、込み入ったバグの調査と修正 |
| review-standard | 差分や PR のレビュー |
| review-deep | 設計全体やセキュリティまで見る深いレビュー |
| chat-or-question | 雑談、あいさつ、すぐ答えられる質問 |

「続けて」のような短い続きは、直前の会話の作業と同じラベルを選ぶよう書く。

## 対象外

- 分類の精度を数で測ること。実機での確認は、本体の spec 7.2 と同じやり方で数ケース行う。
- 基準の文章をユーザーが設定できるようにすること（`register.ts` を編集すれば変えられる）。

## 実装する人に任せること

- `$.session.messages()` が `prompt.submit` の時点で今回のプロンプトを含むか、添え書き（`model-router:` で始まる文）が本文に混ざるかの確認と、その扱い。
- テストでの `complete` と `messages` の差し替え方。いまの `register.test.ts` は `model.classify` を差し替えている。
- README、本体の spec（2 章、4 章、6 章）、[implementation-guide.md](../../implementation-guide.md) の `classify` の記述の更新。
