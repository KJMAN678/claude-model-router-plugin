// 削減額の記録と表示（hooks/savings.ts、register.ts の記録の部分）の単体テスト（`claude plugin test .` で動く）。
// エンジンの代わりに、次の 3 つを差し替える。
//   ・モデルへのリクエスト（turn.step）: 渡された順に、用意した usage を返す
//   ・分類（model.complete）: 毎回 chat-or-question（sonnet）と答え、決まった usage を返す
//   ・$.store: メモリ上の Map（セッションをまたぐ累計を確かめるため）
import { expect, test } from 'claude-code/testing'

type U = { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; ephemeral_5m_input_tokens?: number }
const use = (model: string, i: number, o: number, r: number, w: number): U =>
  ({ model, input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: w })

function setup(on: any, usages: U[]) {
  const store = new Map<string, unknown>()
  on('store.get', (_: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => { store.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined } })
  on('command.register', () => ({ value: { command: 'model-router-savings' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => ({ value: { isAnswered: true, text: 'chat-or-question', usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usages.shift() ?? null }
  })
  return store
}

async function step($: any, agentId?: string) {
  const s = $.turn.step({ turnId: 't', index: 0, model: 'sonnet', effort: 'high', messageCount: 1, agentId })
  for await (const _ of s) { /* chunk は使わない */ }
}

const savings = ($: any, args = '') => $.command.run({ command: 'model-router-savings', args })

// 切り替えのないリクエストは、基準でも同じ数（補正なし）。Opus で 100 万入力 + 100 万出力 = $4 + $20 = $24 を、Opus 基準と比べて差額 $0。
test('a request without a switch is not corrected', async ($, on) => {
  setup(on, [use('claude-opus-5-5', 1_000_000, 1_000_000, 0, 0)])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await step($)
  const { text } = await savings($)
  expect(text).toContain('実際: $24.00')
  expect(text).toContain('Opus 5.5 だけなら: $24.00')
  expect(text).toContain('削減額: $0.00')
})

// モデルが変わったリクエストは、書き込みのうち前のプロンプトまでにあった分を、基準では読み込みに移す。
// 1 回目 Opus: プロンプト全体 100 万。2 回目 Sonnet: 読み込み 0、書き込み 100 万（1 時間）。
//   実際: Opus $4（入力 100 万）+ Sonnet $4（書き込み 100 万 × $4）= $8
//   基準: Opus $4 + 書き込みを読み込みに移して 100 万 × $0.20 = $4.20
test('a switched request moves the cache write to a read on the baseline side', async ($, on) => {
  setup(on, [use('claude-opus-5-5', 1_000_000, 0, 0, 0), use('claude-sonnet-5-5', 0, 0, 0, 1_000_000)])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await step($)
  await step($)
  const { text } = await savings($)
  expect(text).toContain('実際: $8.00')
  expect(text).toContain('Opus 5.5 だけなら: $4.20')
})

// 5 分の内訳があれば、その分は 5 分の単価（入力の 1.25 倍）で数える。Opus の 5 分書き込み 100 万 = $5。
test('five-minute cache writes are priced at 1.25x input', async ($, on) => {
  setup(on, [{ ...use('claude-opus-5-5', 0, 0, 0, 1_000_000), ephemeral_5m_input_tokens: 1_000_000 }])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await step($)
  expect((await savings($)).text).toContain('実際: $5.00')
})

// subagent のリクエストは数えない。
test('a subagent step is not counted', async ($, on) => {
  setup(on, [use('claude-opus-5-5', 1_000_000, 0, 0, 0)])
  await step($, 'agent-1')
  expect((await savings($)).text).toContain('実際: $0.00')
})

// 分類の費用は、実際の側にだけ入る。Haiku 入力 100 万 = $0.10。基準は $0（メインのリクエストがない）なので、削減額は -$0.10。
test('the classification cost goes to the actual side only', async ($, on) => {
  setup(on, [])
  await $.prompt.submit({ text: 'こんにちは' })
  const { text } = await savings($)
  expect(text).toContain('分類 $0.10')
  expect(text).toContain('削減額: -$0.10')
})

// 累計は $.store に保存される。
test('the total is kept in the store', async ($, on) => {
  const store = setup(on, [use('claude-opus-5-5', 1_000_000, 0, 0, 0)])
  await step($)
  expect(JSON.stringify(store.get('savings'))).toContain('"i":1000000')
})

// 単価表にないモデルは、計算から外し、その旨を表示する。
test('an unpriced model is left out and reported', async ($, on) => {
  setup(on, [use('claude-mystery-9', 1_000_000, 0, 0, 0)])
  await step($)
  const { text } = await savings($)
  expect(text).toContain('実際: $0.00')
  expect(text).toContain('claude-mystery-9 1 回')
})

// 基準のモデルを引数で変えられる。分からない名前なら、選べる名前を知らせる。
test('the baseline can be chosen by argument', async ($, on) => {
  setup(on, [use('claude-opus-5-5', 1_000_000, 0, 0, 0)])
  await step($)
  expect((await savings($, 'sonnet')).text).toContain('Sonnet 5.5 だけなら: $2.00')
  expect((await savings($, 'gpt')).text).toContain('opus / sonnet')
})

// 補正は、前のプロンプト全体までで止まる。1 回目 Opus: プロンプト全体 40 万。2 回目 Sonnet: 書き込み 100 万のうち、移すのは 40 万だけ。
//   基準: Opus 入力 40 万（$1.60）+ 読み込みに移した 40 万（$0.08）+ 残りの書き込み 60 万（1 時間 $4.80）= $6.48
test('the correction stops at the previous prompt size', async ($, on) => {
  setup(on, [use('claude-opus-5-5', 400_000, 0, 0, 0), use('claude-sonnet-5-5', 0, 0, 0, 1_000_000)])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await step($)
  await step($)
  expect((await savings($)).text).toContain('Opus 5.5 だけなら: $6.48')
})
