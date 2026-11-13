import { expect, test } from 'claude-code/testing'

// ベースにあるエンジンの代わりに、分類結果と、turn.step が受け取った model / effort を記録する。
function setup(on: any, classify: () => string | undefined | Error) {
  const seen = { model: '', effort: undefined as unknown, classified: 0, context: [] as readonly string[] }
  on('model.classify', () => {
    seen.classified++
    const r = classify()
    if (r instanceof Error) throw r
    return { value: r }
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

test('a short continuation reuses the previous pick without classifying', async ($, on) => {
  const seen = setup(on, () => 'design-hardest')
  await $.prompt.submit({ text: '複数リージョンの決済システムを設計して' })
  await $.prompt.submit({ text: '続けて' })
  await step($)
  expect(seen.classified).toBe(1)
  expect(seen.model).toBe('fable')
  expect(seen.effort).toBe('xhigh')
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
