import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { parseConfig, resolveModel } from '../src/config/config'
import { withStyleReminder } from '../src/providers/style-reminder'
import { authHeaders, sse, startFakeProvider, startRoutedGateway, writeEvents } from './support/harness'
import { assistant, filler, system, user } from './support/wire'

const REMINDER = 'Close every ACT token with the two characters |> together.'

describe('withStyleReminder', () => {
  it('adds the reminder to the end of the last leading system message', () => {
    const body = { model: 'm', messages: [system('card'), { role: 'developer', content: 'rules' }, user('hi')] }

    const prepared = withStyleReminder(body, REMINDER)

    expect(prepared.messages![0]).toBe(body.messages[0])
    expect(prepared.messages![1].content).toBe(`rules\n\n${REMINDER}`)
    expect(prepared.messages![2]).toBe(body.messages[2])
  })

  it('adds a text part when the system content is an array', () => {
    const body = { model: 'm', messages: [{ role: 'system', content: [{ type: 'text', text: 'card' }] }, user('hi')] }

    const content = withStyleReminder(body, REMINDER).messages![0].content as { type: string, text: string }[]

    expect(content).toEqual([{ type: 'text', text: 'card' }, { type: 'text', text: REMINDER }])
  })

  it('adds a system message when the request has none', () => {
    const prepared = withStyleReminder({ model: 'm', messages: [user('hi'), assistant('hello'), user('again')] }, REMINDER)

    expect(prepared.messages![0]).toEqual({ role: 'system', content: REMINDER })
    expect(prepared.messages).toHaveLength(4)
  })

  it('returns the same request when there is no reminder', () => {
    const body = { model: 'm', messages: [system('card'), user('hi')] }

    expect(withStyleReminder(body, undefined)).toBe(body)
  })

  it('never changes the request that it receives, because the router shares it', () => {
    const body = { model: 'm', messages: [system('card'), user('hi')] }
    const before = JSON.stringify(body)

    withStyleReminder(body, REMINDER)

    expect(JSON.stringify(body)).toBe(before)
  })

  it('keeps every other field of the request and of the message', () => {
    const body = { model: 'm', temperature: 0.3, messages: [{ role: 'system', content: 'card', name: 'persona' }, user('hi')], tools: [] }

    const prepared = withStyleReminder(body, REMINDER)

    expect(Object.keys(prepared)).toEqual(Object.keys(body))
    expect(prepared.messages![0]).toMatchObject({ role: 'system', name: 'persona' })
  })
})

describe('styleReminder configuration', () => {
  const base = {
    providers: { p: { baseURL: 'https://example.test/v1/', keyRef: 'key-p' } },
    aliases: { a: { chain: ['m'] } },
  }

  it('is optional and read into the resolved model', () => {
    const config = parseConfig({ ...base, models: { m: { provider: 'p', model: 'x', capabilities: { contextWindow: 1000 }, styleReminder: REMINDER } } })

    expect(resolveModel(config, 'm')?.styleReminder).toBe(REMINDER)
    expect(resolveModel(parseConfig({ ...base, models: { m: { provider: 'p', model: 'x', capabilities: { contextWindow: 1000 } } } }), 'm')?.styleReminder).toBeUndefined()
  })

  it('rejects an empty reminder and a very long one', () => {
    const entry = (styleReminder: string) => ({ ...base, models: { m: { provider: 'p', model: 'x', capabilities: { contextWindow: 1000 }, styleReminder } } })

    expect(() => parseConfig(entry(''))).toThrow(/styleReminder/)
    expect(() => parseConfig(entry('x'.repeat(2000)))).toThrow(/styleReminder/)
  })
})

describe('gateway with a style reminder', () => {
  let a: Awaited<ReturnType<typeof startFakeProvider>>
  let b: Awaited<ReturnType<typeof startFakeProvider>>

  beforeAll(async () => {
    ;[a, b] = await Promise.all([startFakeProvider(), startFakeProvider()])
  })

  afterEach(() => {
    a.requests.length = 0
    b.requests.length = 0
  })

  afterAll(async () => {
    await Promise.all([a.close(), b.close()])
  })

  it('sends the reminder to the model that has one and the plain request to the others', async () => {
    for (const provider of [a, b])
      provider.setHandler((_req, res) => void writeEvents(res, [sse({ choices: [{ index: 0, delta: { content: 'hi' } }] }), sse('[DONE]')]))
    const { gateway } = await startRoutedGateway({
      providers: { a: { baseURL: a.baseURL, keyRef: 'key-a' }, b: { baseURL: b.baseURL, keyRef: 'key-b' } },
      models: {
        'with-reminder': { provider: 'a', model: 'ma', capabilities: { contextWindow: 100_000 }, styleReminder: REMINDER },
        'plain': { provider: 'b', model: 'mb', capabilities: { contextWindow: 100_000 } },
      },
      aliases: { 'companion-chat': { chain: ['with-reminder', 'plain'] } },
    })
    const body = { stream: true, messages: [system(filler(200, 'card')), user('hello')] }
    const post = (model: string) => fetch(new URL('chat/completions', gateway.baseURL), { method: 'POST', headers: authHeaders(), body: JSON.stringify({ ...body, model }) }).then(response => response.text())

    await post('companion-chat:with-reminder')
    await post('companion-chat:plain')
    await gateway.close()

    const sentToA = JSON.parse(a.requests[0].body).messages as { content: string }[]
    const sentToB = JSON.parse(b.requests[0].body).messages as { content: string }[]
    expect(sentToA[0].content.endsWith(REMINDER)).toBe(true)
    expect(sentToB[0].content.includes(REMINDER)).toBe(false)
    expect(sentToA.at(-1)).toEqual({ role: 'user', content: 'hello' })
  })
})
