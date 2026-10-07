import { describe, expect, it } from 'vitest'

import { parseConversation } from '../src/budget/request-units'
import { assistant, assistantCalls, system, toolCall, toolResult, user } from './support/wire'

function expectParsed(messages: Parameters<typeof parseConversation>[0]) {
  const parsed = parseConversation(messages)
  if (!parsed.ok)
    throw new Error(`expected a valid conversation but got ${parsed.reason}: ${parsed.detail}`)
  return parsed
}

function expectMalformed(messages: Parameters<typeof parseConversation>[0]) {
  const parsed = parseConversation(messages)
  if (parsed.ok)
    throw new Error('expected a malformed conversation')
  return parsed
}

describe('parseConversation', () => {
  it('splits leading instructions from turn groups', () => {
    const parsed = expectParsed([
      system('card'),
      { role: 'developer', content: 'rules' },
      user('hi'),
      assistant('hello'),
      user('how are you'),
    ])

    expect(parsed.system).toEqual({ start: 0, end: 2 })
    expect(parsed.groups).toHaveLength(2)
    expect(parsed.groups[0]).toMatchObject({ start: 2, end: 4, userSide: { start: 2, end: 3 }, assistant: { start: 3, end: 4, exchanges: [], finalTextIndex: 3 } })
    expect(parsed.groups[1]).toMatchObject({ start: 4, end: 5, userSide: { start: 4, end: 5 } })
    expect(parsed.groups[1].assistant).toBeUndefined()
  })

  it('keeps consecutive user messages in one group, because AIRI renders context as user messages', () => {
    const parsed = expectParsed([
      system('card'),
      user('[context] it is 21:00'),
      user('[context] the user opened a video'),
      user('what is this?'),
      assistant('a mecha anime'),
    ])

    expect(parsed.groups).toHaveLength(1)
    expect(parsed.groups[0].userSide).toEqual({ start: 1, end: 4 })
  })

  it('treats a system message after the conversation started as context of the next group', () => {
    const parsed = expectParsed([system('card'), user('a'), assistant('b'), system('late rule'), user('c')])

    expect(parsed.groups).toHaveLength(2)
    expect(parsed.groups[1].userSide).toEqual({ start: 3, end: 5 })
  })

  it('wraps one call and its result in a tool exchange inside the assistant turn', () => {
    const parsed = expectParsed([
      system('card'),
      user('weather in Osaka?'),
      assistantCalls([toolCall('c1', 'get_weather', { location: 'Osaka' })]),
      toolResult('c1', '21C'),
      assistant('It is 21 degrees.'),
    ])

    const turn = parsed.groups[0].assistant!
    expect(turn).toMatchObject({ start: 2, end: 5, finalTextIndex: 4 })
    expect(turn.exchanges).toEqual([{ start: 2, end: 4, callIds: ['c1'] }])
  })

  it('accepts parallel calls whose results arrive in a different order', () => {
    const parsed = expectParsed([
      user('both please'),
      assistantCalls([toolCall('a', 'f'), toolCall('b', 'g'), toolCall('c', 'h')]),
      toolResult('c', 'rc'),
      toolResult('a', 'ra'),
      toolResult('b', 'rb'),
      assistant('done'),
    ])

    expect(parsed.groups[0].assistant!.exchanges).toEqual([{ start: 1, end: 5, callIds: ['a', 'b', 'c'] }])
  })

  it('accepts several sequential exchanges across rounds of one assistant turn', () => {
    const parsed = expectParsed([
      user('go'),
      assistantCalls([toolCall('r1', 'list')], 'Let me look.'),
      toolResult('r1', 'tools: a, b'),
      assistantCalls([toolCall('r2', 'call_a')]),
      toolResult('r2', 'ok'),
      assistant('finished'),
    ])

    const turn = parsed.groups[0].assistant!
    expect(turn.exchanges.map(exchange => exchange.callIds)).toEqual([['r1'], ['r2']])
    expect(turn.finalTextIndex).toBe(5)
  })

  it('accepts a failed tool result like any other result', () => {
    const parsed = expectParsed([user('x'), assistantCalls([toolCall('e', 'f')]), toolResult('e', '{"isError":true}'), assistant('that failed')])

    expect(parsed.groups[0].assistant!.exchanges).toHaveLength(1)
  })

  it('has no final text when the turn ends with tool results, as in an agent continuation', () => {
    const parsed = expectParsed([user('x'), assistantCalls([toolCall('c', 'f')]), toolResult('c', 'r')])

    expect(parsed.groups[0].assistant!.finalTextIndex).toBeUndefined()
    expect(parsed.groups[0].assistant!.end).toBe(3)
  })

  it('reuses call ids across different exchanges without confusion', () => {
    const parsed = expectParsed([
      user('1'),
      assistantCalls([toolCall('call_0', 'f')]),
      toolResult('call_0', 'a'),
      assistant('one'),
      user('2'),
      assistantCalls([toolCall('call_0', 'f')]),
      toolResult('call_0', 'b'),
      assistant('two'),
    ])

    expect(parsed.groups).toHaveLength(2)
  })

  it.each([
    ['an orphan tool result', [user('x'), toolResult('c', 'r')], 'orphan-tool-result'],
    ['a tool result for an unknown call id', [user('x'), assistantCalls([toolCall('a', 'f')]), toolResult('zzz', 'r')], 'orphan-tool-result'],
    ['a duplicated tool result', [user('x'), assistantCalls([toolCall('a', 'f')]), toolResult('a', 'r'), toolResult('a', 'r2')], 'orphan-tool-result'],
    ['a call that never gets a result before the next user message', [user('x'), assistantCalls([toolCall('a', 'f')]), user('y')], 'missing-tool-result'],
    ['a call that never gets a result before the next assistant message', [user('x'), assistantCalls([toolCall('a', 'f')]), assistant('text')], 'missing-tool-result'],
    ['an interrupted generation: a trailing call without results', [user('x'), assistantCalls([toolCall('a', 'f')])], 'unresolved-tool-call'],
    ['one of two parallel results missing at the end', [user('x'), assistantCalls([toolCall('a', 'f'), toolCall('b', 'g')]), toolResult('a', 'r')], 'unresolved-tool-call'],
    ['an assistant message before any user message', [system('card'), assistant('hi')], 'assistant-before-user'],
    ['a system message between a call and its result', [user('x'), assistantCalls([toolCall('a', 'f')]), system('late'), toolResult('a', 'r')], 'missing-tool-result'],
    ['a tool call without an id', [user('x'), assistantCalls([{ id: '', function: { name: 'f' } }]), toolResult('', 'r')], 'invalid-tool-call'],
    ['two calls with the same id in one message', [user('x'), assistantCalls([toolCall('a', 'f'), toolCall('a', 'g')]), toolResult('a', 'r')], 'invalid-tool-call'],
    ['an unknown role', [user('x'), { role: 'function', content: 'legacy' }], 'unknown-role'],
    ['no user message at all', [system('card')], 'no-user-message'],
    ['an empty message list', [], 'no-user-message'],
  ] as const)('reports %s as malformed', (_name, messages, reason) => {
    expect(expectMalformed([...messages]).reason).toBe(reason)
  })
})
