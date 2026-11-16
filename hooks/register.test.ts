// hooks/register.ts の単体テスト（`claude plugin test .` で動く。API は呼ばない）。
//
// 本物の Haiku は呼ばず、エンジンの代わりに次の 2 つを差し替える。
//   ・Haiku の返事（reply）と、それまでの会話（messages）
//   ・モデルへのリクエスト（turn.step）。ここに渡った model と effort を記録して、書き換えを確かめる
// セッションのモデルは、すべてのテストで sonnet / high とする（step の入力と同じ値）。
// そのため、model が 'sonnet' のままなら「切り替えなかった」、別のモデルなら「切り替えた」と読める。
//
// テストは次の 5 つに分かれている。
//   1. 振り分けの基本（ラベル → モデルと effort）
//   2. 名乗りの添え書き
//   3. Haiku に渡すもの（判断基準と、直前の会話）
//   4. Haiku の返事が使えないとき
//   5. 削減額の記録と /savings
import { expect, test } from 'claude-code/testing'

type Msg = { role: 'user' | 'assistant'; text: string }
// Haiku の返事の差し替え。文字列 = 答えた内容、Error = 呼び出しが例外で失敗、{ isAnswered: false } = API が答えなかった。
type Reply = string | Error | { isAnswered: false }

// register.ts の ROUTES のラベルと同じ。判断基準（CRITERIA）にすべて入っているかを確かめるのに使う。
const LABELS = [
  'design-simple', 'design-moderate', 'design-complex', 'design-hardest',
  'implement-simple', 'implement-moderate', 'implement-complex',
  'review-standard', 'review-deep', 'chat-or-question',
]

/**
 * ベースにあるエンジンの代わりに、Haiku の返事と会話を差し替え、turn.step が受け取った model / effort を記録する。
 *
 * @param on テストが渡す、フックの登録関数。差し替えのフックは、テスト対象の mod の下に置かれる。
 * @param reply Haiku の返事を返す関数（Reply を参照）。テストの途中で返す値を変えられるよう、値でなく関数にしている。
 * @param messages それまでの会話を返す関数。Error を返すと、会話の読み込みが失敗した状況になる。省略すると空の会話。
 * @returns 各テストが確かめたい値が溜まるオブジェクト `seen`。
 *   - model / effort: turn.step が受け取った値（register.ts が書き換えたあと）
 *   - classified: Haiku を呼んだ回数
 *   - request: Haiku を呼んだときの引数（model、system、prompt など）
 *   - context: prompt.submit が足した添え書き
 */
