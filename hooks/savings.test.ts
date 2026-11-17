// hooks/savings.ts（削減額の計算）のテスト。$ と on は使わず、関数だけを確かめる。
import { expect, test } from 'claude-code/testing'
import { baselineFamily, cost, emptyTotals, parseTotals, recordClassifier, recordStep, report, sumTotals } from './savings'

const U = (i: number, o: number, r: number, w: number) =>
  ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: w })
const cents = (n: number) => Math.round(n * 100) / 100

test('cost uses the 1h write price', () => {
  expect(cents(cost({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }, 'opus'))).toBe(32.2)
})

test('first request is not a switch', () => {
  const t = recordStep(emptyTotals(), 'claude-opus-5-5', U(10, 5, 0, 1000))
  expect(t.baseline).toEqual({ input: 10, output: 5, cacheRead: 0, cacheWrite: 1000 })
})

test('same model keeps cache as is', () => {
  let t = recordStep(emptyTotals(), 'claude-opus-5-5', U(10, 5, 0, 1000))
  t = recordStep(t, 'claude-opus-5-5', U(10, 5, 1000, 200))
  expect(t.baseline.cacheRead).toBe(1000)
  expect(t.baseline.cacheWrite).toBe(1200)
})

test('a switch moves prior prefix from write to read', () => {
  let t = recordStep(emptyTotals(), 'claude-opus-5-5', U(10, 5, 0, 1000)) // 直前のプロンプト全体は 1010
  t = recordStep(t, 'claude-sonnet-5-5', U(10, 5, 0, 1300)) // そのうち 1010 は、基準なら読み込みで済んだ
  expect(t.baseline.cacheRead).toBe(1010)
  expect(t.baseline.cacheWrite).toBe(1000 + 290)
  expect(t.actual.sonnet).toEqual({ input: 10, output: 5, cacheRead: 0, cacheWrite: 1300 })
})

test('adjustment is capped by previous prompt', () => {
  let t = recordStep(emptyTotals(), 'claude-opus-5-5', U(0, 0, 0, 100))
  t = recordStep(t, 'claude-fable-5-2', U(0, 0, 0, 5000))
  expect(t.baseline.cacheRead).toBe(100)
  expect(t.baseline.cacheWrite).toBe(100 + 4900)
})

test('unknown model is counted as unpriced', () => {
  const t = recordStep(emptyTotals(), 'claude-x-1', U(10, 5, 0, 0))
  expect(t.unpriced).toBe(1)
  expect(t.actual).toEqual({})
})

test('classifier usage is actual only', () => {
  const t = recordClassifier(emptyTotals(), U(100, 2, 0, 0))
  expect(t.classifier.input).toBe(100)
  expect(t.baseline.input).toBe(0)
})

test('report names baseline, saving and caveats', () => {
  const t = recordStep(emptyTotals(), 'claude-sonnet-5-5', U(1e6, 0, 0, 0))
  const s = report(t, t, 'opus')
  expect(s).toContain('Opus')
  expect(s).toContain('2.00') // 基準 4.00 − 実際 2.00
  expect(s).toContain('effort の差は含まない')
  expect(s).toContain('キャッシュは補正した推定')
})

test('parseTotals rejects a wrong shape', () => {
  expect(parseTotals({ actual: 1 })).toEqual(emptyTotals())
  expect(parseTotals(undefined)).toEqual(emptyTotals())
})

// 旧版のモデル（Opus 5、Haiku 4.5 など）は単価が違うので、計算から外す。現行の単価で数えると、削減額が過大になる。
test('an older model of the same family is unpriced', () => {
  let t = recordStep(emptyTotals(), 'claude-opus-5', U(10, 5, 0, 0))
  t = recordStep(t, 'claude-haiku-4-5', U(10, 5, 0, 0))
  expect(t.unpriced).toBe(2)
  expect(t.actual).toEqual({})
})

// /savings の引数（基準）は、短い名前だけを受け付ける。
test('baselineFamily accepts short names only', () => {
  expect(baselineFamily('Sonnet')).toBe('sonnet')
  expect(baselineFamily('gpt')).toBeUndefined()
})

// セッションごとの記録を足し合わせて、累計にする。
test('sumTotals adds sessions', () => {
  const a = recordStep(emptyTotals(), 'claude-opus-5-5', U(10, 5, 0, 0))
  const b = recordClassifier(recordStep(emptyTotals(), 'claude-opus-5-5', U(1, 1, 0, 0)), U(3, 0, 0, 0))
  const t = sumTotals([a, b])
  expect(t.requests).toBe(2)
  expect(t.actual.opus.input).toBe(11)
  expect(t.classifier.input).toBe(3)
  expect(t.baseline.input).toBe(11)
})
