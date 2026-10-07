import { describe, expect, it } from 'vitest'

import { analyzeRequest } from '../src/routing/request-analysis'
import { assistant, assistantCalls, system, toolCall, toolResult, user } from './support/wire'

const TOOLS = [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }]

function analyze(messages: Parameters<typeof analyzeRequest>[0]['messages'], extra: Record<string, unknown> = {}) {
  return analyzeRequest({ model: 'companion-chat', messages, ...extra })
}

describe('analyzeRequest traits', () => {
  it('reads stream, tools, and the end of a tool turn', () => {
    const plain = analyze([system('c'), user('hi')], { stream: true })
    const withTools = analyze([system('c'), user('hi')], { tools: TOOLS })
    const continuation = analyze([user('hi'), assistantCalls([toolCall('a', 'f')]), toolResult('a', 'r')], { tools: TOOLS })

    expect(plain).toMatchObject({ stream: true, hasTools: false, toolContinuation: false })
    expect(withTools).toMatchObject({ stream: false, hasTools: true, toolContinuation: false })
    expect(continuation).toMatchObject({ hasTools: true, toolContinuation: true })
  })

  it('does not count tools that tool_choice none switches off', () => {
    expect(analyze([user('hi')], { tools: TOOLS, tool_choice: 'none' }).hasTools).toBe(false)
  })

  it('marks a forced tool call', () => {
    expect(analyze([user('hi')], { tools: TOOLS, tool_choice: 'required' }).toolsRequired).toBe(true)
    expect(analyze([user('hi')], { tools: TOOLS, tool_choice: { type: 'function', function: { name: 'f' } } }).toolsRequired).toBe(true)
    expect(analyze([user('hi')], { tools: TOOLS, tool_choice: 'auto' }).toolsRequired).toBe(false)
  })

  it('finds an image in a user turn and in a tool result', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }

    expect(analyze([{ role: 'user', content: [{ type: 'text', text: 'see' }, image] }]).hasImages).toBe(true)
    expect(analyze([user('x'), assistantCalls([toolCall('a', 'f')]), { role: 'tool', tool_call_id: 'a', content: [image] }]).hasImages).toBe(true)
    expect(analyze([user('plain')]).hasImages).toBe(false)
  })

  it('finds a structured output request', () => {
    expect(analyze([user('x')], { response_format: { type: 'json_schema', json_schema: {} } }).structuredOutput).toBe(true)
    expect(analyze([user('x')], { response_format: { type: 'json_object' } }).structuredOutput).toBe(true)
    expect(analyze([user('x')], { response_format: { type: 'text' } }).structuredOutput).toBe(false)
  })

  it('counts the tool exchanges of the recent turns, which the prompt policy reads', () => {
    const busy = analyze([
      user('1'),
      assistantCalls([toolCall('a', 'f')]),
      toolResult('a', 'r'),
      assistant('one'),
      user('2'),
      assistantCalls([toolCall('b', 'f'), toolCall('c', 'f')]),
      toolResult('b', 'r'),
      toolResult('c', 'r'),
      assistant('two'),
      user('3'),
    ])

    expect(busy.recentToolExchanges).toBe(2)
  })

  it('reports no recent tool exchanges for a history that is not valid', () => {
    expect(analyze([user('x'), toolResult('orphan', 'r')]).recentToolExchanges).toBe(0)
  })
})

describe('analyzeRequest conversation key', () => {
  it('is stable while a conversation grows, because it comes from the first user message', () => {
    const early = analyze([system('card'), user('Hello Mura, it is me again')])
    const later = analyze([system('card, with a new timestamp'), user('Hello Mura, it is me again'), assistant('hi'), user('more')])

    expect(later.conversationKey).toBe(early.conversationKey)
  })

  it('differs between conversations that start differently', () => {
    expect(analyze([user('a')]).conversationKey).not.toBe(analyze([user('b')]).conversationKey)
  })

  it('uses the user field when the client sends one', () => {
    const one = analyze([user('same')], { user: 'session-1' })
    const two = analyze([user('same')], { user: 'session-2' })

    expect(one.conversationKey).not.toBe(two.conversationKey)
    expect(one.conversationKey).toBe(analyze([user('other first message')], { user: 'session-1' }).conversationKey)
  })

  it('does not put message text into the key', () => {
    expect(analyze([user('my secret diary entry')]).conversationKey).not.toContain('secret')
  })
})
