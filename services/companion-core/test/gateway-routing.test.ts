import type { RunningGateway } from '../src'
import type { ProviderHandler } from './support/harness'

import { Buffer } from 'node:buffer'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { authHeaders, sse, startFakeProvider, startRoutedGateway, TEST_OPS_TOKEN, TEST_PROVIDER_KEY, writeEvents } from './support/harness'
import { AIRI_TOOLS, assistant, assistantCalls, filler, system, toolCall, toolResult, user } from './support/wire'

type Provider = Awaited<ReturnType<typeof startFakeProvider>>

let a: Provider
let b: Provider
let c: Provider
let gateway: RunningGateway
let logs: string[]

beforeAll(async () => {
  ;[a, b, c] = await Promise.all([startFakeProvider(), startFakeProvider(), startFakeProvider()])
})

afterEach(async () => {
  await gateway.close()
  for (const provider of [a, b, c])
    provider.requests.length = 0
})

afterAll(async () => {
  await Promise.all([a.close(), b.close(), c.close()])
})

const CAPABILITIES = { contextWindow: 128_000, images: true, structuredOutput: true }

/** Provider handlers. A fake provider answers like a real one: with a stream, an error, or a broken connection. */
function answers(text: string, usage?: { prompt_tokens: number, completion_tokens: number }, headers: Record<string, string> = {}): ProviderHandler {
  return (_req, res) => {
    const events = [
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
      sse({ choices: [{ index: 0, delta: { content: text } }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...(usage ? { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } } : {}) }),
      sse('[DONE]'),
    ]
    res.setHeader('content-type', 'text/event-stream')
    for (const [name, value] of Object.entries(headers))
      res.setHeader(name, value)
    void writeEvents(res, events)
  }
}

function fails(status: number, body: unknown, headers: Record<string, string> = {}): ProviderHandler {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }
}

const dropsConnection: ProviderHandler = (_req, res) => {
  res.destroy()
}

/** Configuration of a gateway over the three fake providers. `a` and `b` are cloud providers and `c` is local. */
function setup(overrides: Record<string, unknown> = {}, chain = ['a-model', 'b-model'], modelOverrides: Record<string, Record<string, unknown>> = {}) {
  return {
    providers: {
      a: { baseURL: a.baseURL, keyRef: 'key-a' },
      b: { baseURL: b.baseURL, keyRef: 'key-b' },
      c: { baseURL: c.baseURL, locality: 'local' },
    },
    models: {
      'a-model': { provider: 'a', model: 'model-a', capabilities: CAPABILITIES, ...modelOverrides['a-model'] },
      'b-model': { provider: 'b', model: 'model-b', capabilities: CAPABILITIES, ...modelOverrides['b-model'] },
      'c-local': { provider: 'c', model: 'model-c', capabilities: { contextWindow: 16_000 } },
    },
    aliases: { 'companion-chat': { chain } },
    ...overrides,
  }
}

async function start(config: Record<string, unknown>) {
  ;({ gateway, logs } = await startRoutedGateway(config))
}

function chatBody(extra: Record<string, unknown> = {}, opening = 'Hello Mura, it is me'): Record<string, unknown> {
  return { model: 'companion-chat', stream: true, messages: [system(filler(300, 'card')), user(opening)], ...extra }
}

async function post(body: Record<string, unknown>) {
  const response = await fetch(new URL('chat/completions', gateway.baseURL), { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) })
  return { response, text: await response.text() }
}

async function opsStatus() {
  const response = await fetch(new URL('../ops/status', gateway.baseURL), { headers: { authorization: `Bearer ${TEST_OPS_TOKEN}` } })
  return await response.json() as {
    profile: string
    aliases: Record<string, { chain: { id: string, health: { calibration: number }, ledger: { usage: { minute: { requests: number, inputTokens: number } }, cooldown?: { reason: string }, observed?: { remainingTokens?: number } } }[] }>
    sticky: { modelId: string, reason: string }[]
    recentRoutes: { modelId?: string, attempts: string[], skipped: string[] }[]
  }
}

