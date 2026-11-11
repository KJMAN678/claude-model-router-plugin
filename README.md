# model-router

Claude Code のプラグイン。依頼の種類（設計・調査 / 実装 / レビュー）と難易度に応じて、モデルと effort を指定した subagent に作業を任せます。判定は、メインのセッション（Sonnet 想定）が行います。

## 使い方

Claude Code v2.1.292 以上が必要です（Agent ツールの `effort` 引数）。

```bash
claude --plugin-dir <このリポジトリ>
```

マーケットプレイス `kjman678-plugins` から入れる場合は、このリポジトリを marketplace として追加し、`model-router@kjman678-plugins` をインストールします。

メインのモデルは Sonnet にしてください（`/model sonnet`）。プラグインからは設定できません。Sonnet でないときは、最初の 1 回だけ案内が出ます。

## 振り分け表

セッション開始・再開・clear・compact のたびに、[hooks/routing.md](hooks/routing.md) が読み込まれます。表を変えたいときは、このファイルを編集してください。

| 種類 | 1（軽い） | 2 | 3 | 4 |
|--|--|--|--|--|
| 設計・調査 | opus / medium | opus / high | fable / high | fable / xhigh |
| 実装 | メインで実行 | opus / high | opus / xhigh | — |
| レビュー | opus / xhigh | fable / xhigh | — | — |

- 判定結果は 1 行で表示されます（例: `→ opus / high（設計・調査 2）`）。「Fable で」のようにモデルを指定すれば、そちらが優先されます。
- 雑談や短い質問は、subagent を使わずにメインで答えます。

## 制約

- skill の `model` は、Claude が自分で呼んだ場合には効きません（[spec](docs/superpowers/specs/2026-11-10-model-router-design.md) の 7.1）。そのため subagent に作業を任せる方式にしています。
- 重い作業は subagent が行うので、途中経過はメインの画面に流れません。結果をメインが伝えます。
- 組織の `availableModels` の制限やプランによっては、指定したモデルが別のモデルに置き換えられ、警告が出ます。

## 費用

振り分けが起きたターンでは、メインの判定と依頼文の作成、結果の伝達が加わります。subagent は会話全体を読まずに依頼文から始めるので、モデルを切り替えるたびに会話全体を読み直すことはありません。振り分けで費用が増えたか減ったかは、測っていません。

## テスト

```bash
python3 -m unittest discover tests
```

```bash
zsh tests/e2e.sh all
```

`e2e.sh` は実際に API を呼びます。ログイン済みで、v2.1.292 以上の CLI が必要です。結果は `tests/out/` に出ます。