function setup(on: any, reply: () => Reply, messages: () => Msg[] | Error = () => [], stepUsage: () => unknown = () => null) {
  const seen = {
    model: '', effort: undefined as unknown, classified: 0, context: [] as readonly string[], request: undefined as any,
    store: {} as Record<string, unknown>, saves: 0,
  }
  // $.store の差し替え。テストごとに空の保存先から始まる（seen.store に事前に値を入れれば、それを読む）。
  on('store.get', (_: unknown, e: { key: string }) => ({ value: seen.store[e.key] }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    seen.store[e.key] = e.value
    seen.saves++
    return { value: undefined }
  })
  // /savings の登録とセッションの開始の差し替え（runSavings が使う）。
  on('command.register', () => ({ value: { command: 'savings' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  // $.model.complete の差し替え。Haiku の代わりに reply() の内容を返す。
  on('model.complete', (_: unknown, e: any) => {
    seen.classified++
    seen.request = e
    const r = reply()
    if (r instanceof Error) throw r
    const usage = { input_tokens: 100, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    if (typeof r !== 'string') return { value: { isAnswered: false, reason: 'api-error', status: 500, error: 'api_error', usage } }
    return { value: { isAnswered: true, text: r, usage } }
  })
  // $.session.messages の差し替え。それまでの会話を返す（Error なら読み込みの失敗）。
  on('session.messages', () => {
    const m = messages()
    if (m instanceof Error) throw m
    return { value: m.map(x => ({ ...x, toolUses: [] })) }
  })
  // 添え書き（context）を記録する。register.ts が next に渡した値が、ここに届く。
  on('prompt.submit', (_: unknown, e: { text: string; context?: readonly string[] }) => {
    seen.context = e.context ?? []
    return { text: e.text }
  })
  // モデルへのリクエストの差し替え。register.ts が書き換えたあとの model と effort を記録する。
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number; model: string; effort?: unknown }) {
    seen.model = e.model
    seen.effort = e.effort
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: stepUsage() }
  })
  return seen
}

/**
 * モデルへのリクエストを 1 回送る（セッションのモデルは sonnet / high）。
 *
 * @param $ テストが渡す、エンジンの API。
 * @param agentId 指定すると、subagent のリクエストとして送る。省略すると、メインのリクエスト。
 * @returns リクエストの処理が終わると解決する Promise。結果は返さず、setup の `seen` に model と effort が記録される。
 */
async function step($: any, agentId?: string) {
  const s = $.turn.step({ turnId: 't', index: 0, model: 'sonnet', effort: 'high', messageCount: 1, agentId })
  for await (const _ of s) { /* 流れてくる chunk は使わない */ }
}

// ---- 1. 振り分けの基本（ラベル → モデルと effort） ----

// 重いレビューのラベル（review-deep）なら、opus / xhigh に切り替わる。
test('a review prompt switches the main model to opus xhigh', async ($, on) => {
  const seen = setup(on, () => 'review-deep')
  await $.prompt.submit({ text: 'この変更をレビューして' })
  await step($)
  expect(seen.model).toBe('opus')
  expect(seen.effort).toBe('xhigh')
})

// Fable は、プロンプトに「Fable で」と書いたときだけ使う。分類の結果（どのラベル）では、fable にならない。
test('no classification label routes to fable', async ($, on) => {
  let label = 'chat-or-question'
  const seen = setup(on, () => label)
  for (const l of LABELS) {
    label = l
    await $.prompt.submit({ text: '何かして' })
    await step($)
    expect(seen.model).not.toBe('fable')
  }
})

// 雑談のラベル（chat-or-question）なら切り替えず、セッションの sonnet / high のまま。
test('a chat prompt keeps the session model', async ($, on) => {
  const seen = setup(on, () => 'chat-or-question')
  await $.prompt.submit({ text: 'こんにちは' })
  await step($)
  expect(seen.model).toBe('sonnet')
  expect(seen.effort).toBe('high')
})

// 「Fable で」のようにモデルを書いたら、Haiku を呼ばずにそのモデル（effort high）にする。
// Haiku の返事は implement-simple（sonnet）にしてあるので、fable になれば明示が勝ったことが分かる。
test('an explicit model wins over the classifier', async ($, on) => {
  const seen = setup(on, () => 'implement-simple')
  await $.prompt.submit({ text: 'Fable で、構成案を考えて' })
  await step($)
  expect(seen.classified).toBe(0)
  expect(seen.model).toBe('fable')
  expect(seen.effort).toBe('high')
})

// subagent のリクエスト（agentId つき）は書き換えない。メインの判定が review-deep でも、sonnet のまま。
test('a subagent step is left alone', async ($, on) => {
  const seen = setup(on, () => 'review-deep')
  await $.prompt.submit({ text: 'レビューして' })
  await step($, 'agent-1')
  expect(seen.model).toBe('sonnet')
})

// ---- 2. 名乗りの添え書き ----
// 切り替えても、システムプロンプトの「You are powered by …」はセッションのモデルのまま。
// そのため、切り替えたターンには添え書きをつけて、モデルが自分の名前を取り違えないようにしている。

// 切り替えたターンには、実際に応答するモデルの名前（Opus）を入れた添え書きが 1 つつく。
test('a switched turn tells the model which model answers', async ($, on) => {
  const seen = setup(on, () => 'review-deep')
  await $.prompt.submit({ text: 'レビューして' })
  expect(seen.context.length).toBe(1)
  expect(seen.context[0]).toContain('Opus')
})

// 添え書きの出し入れを、3 ターンの流れで確かめる。
//   1 ターン目 雑談（切り替えない）          → 添え書きなし（まだ何も言っていないので、打ち消す必要がない）
//   2 ターン目 実装（opus に切り替える）      → 「Opus が応答している」
//   3 ターン目 雑談（切り替えない）          → 前の添え書きを打ち消す「切り替えなし」
test('a chat turn adds no note until a switch happened', async ($, on) => {
  let label = 'chat-or-question'
  const seen = setup(on, () => label)
  await $.prompt.submit({ text: 'こんにちは' })
  expect(seen.context.length).toBe(0)
  label = 'implement-complex'
  await $.prompt.submit({ text: '決済 API に冪等キーを実装して' })
  expect(seen.context[0]).toContain('Opus')
  label = 'chat-or-question'
  await $.prompt.submit({ text: 'ありがとう' })
  expect(seen.context[0]).toContain('切り替えなし')
})

// ---- 3. Haiku に渡すもの（判断基準と、直前の会話） ----

// Haiku の呼び方: モデルは haiku、effort は low、返事は最大 20 トークン、10 秒で打ち切り。
// システムプロンプト（判断基準）には、10 個のラベルがすべて入っている。
test('the classifier is called with haiku, low effort and the criteria', async ($, on) => {
  const seen = setup(on, () => 'chat-or-question')
  await $.prompt.submit({ text: 'こんにちは' })
  expect(seen.request.model).toBe('haiku')
  expect(seen.request.effort).toBe('low')
  expect(seen.request.maxTokens).toBe(20)
  expect(seen.request.timeoutMs).toBe(10000)
  for (const label of LABELS) expect(seen.request.system).toContain(label)
})

// 「続けて」だけのプロンプトでも、直前の会話を一緒に渡す。会話に設計の依頼があるので、
// Haiku は設計（design-hardest）と判断でき、opus / xhigh になる。
test('a short continuation is classified with the recent conversation', async ($, on) => {
  const seen = setup(on, () => 'design-hardest', () => [
    { role: 'user', text: '決済システムを設計して' },
    { role: 'assistant', text: '案を 3 つ出しました' },
  ])
  await $.prompt.submit({ text: '続けて' })
  await step($)
  expect(seen.classified).toBe(1)
  expect(seen.request.prompt).toContain('決済システムを設計して')
  expect(seen.request.prompt).toContain('<request>')
  expect(seen.request.prompt).toContain('続けて')
  expect(seen.model).toBe('opus')
  expect(seen.effort).toBe('xhigh')
})

// 渡す会話は、本文のある最後の 4 件まで。1 件は 500 文字で切る。
//   'first' と 'zero'（古い 2 件）は渡さない。空の発言（''）は件数に数えない。
//   'second'・600 文字の発言・'third'・'fourth' の 4 件が残り、600 文字の発言は 500 文字で切れる。
test('only the last four non-empty messages are sent, each cut to 500 chars', async ($, on) => {
  const seen = setup(on, () => 'chat-or-question', () => [
    { role: 'user', text: 'first' },
    { role: 'assistant', text: 'zero' },
    { role: 'user', text: '' },
    { role: 'user', text: 'second' },
    { role: 'assistant', text: 'a'.repeat(600) },
    { role: 'user', text: 'third' },
    { role: 'assistant', text: 'fourth' },
  ])
  await $.prompt.submit({ text: 'こんにちは' })
  expect(seen.request.prompt).not.toContain('first')
  expect(seen.request.prompt).not.toContain('zero')
  expect(seen.request.prompt).toContain('second')
  expect(seen.request.prompt).toContain('third')
  expect(seen.request.prompt).toContain('fourth')
  expect(seen.request.prompt).toContain('a'.repeat(500))
  expect(seen.request.prompt).not.toContain('a'.repeat(501))
})

// このプラグインの添え書き（model-router: …）は、Haiku に渡さない。
// 添え書きは、直前のユーザーの発言の「後ろに続けて」記録されることがあるので、そのとおりの形で入れてある。
test("the router's own note is not sent to the classifier", async ($, on) => {
  const seen = setup(on, () => 'review-deep', () => [
    { role: 'user', text: 'レビューして' + 'model-router: このターンは Opus（effort high）が応答している。' },
  ])
  await $.prompt.submit({ text: 'お願いします' })
  expect(seen.request.prompt).not.toContain('model-router:')
  expect(seen.request.prompt).toContain('レビューして')
})

// 今回のプロンプトがすでに会話の最後に入っていても、二重には渡さない（本文に 1 回だけ出る）。
test('the current prompt is not repeated in the conversation', async ($, on) => {
  const seen = setup(on, () => 'review-deep', () => [
    { role: 'assistant', text: '直しました' },
    { role: 'user', text: 'この変更をレビューして' },
  ])
  await $.prompt.submit({ text: 'この変更をレビューして' })
  expect(seen.request.prompt.split('この変更をレビューして').length - 1).toBe(1)
})

// ツールを使ったターンでは、Claude の発言が何件も続く。続いた発言を 1 件にまとめるので、
// 最後の 4 件でも、最初のユーザーの依頼（決済システムの設計）が落ちずに残る。
//   まとめた結果: user（設計して）→ assistant（見ます〜案を 3 つ）→ user（2 案目で）→ assistant（詰めました）
test('consecutive messages from one side count as one, so the window keeps two exchanges', async ($, on) => {
  const seen = setup(on, () => 'design-hardest', () => [
    { role: 'user', text: '決済システムを設計して' },
    { role: 'assistant', text: '見ます' },
    { role: 'assistant', text: '読みました' },
    { role: 'assistant', text: '案を 3 つ出しました' },
    { role: 'user', text: '2 案目で' },
    { role: 'assistant', text: '詰めました' },
  ])
  await $.prompt.submit({ text: '続けて' })
  expect(seen.request.prompt).toContain('決済システムを設計して')
  expect(seen.request.prompt).toContain('見ます')
  expect(seen.request.prompt).toContain('案を 3 つ出しました')
})

// ---- 4. Haiku の返事が使えないとき ----
// どの場合も、作業は止めない。切り替えずに、セッションのモデルで続ける。

// 返事が「`implement-complex`。」のように余計な文字つきでも、ラベルを拾って opus / xhigh にする。
test('a reply with extra characters still matches', async ($, on) => {
  const seen = setup(on, () => ' `implement-complex`。\n')
  await $.prompt.submit({ text: '決済 API に冪等キーを実装して' })
  await step($)
  expect(seen.model).toBe('opus')
  expect(seen.effort).toBe('xhigh')
})

// 返事にラベルがない（'banana'）→ 切り替えない。
test('an unknown reply keeps the session model', async ($, on) => {
  const seen = setup(on, () => 'banana')
  await $.prompt.submit({ text: '何か実装して' })
  await step($)
  expect(seen.model).toBe('sonnet')
})

// API が答えなかった（isAnswered: false）→ 切り替えない。
test('an unanswered request keeps the session model', async ($, on) => {
  const seen = setup(on, () => ({ isAnswered: false }))
  await $.prompt.submit({ text: '何か実装して' })
  await step($)
  expect(seen.model).toBe('sonnet')
})

// Haiku の呼び出しが例外で失敗した → 切り替えない。
test('a failed classification falls back to the session model', async ($, on) => {
  const seen = setup(on, () => new Error('api down'))
  await $.prompt.submit({ text: '何か実装して' })
  await step($)
  expect(seen.model).toBe('sonnet')
})

// 会話が読めなくても（session.messages が失敗）、今回のプロンプトだけで分類して、opus に切り替える。
test('a failed messages read still classifies the request', async ($, on) => {
  const seen = setup(on, () => 'review-deep', () => new Error('no transcript'))
  await $.prompt.submit({ text: 'この変更をレビューして' })
  await step($)
  expect(seen.classified).toBe(1)
  expect(seen.model).toBe('opus')
})

// ---- 5. 削減額の記録と /savings ----
// メインのリクエストの usage と、分類の Haiku の usage を、$.store の 'savings-totals' に累計する。

const USAGE = { model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const totals = (seen: { store: Record<string, unknown> }) => seen.store['savings-totals'] as any

// メインのリクエストの usage が、応答したモデル（sonnet）の分として保存される。
test('a main step is recorded and saved', async ($, on) => {
  const seen = setup(on, () => 'chat-or-question', () => [], () => USAGE)
  await step($)
  expect(totals(seen).actual.sonnet.input).toBe(1000)
  expect(totals(seen).requests).toBe(1)
})

// subagent のリクエストは、どちらの方式でも同じなので数えない。
test('a subagent step is not recorded', async ($, on) => {
  const seen = setup(on, () => 'chat-or-question', () => [], () => USAGE)
  await step($, 'agent-1')
  expect(seen.saves).toBe(0)
})

// usage がない結果（中断や API エラー）は、何も足さない。
test('a step without usage records nothing', async ($, on) => {
  const seen = setup(on, () => 'chat-or-question')
  await step($)
  expect(seen.saves).toBe(0)
})

// 分類の Haiku の usage（差し替えでは入力 100）は、分類の分として保存される。
test('classifier usage is recorded', async ($, on) => {
  const seen = setup(on, () => 'chat-or-question')
  await $.prompt.submit({ text: 'こんにちは' })
  expect(totals(seen).classifier.input).toBe(100)
})

// モデルを明示したターンは Haiku を呼ばないので、分類の分は増えない。
test('explicit model adds no classifier usage', async ($, on) => {
  const seen = setup(on, () => 'chat-or-question', () => [], () => USAGE)
  await $.prompt.submit({ text: 'Fable で、構成案を考えて' })
  await step($)
  expect(totals(seen).classifier.input).toBe(0)
})

// 保存先に形の違う値があっても、空の累計から数え直す。
test('unreadable store starts from zero', async ($, on) => {
  const seen = setup(on, () => 'chat-or-question', () => [], () => USAGE)
  seen.store['savings-totals'] = { actual: 1 }
  await step($)
  expect(totals(seen).requests).toBe(1)
})

/** セッションを始めて /savings を登録し、実行して、返った文章を返す（差し替えは setup にある）。 */
async function runSavings($: any, args: string): Promise<string> {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.command.run({ command: 'savings', args })
  return r.text ?? ''
}

// 引数を省略すると、Opus を基準にした文章が返る。推定の注意も入る。
test('savings command reports against opus by default', async ($, on) => {
  setup(on, () => 'chat-or-question', () => [], () => USAGE)
  await step($)
  const text = await runSavings($, '')
  expect(text).toContain('Opus')
  expect(text).toContain('effort の差は含まない')
})

// 引数で基準のモデルを変えられる。
test('savings command takes a baseline', async ($, on) => {
  setup(on, () => 'chat-or-question', () => [], () => USAGE)
  await step($)
  expect(await runSavings($, 'sonnet')).toContain('基準 Sonnet')
})