describe('gateway routing: chain and preflight', () => {
  beforeEach(async () => {
    await start(setup())
  })

  it('serves from the head of the chain and never touches the next provider', async () => {
    a.setHandler(answers('from a'))

    const { response, text } = await post(chatBody())

    expect(response.status).toBe(200)
    expect(text).toContain('from a')
    expect(response.headers.get('x-companion-model')).toBe('a-model')
    expect(response.headers.get('x-companion-attempts')).toBe('a-model=ok')
    expect(a.requests).toHaveLength(1)
    expect(b.requests).toHaveLength(0)
    expect(JSON.parse(a.requests[0].body).model).toBe('model-a')
    expect(a.requests[0].headers.authorization).toBe(`Bearer ${TEST_PROVIDER_KEY}-key-a`)
  })

  it('skips a model that lacks a capability before sending, so that its provider sees no request', async () => {
    await gateway.close()
    await start(setup({}, ['a-model', 'b-model'], { 'a-model': { capabilities: { contextWindow: 128_000, tools: false } } }))
    b.setHandler(answers('from b'))

    const { response, text } = await post(chatBody({ tools: AIRI_TOOLS }))

    expect(text).toContain('from b')
    expect(response.headers.get('x-companion-skipped')).toBe('a-model=CAPABILITY_TOOLS')
    expect(a.requests).toHaveLength(0)
  })

  it('does not send a tool turn that cannot fit the per-minute token limit of the provider', async () => {
    await gateway.close()
    await start(setup({}, ['a-model', 'b-model'], { 'a-model': { limits: { tpm: 7000 } } }))
    b.setHandler(answers('from b'))
    const body = chatBody({ tools: AIRI_TOOLS, tool_choice: 'required', messages: [system(filler(700, 'card')), user('what is the weather?')] })

    const { response } = await post(body)

    expect(response.headers.get('x-companion-skipped')).toBe('a-model=TPM_INELIGIBLE')
    expect(response.headers.get('x-companion-model')).toBe('b-model')
    expect(a.requests).toHaveLength(0)
  })

  it('answers the second round of a tool turn from the quota ledger, without a request that would only get a 429', async () => {
    await gateway.close()
    await start(setup({}, ['a-model'], { 'a-model': { limits: { tpm: 7000 } } }))
    a.setHandler(answers('call the tool'))
    // About 3.8k tokens of card and tool schemas: the size of a real AIRI request, which R2A measured at 4.4k with nine tools.
    const messages = [system(filler(1500, 'card')), user('what is the weather in Osaka?')]

    // Round one fits the minute budget. Round two carries the tool result and does not fit next to it.
    const first = await post(chatBody({ tools: AIRI_TOOLS, messages }))
    const second = await post(chatBody({
      tools: AIRI_TOOLS,
      messages: [...messages, assistantCalls([toolCall('w', 'get_weather', { location: 'Osaka' })]), toolResult('w', '21C clear')],
    }))

    expect(first.response.status).toBe(200)
    expect(first.response.headers.get('x-companion-tier')).toBe('first-round-only')
    expect(second.response.status).toBe(429)
    expect(Number(second.response.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(JSON.parse(second.text).error.code).toBe('rate_limit_exceeded')
    expect(second.response.headers.get('x-companion-skipped')).toBe('a-model=TPM_WINDOW_FULL')
    expect(a.requests).toHaveLength(1)
  })

  it('trims the history to the prompt limit of the model that receives it', async () => {
    await gateway.close()
    await start(setup({}, ['a-model'], { 'a-model': { capabilities: { ...CAPABILITIES, maxPrompt: 1500 } } }))
    a.setHandler(answers('ok'))
    const history = Array.from({ length: 30 }, (_, i) => [user(filler(60, `u${i}`)), assistant(filler(60, `a${i}`))]).flat()
    const messages = [system(filler(300, 'card')), ...history, user('and now?')]

    await post(chatBody({ messages }))

    const sent = JSON.parse(a.requests[0].body).messages as { role: string, content: string }[]
    expect(sent.length).toBeLessThan(messages.length)
    expect(sent[0].role).toBe('system')
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'and now?' })
    expect(JSON.stringify(sent).length / 3.4).toBeLessThan(1500 * 1.3)
  })

  it('fits the model of the chain that can take a request that the head cannot', async () => {
    await gateway.close()
    await start(setup({}, ['a-model', 'b-model'], { 'a-model': { capabilities: { contextWindow: 128_000, images: false } } }))
    b.setHandler(answers('sees the image'))
    const picture = { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }

    const { response } = await post(chatBody({ messages: [system('card'), picture] }))

    expect(response.headers.get('x-companion-model')).toBe('b-model')
    expect(a.requests).toHaveLength(0)
  })
})

