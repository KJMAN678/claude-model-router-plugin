// 削減額の計算。実際の利用と、基準のモデルだけで動かした場合を比べる。副作用はなく、記録と保存は register.ts が行う。
// 設計: docs/superpowers/specs/2026-11-16-savings-design.md

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Totals = {
  actual: Record<string, Tokens> // モデルの種類（opus など）ごとの、実際のトークン数
  baseline: Tokens // 基準のモデルだけで動かしたとみなしたトークン数（キャッシュを補正したもの）
  classifier: Tokens // 分類の Haiku の分。実際の側にだけ足す
  requests: number
  unpriced: number // 単価表にないモデルのリクエスト数（計算から外した）
  prevModel?: string
  prevPrompt?: number
}
type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// ドル / 100 万トークン。2026-11-03 時点の Anthropic 公式 API の価格。
// キャッシュ書き込みは 1 時間の単価（Claude Code はほとんど 1 時間で書き、usage に 5 分との内訳がないため）。
// Haiku のキャッシュ読み込みは資料に明記がなく、入力の 0.1 倍とした。
const PRICES: Record<string, Tokens> = {
  opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 },
  sonnet: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 4 },
  fable: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 16 },
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.2 },
}
const NAMES: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', fable: 'Fable', haiku: 'Haiku' }
// 単価表の対象のモデル ID。旧版（claude-opus-5、claude-haiku-4-5 など）は単価が違うので、前方一致で現行の版だけを拾う。
const MODEL_IDS: Record<string, string> = {
  'claude-opus-5-5': 'opus',
  'claude-sonnet-5-5': 'sonnet',
  'claude-fable-5-2': 'fable',
  'claude-haiku-5-5': 'haiku',
}

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const add = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})
const fromUsage = (u: Usage): Tokens => ({
  input: u.input_tokens,
  output: u.output_tokens,
  cacheRead: u.cache_read_input_tokens,
  cacheWrite: u.cache_creation_input_tokens,
})
const prompt = (t: Tokens) => t.input + t.cacheRead + t.cacheWrite

export function emptyTotals(): Totals {
  return { actual: {}, baseline: zero(), classifier: zero(), requests: 0, unpriced: 0 }
}

/** 応答したモデルの ID（`claude-opus-5-5` など）から、単価表のモデルの種類を返す。表にない版は undefined。 */
export function family(modelId: string): string | undefined {
  const id = modelId.toLowerCase()
  return Object.entries(MODEL_IDS).find(([prefix]) => id.startsWith(prefix))?.[1]
}

/** `/savings` の引数（`opus` など、短い名前）を、単価表のモデルの種類にする。知らない名前は undefined。 */
export function baselineFamily(name: string): string | undefined {
  const n = name.trim().toLowerCase()
  return n in PRICES ? n : undefined
}

/** セッションごとの記録を足し合わせて、累計にする。 */
export function sumTotals(list: readonly Totals[]): Totals {
  return list.reduce((sum, t) => {
    const actual = { ...sum.actual }
    for (const [f, tok] of Object.entries(t.actual)) actual[f] = add(actual[f] ?? zero(), tok)
    return {
      actual,
      baseline: add(sum.baseline, t.baseline),
      classifier: add(sum.classifier, t.classifier),
      requests: sum.requests + t.requests,
      unpriced: sum.unpriced + t.unpriced,
    }
  }, emptyTotals())
}

/**
 * メインのリクエスト 1 回分を足し込む。元の t は変えず、新しい値を返す。
 * 直前のリクエストとモデルが変わっていたら、キャッシュ書き込みのうち直前のプロンプトまでの分は、
 * 「基準のモデルなら読み込みで済んだ」として、基準の側で読み込みに移す。
 */
export function recordStep(t: Totals, modelId: string, u: Usage): Totals {
  const tokens = fromUsage(u)
  const next: Totals = { ...t, prevModel: modelId, prevPrompt: prompt(tokens) }
  const fam = family(modelId)
  if (!fam) return { ...next, unpriced: t.unpriced + 1 }

  const switched = t.prevModel !== undefined && t.prevModel !== modelId
  const moved = switched ? Math.min(tokens.cacheWrite, Math.max(0, (t.prevPrompt ?? 0) - tokens.cacheRead)) : 0
  const base = { ...tokens, cacheRead: tokens.cacheRead + moved, cacheWrite: tokens.cacheWrite - moved }
  return {
    ...next,
    actual: { ...t.actual, [fam]: add(t.actual[fam] ?? zero(), tokens) },
    baseline: add(t.baseline, base),
    requests: t.requests + 1,
  }
}

