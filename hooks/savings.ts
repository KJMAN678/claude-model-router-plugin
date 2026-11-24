// 削減額の計算（docs/superpowers/specs/2026-11-16-savings-design.md）。
// 実際に使ったトークンを記録し、基準のモデル（既定は Opus）だけで動かした場合の料金と比べる。
// 純粋な関数だけを置く。記録するタイミングと保存は register.ts が受け持つ。

// トークン数。i 入力、o 出力、r キャッシュ読み込み、w5 / w1 は 5 分 / 1 時間のキャッシュ書き込み。
export type Tokens = { i: number; o: number; r: number; w5: number; w1: number }
// 記録の帳簿。actual は実際のモデルごと、base は「基準のモデルだけなら」の補正済みトークン（モデルを問わず合算）。
// classify は分類（Haiku）の分で、実際の側にだけ入る。skipped は単価表にないモデルの件数（計算から外した）。
export type Ledger = { actual: Record<string, Tokens>; base: Tokens; classify: Tokens; skipped: Record<string, number> }
// turn.step の結果の usage のうち、使うもの。
export type Usage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  ephemeral_5m_input_tokens?: number
}

// 単価表（ドル / 100 万トークン、2026-11-03 時点の Anthropic 公式 API）。w1 は 1 時間のキャッシュ書き込み。
// 5 分の書き込みは入力の 1.25 倍。単価表にないモデルは計算から外す（版が上がったら、ここに足す）。
type Price = { name: string; id: string; i: number; o: number; r: number; w1: number }
const PRICES: Record<string, Price> = {
  opus: { name: 'Opus 5.5', id: 'claude-opus-5-5', i: 4, o: 20, r: 0.2, w1: 8 },
  sonnet: { name: 'Sonnet 5.5', id: 'claude-sonnet-5-5', i: 2, o: 10, r: 0.1, w1: 4 },
  fable: { name: 'Fable 5.2', id: 'claude-fable-5-2', i: 8, o: 40, r: 0.2, w1: 16 },
  // Haiku のキャッシュ読み込みは資料に明記がなく、入力の 0.1 倍とした。
  haiku: { name: 'Haiku 5.5', id: 'claude-haiku-5-5', i: 0.1, o: 0.5, r: 0.01, w1: 0.2 },
}

const zero = (): Tokens => ({ i: 0, o: 0, r: 0, w5: 0, w1: 0 })
export const emptyLedger = (): Ledger => ({ actual: {}, base: zero(), classify: zero(), skipped: {} })

function add(a: Tokens, b: Tokens): void {
  a.i += b.i; a.o += b.o; a.r += b.r; a.w5 += b.w5; a.w1 += b.w1
}

// API が返すモデル ID（claude-opus-5-5-20261101 のような形もある）から、単価表のキーを引く。
const familyOf = (id: string) => Object.keys(PRICES).find(k => id.startsWith(PRICES[k]!.id))

/**
 * メインのリクエスト 1 回分を、帳簿に足す。
 * 入力と出力は、基準でも同じ数とする。キャッシュだけ補正する: モデルが前のリクエストから変わると、
 * 実際は、前までの会話をキャッシュに書き直す（書き込み）が、基準のモデルのままなら読み込みで済んだ。
 * その分（前のプロンプト全体 - 今回の読み込み。書き込みを上限）を、基準の側では書き込みから読み込みに移す。
 *
 * @param l 足す先の帳簿。
 * @param u そのリクエストの usage。
 * @param prev 前のメインのリクエストのモデルとプロンプト全体（入力 + 読み込み + 書き込み）。最初のリクエストは undefined。
 * @returns なし。
 */