describe('gateway routing: failover before the first token', () => {
  beforeEach(async () => {
    await start(setup({ routing: { firstByteTimeoutMs: 250 } }))
  })

  it('moves to the next model on a 429, honors Retry-After, and does not call the resting model again', async () => {
    a.setHandler(fails(429, { error: { message: 'Rate limit reached on requests per minute (RPM): Limit 30, Used 30, Requested 1. Please try again in 5s.' } }, { 'retry-after': '5' }))
    b.setHandler(answers('from b'))

    const first = await post(chatBody())
    const second = await post(chatBody({}, 'A different conversation'))

    expect(first.text).toContain('from b')
    expect(first.response.headers.get('x-companion-attempts')).toBe('a-model=rate-limited,b-model=ok')
    expect(second.response.headers.get('x-companion-model')).toBe('b-model')
    expect(second.response.headers.get('x-companion-skipped')).toBe('a-model=COOLING_DOWN')
    expect(a.requests).toHaveLength(1)
    const status = await opsStatus()
    expect(status.aliases['companion-chat'].chain[0].ledger.cooldown?.reason).toBe('rate-limited:minute:requests')
  })

  it('moves to the next model on a server error', async () => {
    a.setHandler(fails(500, 'internal error'))
    b.setHandler(answers('from b'))

    const { response, text } = await post(chatBody())

    expect(text).toContain('from b')
    expect(response.headers.get('x-companion-attempts')).toBe('a-model=server,b-model=ok')
  })

  it('moves to the next model when the connection drops before any response', async () => {
    a.setHandler(dropsConnection)
    b.setHandler(answers('from b'))

    const { response } = await post(chatBody())

    expect(response.headers.get('x-companion-attempts')).toBe('a-model=network,b-model=ok')
  })

  it('moves to the next model when the provider does not answer in time', async () => {
    a.setHandler(() => {})
    b.setHandler(answers('from b'))
    const started = performance.now()

    const { response } = await post(chatBody())

    expect(response.headers.get('x-companion-attempts')).toBe('a-model=timeout,b-model=ok')
    expect(performance.now() - started).toBeLessThan(3000)
  })

  it('moves to the next model when the provider sends headers and then breaks before the first byte', async () => {
    a.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.flushHeaders()
      setTimeout(() => res.destroy(), 20)
    })
    b.setHandler(answers('from b'))

    const { response, text } = await post(chatBody())

    expect(text).toContain('from b')
    expect(response.headers.get('x-companion-attempts')).toBe('a-model=network,b-model=ok')
  })

  it('moves to the next model when the provider rejects its key or its model', async () => {
    a.setHandler(fails(401, { error: { message: 'Invalid API Key' } }))
    b.setHandler(answers('from b'))

    expect((await post(chatBody())).response.headers.get('x-companion-attempts')).toBe('a-model=auth,b-model=ok')

    a.setHandler(fails(404, { error: { message: 'model not found' } }))
    expect((await post(chatBody({}, 'another opening'))).response.headers.get('x-companion-model')).toBe('b-model')
  })

  it('moves to the next model when the provider refuses the request as too large', async () => {
    a.setHandler(fails(400, { error: { message: 'This model\'s maximum context length is 8192 tokens. However, you requested 9000 tokens.' } }))
    b.setHandler(answers('from b'))

    const { response } = await post(chatBody())

    expect(response.headers.get('x-companion-attempts')).toBe('a-model=too-large,b-model=ok')
  })

  it('passes a request error through and does not ask another model, because the answer would be the same', async () => {
    a.setHandler(fails(400, { error: { message: 'Invalid value for tool_choice', type: 'invalid_request_error' } }))
    b.setHandler(answers('from b'))

    const { response, text } = await post(chatBody())

    expect(response.status).toBe(400)
    expect(JSON.parse(text).error.message).toBe('Invalid value for tool_choice')
    expect(b.requests).toHaveLength(0)
  })

  it('passes the last provider error through unchanged when every model fails', async () => {
    const body = JSON.stringify({ error: { message: 'Rate limit reached on tokens per minute (TPM): Limit 7000, Used 6500, Requested 900. Please try again in 7s.', code: 'rate_limit_exceeded' } })
    a.setHandler(fails(503, 'upstream is down'))
    b.setHandler(fails(429, body, { 'retry-after': '7' }))

    const { response, text } = await post(chatBody())

    expect(response.status).toBe(429)
    expect(text).toBe(body)
    expect(response.headers.get('retry-after')).toBe('7')
    expect(response.headers.get('x-companion-attempts')).toBe('a-model=server,b-model=rate-limited')
  })

  it('reports a gateway error when every provider is unreachable', async () => {
    a.setHandler(dropsConnection)
    b.setHandler(dropsConnection)

    const { response, text } = await post(chatBody())

    expect(response.status).toBe(502)
    expect(JSON.parse(text).error.code).toBe('provider_unreachable')
  })
})