/** 分類の Haiku 1 回分を、実際の側にだけ足す。 */
export function recordClassifier(t: Totals, u: Usage): Totals {
  return { ...t, classifier: add(t.classifier, fromUsage(u)) }
}

/** トークン数を、そのモデルの種類の単価でドルにする。 */
export function cost(tokens: Tokens, fam: string): number {
  const p = PRICES[fam]
  if (!p) return 0
  return (tokens.input * p.input + tokens.output * p.output + tokens.cacheRead * p.cacheRead + tokens.cacheWrite * p.cacheWrite) / 1e6
}

const usd = (n: number) => `$${n.toFixed(2)}`
const count = (t: Tokens) => (t.input + t.output + t.cacheRead + t.cacheWrite).toLocaleString('en-US')

function section(title: string, t: Totals, baselineFamily: string): string {
  const actualModels = Object.entries(t.actual).reduce((s, [f, tok]) => s + cost(tok, f), 0)
  const actual = actualModels + cost(t.classifier, 'haiku')
  const baseline = cost(t.baseline, baselineFamily)
  const saved = baseline - actual
  const pct = baseline > 0 ? ` (${((saved / baseline) * 100).toFixed(1)}%)` : ''
  const models = Object.entries(t.actual).map(([f, tok]) => `${NAMES[f] ?? f} ${count(tok)} tok / ${usd(cost(tok, f))}`)
  return [
    `${title}（メインのリクエスト ${t.requests} 回）`,
    `- 実際: ${usd(actual)}（${models.join('、') || 'なし'}、分類 ${usd(cost(t.classifier, 'haiku'))}）`,
    `- 基準 ${NAMES[baselineFamily]}: ${usd(baseline)}`,
    `- 差: ${usd(saved)}${pct}${saved >= 0 ? ' 削減' : ' 増加'}`,
    ...(t.unpriced > 0 ? [`- 単価表にないモデルのリクエスト ${t.unpriced} 回は計算から外した`] : []),
  ].join('\n')
}

/** `/savings` に出す文章。このセッションと累計の 2 段に、推定の注意を添える。 */
export function report(session: Totals, total: Totals, baselineFamily: string): string {
  return [
    section('このセッション', session, baselineFamily),
    section('累計', total, baselineFamily),
    `注: 基準は同じトークン数を ${NAMES[baselineFamily]} の単価で計算し直した推定。effort の差は含まない。キャッシュは補正した推定（切り替えで書き直した分は、基準では読み込みとみなす）。`,
  ].join('\n\n')
}

const isTokens = (v: unknown): v is Tokens =>
  typeof v === 'object' && v !== null &&
  ['input', 'output', 'cacheRead', 'cacheWrite'].every(k => typeof (v as Record<string, unknown>)[k] === 'number')

/** `$.store` から読んだ値を Totals にする。形が合わなければ空の累計。 */
export function parseTotals(value: unknown): Totals {
  if (typeof value !== 'object' || value === null) return emptyTotals()
  const v = value as Record<string, unknown>
  const actual = v.actual
  if (typeof actual !== 'object' || actual === null || !Object.values(actual).every(isTokens)) return emptyTotals()
  if (!isTokens(v.baseline) || !isTokens(v.classifier)) return emptyTotals()
  if (typeof v.requests !== 'number' || typeof v.unpriced !== 'number') return emptyTotals()
  return {
    actual: actual as Record<string, Tokens>,
    baseline: v.baseline,
    classifier: v.classifier,
    requests: v.requests,
    unpriced: v.unpriced,
    ...(typeof v.prevModel === 'string' ? { prevModel: v.prevModel } : {}),
    ...(typeof v.prevPrompt === 'number' ? { prevPrompt: v.prevPrompt } : {}),
  }
}
