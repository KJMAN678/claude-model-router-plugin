import { expect, test } from 'claude-code/testing'

type Msg = { role: 'user' | 'assistant'; text: string }
type Reply = string | Error | { isAnswered: false }

const LABELS = [
  'design-simple', 'design-moderate', 'design-complex', 'design-hardest',
  'implement-simple', 'implement-moderate', 'implement-complex',
  'review-standard', 'review-deep', 'chat-or-question',
]

// ベースにあるエンジンの代わりに、Haiku の返事と会話を差し替え、turn.step が受け取った model / effort を記録する。
function setup(on: any, reply: () => Reply, messages: () => Msg[] | Error = () => []) {
  const seen = { model: '', effort: undefined as unknown, classified: 0, context: [] as readonly string[], request: undefined as any }
  on('model.complete', (_: unknown, e: any) => {
    seen.classified++
    seen.request = e
    const r = reply()
    if (r instanceof Error) throw r
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    if (typeof r !== 'string') return { value: { isAnswered: false, reason: 'api-error', status: 500, error: 'api_error', usage } }
    return { value: { isAnswered: true, text: r, usage } }
  })
  on('session.messages', () => {
    const m = messages()
    if (m instanceof Error) throw m
    return { value: m.map(x => ({ ...x, toolUses: [] })) }
  })
  on('prompt.submit', (_: unknown, e: { text: string; context?: readonly string[] }) => {
    seen.context = e.context ?? []
    return { text: e.text }
  })
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number; model: string; effort?: unknown }) {
    seen.model = e.model
    seen.effort = e.effort
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return seen
}

async function step($: any, agentId?: string) {
  const s = $.turn.step({ turnId: 't', index: 0, model: 'sonnet', effort: 'high', messageCount: 1, agentId })
  for await (const _ of s) { /* 流れてくる chunk は使わない */ }
}

test('a review prompt switches the main model to fable xhigh', async ($, on) => {
  const seen = setup(on, () => 'review-deep')
  await $.prompt.submit({ text: 'この変更をレビューして' })
  await step($)
  expect(seen.model).toBe('fable')
  expect(seen.effort).toBe('xhigh')
})

test('a chat prompt keeps the session model', async ($, on) => {
  const seen = setup(on, () => 'chat-or-question')
  await $.prompt.submit({ text: 'こんにちは' })
  await step($)
  expect(seen.model).toBe('sonnet')
  expect(seen.effort).toBe('high')
})

test('an explicit model wins over the classifier', async ($, on) => {
  const seen = setup(on, () => 'implement-simple')
  await $.prompt.submit({ text: 'Fable で、構成案を考えて' })
  await step($)
  expect(seen.classified).toBe(0)
  expect(seen.model).toBe('fable')
  expect(seen.effort).toBe('high')
})

test('a subagent step is left alone', async ($, on) => {
  const seen = setup(on, () => 'review-deep')
  await $.prompt.submit({ text: 'レビューして' })
  await step($, 'agent-1')
  expect(seen.model).toBe('sonnet')
})

test('a failed classification falls back to the session model', async ($, on) => {
  const seen = setup(on, () => new Error('api down'))
  await $.prompt.submit({ text: '何か実装して' })
  await step($)
  expect(seen.model).toBe('sonnet')
})

test('a switched turn tells the model which model answers', async ($, on) => {
  const seen = setup(on, () => 'review-deep')
  await $.prompt.submit({ text: 'レビューして' })
  expect(seen.context.length).toBe(1)
  expect(seen.context[0]).toContain('Fable')
})

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

test('the classifier is called with haiku, low effort and the criteria', async ($, on) => {
  const seen = setup(on, () => 'chat-or-question')
  await $.prompt.submit({ text: 'こんにちは' })
  expect(seen.request.model).toBe('haiku')
  expect(seen.request.effort).toBe('low')
  expect(seen.request.maxTokens).toBe(20)
  expect(seen.request.timeoutMs).toBe(10000)
  for (const label of LABELS) expect(seen.request.system).toContain(label)
})

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
  expect(seen.model).toBe('fable')
  expect(seen.effort).toBe('xhigh')
})

test('only the last four non-empty messages are sent, each cut to 500 chars', async ($, on) => {
  const seen = setup(on, () => 'chat-or-question', () => [
    { role: 'user', text: 'first' },
    { role: 'assistant', text: '' },
    { role: 'user', text: 'second' },
    { role: 'assistant', text: 'a'.repeat(600) },
    { role: 'user', text: 'third' },
    { role: 'assistant', text: 'fourth' },
  ])
  await $.prompt.submit({ text: 'こんにちは' })
  expect(seen.request.prompt).not.toContain('first')
  expect(seen.request.prompt).toContain('second')
  expect(seen.request.prompt).toContain('third')
  expect(seen.request.prompt).toContain('fourth')
  expect(seen.request.prompt).toContain('a'.repeat(500))
  expect(seen.request.prompt).not.toContain('a'.repeat(501))
})

test("the router's own note is not sent to the classifier", async ($, on) => {
  const seen = setup(on, () => 'review-deep', () => [
    { role: 'user', text: 'model-router: このターンは Opus（effort high）が応答している。\nレビューして' },
  ])
  await $.prompt.submit({ text: 'お願いします' })
  expect(seen.request.prompt).not.toContain('model-router:')
  expect(seen.request.prompt).toContain('レビューして')
})

test('the current prompt is not repeated in the conversation', async ($, on) => {
  const seen = setup(on, () => 'review-deep', () => [
    { role: 'assistant', text: '直しました' },
    { role: 'user', text: 'この変更をレビューして' },
  ])
  await $.prompt.submit({ text: 'この変更をレビューして' })
  expect(seen.request.prompt.split('この変更をレビューして').length - 1).toBe(1)
})

test('a reply with extra characters still matches', async ($, on) => {
  const seen = setup(on, () => ' `implement-complex`。\n')
  await $.prompt.submit({ text: '決済 API に冪等キーを実装して' })
  await step($)
  expect(seen.model).toBe('opus')
  expect(seen.effort).toBe('xhigh')
})

test('an unknown reply keeps the session model', async ($, on) => {
  const seen = setup(on, () => 'banana')
  await $.prompt.submit({ text: '何か実装して' })
  await step($)
  expect(seen.model).toBe('sonnet')
})

test('an unanswered request keeps the session model', async ($, on) => {
  const seen = setup(on, () => ({ isAnswered: false }))
  await $.prompt.submit({ text: '何か実装して' })
  await step($)
  expect(seen.model).toBe('sonnet')
})

test('a failed messages read still classifies the request', async ($, on) => {
  const seen = setup(on, () => 'review-deep', () => new Error('no transcript'))
  await $.prompt.submit({ text: 'この変更をレビューして' })
  await step($)
  expect(seen.classified).toBe(1)
  expect(seen.model).toBe('fable')
})