describe('gateway routing: no switch after the first token', () => {
  beforeEach(async () => {
    await start(setup())
  })

  it('ends the client stream when the provider breaks after output started, and never asks another model to continue', async () => {
    const first = sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'The weather ' } }] })
    a.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(first)
      setTimeout(() => res.destroy(), 40)
    })
    b.setHandler(answers('from b'))

    const response = await fetch(new URL('chat/completions', gateway.baseURL), { method: 'POST', headers: authHeaders(), body: JSON.stringify(chatBody()) })
    let received = ''
    let broke = false
    try {
      for await (const chunk of response.body!)
        received += Buffer.from(chunk).toString('utf8')
    }
    catch {
      broke = true
    }

    expect(response.status).toBe(200)
    expect(received).toBe(first)
    expect(broke).toBe(true)
    expect(b.requests).toHaveLength(0)
    await expect.poll(() => logs.some(line => line.includes('stream_broke'))).toBe(true)
  })

  it('serves the next request from another model after that break, because the failed model rests', async () => {
    a.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse({ choices: [{ index: 0, delta: { content: 'partial' } }] }))
      setTimeout(() => res.destroy(), 40)
    })
    b.setHandler(answers('from b'))
    const broken = await fetch(new URL('chat/completions', gateway.baseURL), { method: 'POST', headers: authHeaders(), body: JSON.stringify(chatBody()) })
    await broken.arrayBuffer().catch(() => {})

    const { response } = await post(chatBody({}, 'The next conversation'))

    expect(response.headers.get('x-companion-model')).toBe('b-model')
  })
})

describe('gateway routing: stickiness and override', () => {
  beforeEach(async () => {
    await start(setup())
  })

  it('keeps the model that took over, in the same conversation, after the head is free again', async () => {
    a.setHandler(fails(429, { error: { message: 'slow down' } }, { 'retry-after': '1' }))
    b.setHandler(answers('from b'))
    await post(chatBody())
    await new Promise(resolve => setTimeout(resolve, 1300))
    a.setHandler(answers('from a'))

    const sameConversation = await post(chatBody({ messages: [system('card'), user('Hello Mura, it is me'), assistant('hi'), user('how are you?')] }))
    const otherConversation = await post(chatBody({}, 'A new conversation'))

    expect(sameConversation.response.headers.get('x-companion-model')).toBe('b-model')
    expect(otherConversation.response.headers.get('x-companion-model')).toBe('a-model')
    const status = await opsStatus()
    expect(status.sticky.find(choice => choice.modelId === 'b-model')?.reason).toMatch(/^failover:/)
  })

  it('serves a pinned model from alias:model and does not change the sticky choice', async () => {
    a.setHandler(answers('from a'))
    b.setHandler(answers('from b'))

    const pinned = await post(chatBody({ model: 'companion-chat:b-model' }))
    const normal = await post(chatBody())

    expect(pinned.response.headers.get('x-companion-model')).toBe('b-model')
    expect(normal.response.headers.get('x-companion-model')).toBe('a-model')
  })

  it('does not fall back from a pinned model that fails', async () => {
    b.setHandler(fails(500, 'broken'))
    a.setHandler(answers('from a'))

    const { response } = await post(chatBody({ model: 'companion-chat:b-model' }))

    expect(response.status).toBe(500)
    expect(a.requests).toHaveLength(0)
  })

  it('answers an unknown pinned model as not found', async () => {
    const { response, text } = await post(chatBody({ model: 'companion-chat:nobody' }))

    expect(response.status).toBe(404)
    expect(JSON.parse(text).error.code).toBe('model_not_found')
  })
})

