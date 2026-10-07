import type { WireMessage } from '../src/budget/wire'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { prepareGeminiRequest } from '../src/providers/gemini-compat'
import { authHeaders, sse, startFakeProvider, startRoutedGateway, writeEvents } from './support/harness'
import { assistant, assistantCalls, system, toolCall, toolResult, user } from './support/wire'

const DUMMY = 'skip_thought_signature_validator'
const REAL = { google: { thought_signature: 'EmAKXgFpFH0T-real' } }

function signatureOf(message: WireMessage, index = 0): string | undefined {
  const extra = message.tool_calls?.[index]?.extra_content as { google?: { thought_signature?: string } } | undefined
  return extra?.google?.thought_signature
}

describe('prepareGeminiRequest', () => {
  it('adds the placeholder signature to a tool call that another model wrote', () => {
    const body = { model: 'm', messages: [user('weather?'), assistantCalls([toolCall('a', 'get_weather')]), toolResult('a', '21C')] }

    const prepared = prepareGeminiRequest(body)

    expect(signatureOf(prepared.messages![1])).toBe(DUMMY)
  })

  it('keeps the real signature that Gemini wrote', () => {
    const call = { ...toolCall('a', 'get_weather'), extra_content: REAL }
    const body = { model: 'm', messages: [user('x'), assistantCalls([call]), toolResult('a', 'r')] }

    expect(signatureOf(prepareGeminiRequest(body).messages![1])).toBe('EmAKXgFpFH0T-real')
  })

  it('fills only the calls that lack a signature when parallel calls are mixed', () => {
    const body = { model: 'm', messages: [user('x'), assistantCalls([{ ...toolCall('a', 'f'), extra_content: REAL }, toolCall('b', 'g')]), toolResult('a', 'r'), toolResult('b', 'r')] }

    const prepared = prepareGeminiRequest(body).messages![1]

    expect(signatureOf(prepared, 0)).toBe('EmAKXgFpFH0T-real')
    expect(signatureOf(prepared, 1)).toBe(DUMMY)
  })

  it('keeps other extra_content fields of the call', () => {
    const call = { ...toolCall('a', 'f'), extra_content: { vendor: { note: 'kept' } } }
    const body = { model: 'm', messages: [user('x'), assistantCalls([call]), toolResult('a', 'r')] }

    expect(prepareGeminiRequest(body).messages![1].tool_calls![0].extra_content).toEqual({ vendor: { note: 'kept' }, google: { thought_signature: DUMMY } })
  })

  it('never changes the request that it receives, because the router shares it with other candidates', () => {
    const messages = [user('x'), assistantCalls([toolCall('a', 'f')]), toolResult('a', 'r')]
    const before = JSON.stringify(messages)

    prepareGeminiRequest({ model: 'm', messages })

    expect(JSON.stringify(messages)).toBe(before)
  })

  it('returns the same request when no tool call needs a signature', () => {
    const plain = { model: 'm', messages: [system('c'), user('hi'), assistant('hello')] }
    const signed = { model: 'm', messages: [user('x'), assistantCalls([{ ...toolCall('a', 'f'), extra_content: REAL }]), toolResult('a', 'r')] }

    expect(prepareGeminiRequest(plain)).toBe(plain)
    expect(prepareGeminiRequest(signed)).toBe(signed)
  })

  it('keeps every other field of the request and of the message', () => {
    const call = toolCall('a', 'f')
    const message = { ...assistantCalls([call], 'checking'), name: 'mura' }
    const body = { model: 'm', temperature: 0.4, messages: [user('x'), message, toolResult('a', 'r')], tools: [{ type: 'function' }] }

    const prepared = prepareGeminiRequest(body)

    expect(Object.keys(prepared)).toEqual(Object.keys(body))
    expect(prepared.messages![1]).toMatchObject({ role: 'assistant', content: 'checking', name: 'mura' })
    expect(prepared.messages![2]).toBe(body.messages[2])
  })
})

describe('gateway request to a Gemini-compatible provider', () => {
  let gemini: Awaited<ReturnType<typeof startFakeProvider>>
  let other: Awaited<ReturnType<typeof startFakeProvider>>

  beforeAll(async () => {
    ;[gemini, other] = await Promise.all([startFakeProvider(), startFakeProvider()])
  })

  afterEach(() => {
    gemini.requests.length = 0
    other.requests.length = 0
  })

  afterAll(async () => {
    await Promise.all([gemini.close(), other.close()])
  })

  it('sends the placeholder signature after a failover from another model, and leaves other providers alone', async () => {
    for (const provider of [gemini, other])
      provider.setHandler((_req, res) => void writeEvents(res, [sse({ choices: [{ index: 0, delta: { content: 'The weather is fine.' } }] }), sse('[DONE]')]))
    const { gateway } = await startRoutedGateway({
      providers: {
        gemini: { baseURL: gemini.baseURL, keyRef: 'key-gemini', compat: 'gemini' },
        other: { baseURL: other.baseURL, keyRef: 'key-other' },
      },
      models: {
        'gemini-model': { provider: 'gemini', model: 'g', capabilities: { contextWindow: 100_000 } },
        'other-model': { provider: 'other', model: 'o', capabilities: { contextWindow: 100_000 } },
      },
      aliases: { 'companion-chat': { chain: ['gemini-model', 'other-model'] } },
    })
    const messages = [system('card'), user('weather in Osaka?'), assistantCalls([toolCall('call_x', 'get_weather', { location: 'Osaka' })]), toolResult('call_x', '21C clear')]

    const post = (model: string) => fetch(new URL('chat/completions', gateway.baseURL), { method: 'POST', headers: authHeaders(), body: JSON.stringify({ model, stream: true, messages }) }).then(response => response.text())
    await post('companion-chat:gemini-model')
    await post('companion-chat:other-model')
    await gateway.close()

    const toGemini = JSON.parse(gemini.requests[0].body).messages[2].tool_calls[0]
    const toOther = JSON.parse(other.requests[0].body).messages[2].tool_calls[0]
    expect(toGemini.extra_content.google.thought_signature).toBe(DUMMY)
    expect(toOther.extra_content).toBeUndefined()
  })
})
