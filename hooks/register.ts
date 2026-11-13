import type { Register } from 'claude-code'

type Route = { model: string; effort: 'medium' | 'high' | 'xhigh' }

// 分類ラベル → モデルと effort。docs/superpowers/specs の 5.1 の表と同じ。null は切り替えない（セッションのモデルのまま）。
const ROUTES: Record<string, Route | null> = {
  'design-simple': { model: 'opus', effort: 'medium' },
  'design-moderate': { model: 'opus', effort: 'high' },
  'design-complex': { model: 'fable', effort: 'high' },
  'design-hardest': { model: 'fable', effort: 'xhigh' },
  'implement-simple': { model: 'sonnet', effort: 'high' },
  'implement-moderate': { model: 'opus', effort: 'high' },
  'implement-complex': { model: 'opus', effort: 'xhigh' },
  'review-standard': { model: 'opus', effort: 'xhigh' },
  'review-deep': { model: 'fable', effort: 'xhigh' },
  'chat-or-question': null,
}
const LABELS = Object.keys(ROUTES)

// 「Fable で」「opus を使って」のようなモデルの明示は、分類より優先する。
const EXPLICIT = /(fable|opus|sonnet)\s*(で|を使|に切り替)/i
// 「続けて」「そこを直して」のような短い続きは、分類せず直前の判定を引き継ぐ。
// ponytail: 先頭の語で見る簡易判定。取りこぼしが多ければ、直前の会話も分類に渡す。
const CONTINUATION = /^\s*(続けて|続き|つづけて|それで|そこ|それ|さっき|continue|go on)/i
const MAX_CONTINUATION_LENGTH = 30

const NAMES: Record<string, string> = { opus: 'Opus', fable: 'Fable', sonnet: 'Sonnet' }

// 切り替えても、セッション開始時の「You are powered by …」はセッションのモデルのまま。
// そのターンのプロンプトに添え書きして、名乗りを実際のモデルに合わせる（前の会話は書き換えないので、キャッシュは崩れない）。
function identityNote(pick: Route | null, hasNoted: boolean): string | undefined {
  if (pick) {
    const name = NAMES[pick.model] ?? pick.model
    return `model-router: このターンは ${name}（effort ${pick.effort}）が応答している。` +
      `システムが示す「You are powered by …」のモデル名はセッションに設定されたもので、このターンには当てはまらない。` +
      `自分のモデルを問われたら ${name} と答える。`
  }
  // 前のターンで添え書きしていたら、切り替えないターンでもそれを打ち消す。
  if (hasNoted) return 'model-router: このターンは切り替えなし。セッションに設定されたモデルが応答している。'
  return undefined
}

export const register: Register = on => {
  // ponytail: モジュール変数なので、mod の再読み込みで消える。続きの判定が 1 回外れるだけ。
  let pick: Route | null = null
  let hasNoted = false

  on('prompt.submit', async ($, e, next) => {
    // スラッシュコマンドと、人が打っていないプロンプトでは判定を変えない。
    // ponytail: このときは添え書きもしないので、直前の判定で切り替えたターンでも名乗りが合わない。
    if (e.command || e.isMeta) return next(e)

    const explicit = EXPLICIT.exec(e.text)
    if (explicit) {
      pick = { model: explicit[1]!.toLowerCase(), effort: 'high' }
    } else if (pick && e.text.length <= MAX_CONTINUATION_LENGTH && CONTINUATION.test(e.text)) {
      // 直前の判定をそのまま使う。
    } else {
      try {
        const label = await $.model.classify(e.text, LABELS)
        pick = label === undefined ? null : (ROUTES[label] ?? null)
      } catch {
        pick = null // 分類に失敗したら、切り替えずにセッションのモデルで続ける。
      }
    }
    // 画面のモデル表示はセッションの設定のままなので、このターンの実際の送り先だと分かる文言にする。
    $.ui.status(pick ? `このターン: ${NAMES[pick.model] ?? pick.model} / ${pick.effort}（画面のモデル表示とは別）` : undefined)
    const note = identityNote(pick, hasNoted)
    if (!note) return next(e)
    hasNoted = true
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  // リクエストを送る直前に、毎回呼ばれる。effort の書き換えは次のステップに引き継がれないので、毎回指定する。
  on('turn.step', async function* ($, e, next) {
    if (e.agentId || !pick) return yield* next(e) // subagent の手前は触らない
    return yield* next({ ...e, model: pick.model, effort: pick.effort })
  })
}