export function record(l: Ledger, u: Usage, prev?: { model: string; total: number }): void {
  const fam = familyOf(u.model)
  if (!fam) {
    l.skipped[u.model] = (l.skipped[u.model] ?? 0) + 1
    return
  }
  const w5 = u.ephemeral_5m_input_tokens ?? 0 // 内訳がなければ、全部 1 時間として数える。
  const t: Tokens = { i: u.input_tokens, o: u.output_tokens, r: u.cache_read_input_tokens, w5, w1: u.cache_creation_input_tokens - w5 }
  add((l.actual[fam] ??= zero()), t)
  const moved = prev && prev.model !== u.model ? Math.min(t.w5 + t.w1, Math.max(0, prev.total - t.r)) : 0
  // 高い 1 時間の書き込みから先に移す（基準を安く見積もる = 削減額を控えめに出す）。
  const m1 = Math.min(moved, t.w1)
  add(l.base, { ...t, r: t.r + moved, w5: t.w5 - (moved - m1), w1: t.w1 - m1 })
}

/**
 * 分類（Haiku）の費用を、帳簿に足す。実際の側にだけ入る（基準のモデルだけなら分類はいらない）。
 *
 * @param l 足す先の帳簿。
 * @param u `$.model.complete` の結果の usage。
 * @returns なし。
 */
export function recordClassify(l: Ledger, u: Omit<Usage, 'model'>): void {
  add(l.classify, { i: u.input_tokens, o: u.output_tokens, r: u.cache_read_input_tokens, w5: 0, w1: u.cache_creation_input_tokens })
}

const cost = (t: Tokens, p: Price) => (t.i * p.i + t.o * p.o + t.r * p.r + t.w5 * p.i * 1.25 + t.w1 * p.w1) / 1e6
const usd = (x: number) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`
const n = (x: number) => Math.round(x).toLocaleString('en-US')

/**
 * 帳簿 1 つ分の表示を作る。
 *
 * @param title 見出し（「このセッション」など）。
 * @param l 帳簿。
 * @param baseFamily 基準のモデル（PRICES のキー）。
 * @returns 複数行の文章。
 */
function section(title: string, l: Ledger, baseFamily: string): string {
  const base = PRICES[baseFamily]!
  const replies = Object.entries(l.actual).reduce((s, [f, t]) => s + cost(t, PRICES[f]!), 0)
  const classify = cost(l.classify, PRICES.haiku!)
  const actual = replies + classify
  const baseline = cost(l.base, base)
  const diff = baseline - actual
  const lines = [
    `■ ${title}`,
    `  実際: ${usd(actual)}（応答 ${usd(replies)} + 分類 ${usd(classify)}）`,
    `  ${base.name} だけなら: ${usd(baseline)}`,
    `  削減額: ${usd(diff)}${baseline > 0 ? `（${((diff / baseline) * 100).toFixed(1)}%）` : ''}`,
  ]
  for (const [f, t] of Object.entries(l.actual)) {
    lines.push(`  ${PRICES[f]!.name}: 入力 ${n(t.i)} / 出力 ${n(t.o)} / キャッシュ読み込み ${n(t.r)} / キャッシュ書き込み ${n(t.w5 + t.w1)}`)
  }
  const skipped = Object.entries(l.skipped)
  if (skipped.length) lines.push(`  単価表にないモデルは計算から外した: ${skipped.map(([m, c]) => `${m} ${c} 回`).join('、')}`)
  return lines.join('\n')
}

/**
 * `/model-router-savings [基準のモデル]` の出力を作る。
 *
 * @param args コマンドの引数。基準のモデルの短い名前（opus / sonnet / fable / haiku）。空なら opus。
 * @param session このセッションの帳簿。
 * @param total セッションをまたいだ累計の帳簿。
 * @returns 表示する文章。基準のモデルが分からなければ、選べる名前を知らせる文章。
 */
export function report(args: string, session: Ledger, total: Ledger): string {
  const base = args.trim().toLowerCase() || 'opus'
  if (!PRICES[base]) return `基準のモデルは ${Object.keys(PRICES).join(' / ')} から選ぶ（既定は opus）。`
  return [
    section('このセッション', session, base),
    section('累計', total, base),
    '※ effort の差は含まない。キャッシュは、モデルを切り替えたときに基準側で読み込みに移した推定。分類（Haiku）の費用は実際の側にだけ入る。',
  ].join('\n\n')
}
