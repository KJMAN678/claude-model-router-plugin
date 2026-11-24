# model-router

Claude Code の mod（プラグイン）。プロンプトを送るたびに、Haiku が依頼の種類（設計・調査 / 実装 / レビュー）と難易度を、判断基準と直前の会話をもとに分類し、**そのターンのメインのモデルと effort を切り替えます。** subagent に任せるのではなく、会話しているモデル自体が替わります。

## 使い方

Claude Code v2.1.309 以上を想定しています（mod の `turn.step` フックと、`opus` のような短いモデル名のため。公式ドキュメントでは未確認で、動作を確かめたのは 2.1.321 です）。mod が使えるのは、ターミナルと Claude Desktop の Code タブです。

```bash
claude --plugin-dir <このリポジトリ>
```

マーケットプレイス `kjman678-plugins` から入れる場合は、このリポジトリを marketplace として追加し、`model-router@kjman678-plugins` をインストールします。mod の読み込みを許可するかを、最初に聞かれることがあります。

## 振り分け表

[hooks/register.ts](hooks/register.ts) の `ROUTES` が、分類ラベルとモデル・effort の対応、`CRITERIA` が各ラベルの判断基準です。変えたいときは、このファイルを編集してください。

| 種類 | 軽い | | | 重い |
|--|--|--|--|--|
| 設計・調査 | opus / medium | opus / high | opus / high | fable / high |
| 実装 | sonnet / high | opus / high | fable / medium | — |
| 移行・性能最適化 | opus / high | — | — | — |
| レビュー | opus / high | opus / high | — | — |

- 雑談や短い質問は、sonnet / medium に切り替えます。
- 基準は [Which Claude model should you build with?](https://claude.dev/blog/which-claude-model-should-you-build-with/) に沿っています。既定は Opus、仕様が明確な作業は Sonnet、最も難しい作業は Fable です。Opus は high より上げず、先に Fable を使います。
- 判定結果は、ステータス行に `このターン: Opus / high（画面のモデル表示とは別）` の形で出ます。画面のモデル表示は、セッションに設定されたモデルのままです。
- 「Fable で」「opus を使って」のようにモデルを書けば、分類より優先されます（effort は high）。**Fable は、この書き方をしたときと、分類が最難関（design-hardest、implement-complex）のときに使います。**
- 「続けて」「そこを直して」のような短い続きは、Haiku が直前の会話を見て、同じ作業として分類します。
- 分類に失敗したときは、切り替えずにセッションのモデルで続けます。
- subagent の作業には手を出しません。
- 切り替えたターンは、プロンプトに「このターンは Opus が応答している」のような添え書きをつけ、モデルの名乗りを実際に合わせます（セッションに設定されたモデル名のままだと、名乗りがずれるため）。コミットの署名は、セッションのモデルのままです。

## 削減額の確認

`/model-router-savings [opus|sonnet|fable|haiku]` で、基準のモデル（既定は Opus）だけで動かした場合と、実際の料金を比べます。このセッションと、セッションをまたいだ累計について、実際の料金（応答 + 分類）、基準の料金、削減額を出します。

- 基準の料金は、実際と同じ入力・出力のトークン数を、基準の単価で計算し直したものです。モデルを切り替えたターンでは、キャッシュの書き込みの一部を、基準なら読み込みで済んだものとして直します（削減額を多く見積もらないため）。
- 単価は [hooks/savings.ts](hooks/savings.ts) の表（2026-11-03 時点の公式 API）です。表にないモデルは計算から外し、その旨を表示します。
- effort の差は含みません。subagent は、どちらの方式でも同じなので数えません。累計のリセットはありません。
- 設計は [docs/superpowers/specs/2026-11-16-savings-design.md](docs/superpowers/specs/2026-11-16-savings-design.md) です。

## 制約と費用

- 切り替わるのはそのターンだけです。次のプロンプトで、もう一度分類されます。
- 分類は、プロンプトごとに Haiku を 1 回呼びます。直前の会話（最後の 4 件、1 発言 500 文字まで。ツールの出力は除く）も毎回渡します。
- プロンプトキャッシュはモデルごとに分かれているので、モデルが変わるターンは、会話全体を読み直します。会話が長いほど影響が大きく、切り替えで安くなるとは限りません。測ってはいません。
- 組織の `availableModels` の制限やプランによっては、指定したモデルが別のモデルに置き換わります。

## テスト

```bash
python3 -m unittest discover tests
```

```bash
claude plugin test .
```

`claude plugin test` は、新しい Claude Code（2.1.321 で確認、2.1.261 にはありません）が必要です。API は呼びません（分類結果は、テストの中で差し替えています）。実機の確認は、プラグインを入れたセッションにプロンプトを送り、セッション記録の `requestedModel` と `effort` を見てください。

## 参照

- [Which Claude model should you build with? Fable, Opus, Sonnet, or Haiku](https://claude.dev/blog/which-claude-model-should-you-build-with/)
- [週間制限に3日で到達していたClaudeが、ModelとEffortの使い分けで5日持つようになった話](https://zenn.dev/sun_asterisk/articles/1d1c65b1fe409a)