describe('gateway routing: compute profiles', () => {
  it('never starts local inference when the cloud chain is exhausted in a cloud profile', async () => {
    await start(setup({ profile: 'cloud-mura-voice' }))
    a.setHandler(fails(429, { error: { message: 'quota' } }, { 'retry-after': '30' }))
    b.setHandler(fails(429, { error: { message: 'quota' } }, { 'retry-after': '30' }))
    c.setHandler(answers('local answer'))

    const { response } = await post(chatBody())
    const again = await post(chatBody())

    expect(response.status).toBe(429)
    expect(again.response.status).toBe(429)
    expect(c.requests).toHaveLength(0)
  })

  it('falls back to the listed local model in a hybrid profile, after every cloud model failed', async () => {
    await start(setup({ profile: 'hybrid' }, ['a-model', 'b-model', 'c-local']))
    a.setHandler(fails(429, { error: { message: 'quota' } }, { 'retry-after': '30' }))
    b.setHandler(fails(500, 'down'))
    c.setHandler(answers('local answer'))

    const { response, text } = await post(chatBody())

    expect(text).toContain('local answer')
    expect(response.headers.get('x-companion-model')).toBe('c-local')
    expect(response.headers.get('x-companion-attempts')).toBe('a-model=rate-limited,b-model=server,c-local=ok')
    expect(c.requests[0].headers.authorization).toBeUndefined()
  })
})

describe('gateway routing: the ledger learns from provider responses', () => {
  beforeEach(async () => {
    await start(setup({}, ['a-model', 'b-model'], { 'a-model': { limits: { tpm: 20_000 } } }))
  })

  it('replaces its token estimate with the usage that the provider reports, and calibrates the estimator', async () => {
    a.setHandler(answers('ok', { prompt_tokens: 1000, completion_tokens: 20 }))
    const messages = [system(filler(1500, 'card')), user('hello')]

    await post(chatBody({ messages }))
    const status = await opsStatus()

    const model = status.aliases['companion-chat'].chain[0]
    expect(model.ledger.usage.minute.requests).toBe(1)
    expect(model.ledger.usage.minute.inputTokens).toBe(1000)
    expect(model.health.calibration).toBeLessThan(1)
    expect(model.health.calibration).toBeGreaterThan(0.8)
  })

  it('stops sending to a provider that reported no tokens left in this minute', async () => {
    a.setHandler(answers('ok', undefined, { 'x-ratelimit-remaining-tokens': '100', 'x-ratelimit-reset-tokens': '30s', 'x-ratelimit-limit-tokens': '20000' }))
    b.setHandler(answers('from b'))

    await post(chatBody())
    const next = await post(chatBody({}, 'another conversation'))

    expect(next.response.headers.get('x-companion-model')).toBe('b-model')
    expect(next.response.headers.get('x-companion-skipped')).toBe('a-model=TPM_WINDOW_FULL')
    expect(a.requests).toHaveLength(1)
    expect((await opsStatus()).aliases['companion-chat'].chain[0].ledger.observed?.remainingTokens).toBe(100)
  })
})

describe('gateway routing: diagnostics and privacy', () => {
  beforeEach(async () => {
    await start(setup())
  })

  it('logs model ids, outcomes, and token counts and never message text', async () => {
    a.setHandler(answers('a reply that must not be logged'))

    await post(chatBody({}, 'my private diary entry about Tuesday'))

    const lines = logs.join('\n')
    expect(lines).toContain('"model":"a-model"')
    expect(lines).toContain('"tokens":{')
    expect(lines).toContain('"attempts":["a-model=ok"]')
    expect(lines).not.toContain('diary')
    expect(lines).not.toContain('must not be logged')
    expect(lines).not.toContain(TEST_PROVIDER_KEY)
  })

  it('shows the routing state at /ops/status for the ops token only, without keys or text', async () => {
    a.setHandler(answers('hello'))
    await post(chatBody({}, 'secret opening line'))

    const withInference = await fetch(new URL('../ops/status', gateway.baseURL), { headers: authHeaders() })
    const withOps = await fetch(new URL('../ops/status', gateway.baseURL), { headers: { authorization: `Bearer ${TEST_OPS_TOKEN}` } })
    const text = await withOps.text()

    expect(withInference.status).toBe(401)
    expect(withOps.status).toBe(200)
    expect(text).toContain('"profile":"cloud-mura-voice"')
    expect(text).toContain('a-model')
    expect(text).not.toContain(TEST_PROVIDER_KEY)
    expect(text).not.toContain('secret opening line')
    expect(text).not.toContain('Bearer')
  })

  it('lists each model of the chain next to the alias, so that a user can pin one from the model list', async () => {
    const response = await fetch(new URL('models', gateway.baseURL), { headers: authHeaders() })

    const ids = ((await response.json()) as { data: { id: string }[] }).data.map(model => model.id)

    expect(ids).toEqual(['companion-chat', 'companion-chat:a-model', 'companion-chat:b-model'])
  })
})
