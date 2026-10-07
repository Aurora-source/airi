import type { ProviderHandler } from './support/harness'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { resolveModel } from '../src/config/config'
import { probeModel } from '../src/probe/probe'
import { ProbeStore, withProbedCapabilities } from '../src/probe/store'
import { openDatabase } from '../src/store/database'
import { catalogConfig } from './support/catalog'
import { sse, startFakeProvider, writeEvents } from './support/harness'

type Provider = Awaited<ReturnType<typeof startFakeProvider>>

let provider: Provider

beforeAll(async () => {
  provider = await startFakeProvider()
})

afterEach(() => {
  provider.requests.length = 0
})

afterAll(async () => {
  await provider.close()
})

function model(overrides: Record<string, unknown> = {}) {
  const config = catalogConfig({
    providers: { groq: { baseURL: provider.baseURL, keyRef: 'provider-groq' } },
    models: { 'probe-model': { provider: 'groq', model: 'fake-model-1', capabilities: { contextWindow: 32_768 }, ...overrides } },
    aliases: { 'companion-chat': { chain: ['probe-model'] } },
  })
  return resolveModel(config, 'probe-model')!
}

interface Behavior {
  models?: string[] | 'missing'
  tools?: 'ok' | 'missing-index' | 'unsupported'
  images?: boolean
  structured?: boolean
  contextLimit?: number
  headers?: Record<string, string>
}

/** A fake provider that answers each probe request the way a real OpenAI-compatible provider does. */
function behaves(behavior: Behavior = {}): ProviderHandler {
  return (req, res, received) => {
    if (req.method === 'GET') {
      if (behavior.models === 'missing') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":{"message":"not found"}}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: (behavior.models ?? ['fake-model-1']).map(id => ({ id, object: 'model' })) }))
      return
    }
    const body = JSON.parse(received.body) as { stream?: boolean, tools?: unknown[], messages: { content: unknown }[], response_format?: unknown }
    const fail = (status: number, message: string) => {
      res.writeHead(status, { 'content-type': 'application/json', ...behavior.headers })
      res.end(JSON.stringify({ error: { message } }))
    }
    const text = JSON.stringify(body.messages)
    if (behavior.contextLimit !== undefined && text.length / 3.4 > behavior.contextLimit)
      return fail(400, 'This model\'s maximum context length is exceeded.')

    let content = 'pong'
    let toolCalls: unknown[] | undefined
    if (body.tools) {
      if (behavior.tools === 'unsupported')
        return fail(400, 'tools are not supported by this model')
      toolCalls = [{ ...(behavior.tools === 'missing-index' ? {} : { index: 0 }), id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"location":"Osaka"}' } }]
    }
    if (text.includes('image_url')) {
      if (behavior.images === false)
        return fail(400, 'image input is not supported')
      content = 'red'
    }
    if (body.response_format) {
      if (behavior.structured === false)
        return fail(400, 'response_format is not supported')
      content = '{"ok":true}'
    }

    if (body.stream) {
      res.setHeader('content-type', 'text/event-stream')
      for (const [name, value] of Object.entries(behavior.headers ?? {}))
        res.setHeader(name, value)
      void writeEvents(res, [
        sse({ choices: [{ index: 0, delta: toolCalls ? { role: 'assistant', tool_calls: toolCalls } : { role: 'assistant', content } }] }),
        sse({ choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }),
        sse('[DONE]'),
      ])
      return
    }
    res.writeHead(200, { 'content-type': 'application/json', ...behavior.headers })
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3 } }))
  }
}

const OPTIONS = { apiKey: 'test-key', now: () => 1_000_000, timeoutMs: 2000 }

describe('probeModel', () => {
  it('records what a fully capable model supports', async () => {
    provider.setHandler(behaves())

    const result = await probeModel(model(), OPTIONS)

    expect(result).toMatchObject({ modelId: 'probe-model', reachable: true, exists: true, streaming: true, tools: true, images: true, structuredOutput: true, toolCallIndexMissing: false, probedAtMs: 1_000_000 })
    expect(result.firstByteMs).toBeGreaterThanOrEqual(0)
    expect(result.failures).toEqual({})
  })

  it('sends the provider key and the wire model name', async () => {
    provider.setHandler(behaves())

    await probeModel(model(), OPTIONS)

    const posts = provider.requests.filter(request => request.method === 'POST')
    expect(posts.length).toBeGreaterThanOrEqual(4)
    expect(posts.every(request => request.headers.authorization === 'Bearer test-key')).toBe(true)
    expect(posts.every(request => JSON.parse(request.body).model === 'fake-model-1')).toBe(true)
  })

  it('records a model that rejects tools and images, with the reason', async () => {
    provider.setHandler(behaves({ tools: 'unsupported', images: false, structured: false }))

    const result = await probeModel(model(), OPTIONS)

    expect(result).toMatchObject({ reachable: true, streaming: true, tools: false, images: false, structuredOutput: false })
    expect(result.failures.tools).toContain('tools are not supported')
    expect(result.failures.images).toContain('image input is not supported')
  })

  it('notices streamed tool calls without an index, the Gemini quirk that needs the compat adapter', async () => {
    provider.setHandler(behaves({ tools: 'missing-index' }))

    const result = await probeModel(model(), OPTIONS)

    expect(result.tools).toBe(true)
    expect(result.toolCallIndexMissing).toBe(true)
  })

  it('records an unknown existence when the provider has no model list', async () => {
    provider.setHandler(behaves({ models: 'missing' }))

    const result = await probeModel(model(), OPTIONS)

    expect(result.exists).toBeUndefined()
    expect(result.reachable).toBe(true)
  })

  it('records a model that the provider does not list', async () => {
    provider.setHandler(behaves({ models: ['another-model'] }))

    expect((await probeModel(model(), OPTIONS)).exists).toBe(false)
  })

  it('keeps the rate-limit headers that the provider sent', async () => {
    provider.setHandler(behaves({ headers: { 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '7900', 'x-ratelimit-reset-tokens': '1s' } }))

    const result = await probeModel(model(), OPTIONS)

    expect(result.rateLimit).toMatchObject({ limitTokens: 8000, remainingTokens: 7900 })
  })

  it('reports an unreachable provider and skips the remaining tests', async () => {
    const unreachable = model({ provider: 'groq' })
    const dead = { ...unreachable, provider: { ...unreachable.provider, baseURL: 'http://127.0.0.1:1/v1/' } }

    const result = await probeModel(dead, OPTIONS)

    expect(result.reachable).toBe(false)
    expect(result.streaming).toBe(false)
    expect(result.failures.reachable).toBeDefined()
  })

  it('finds the largest prompt that the provider accepts when a deep probe asks for it', async () => {
    provider.setHandler(behaves({ contextLimit: 9000 }))

    const result = await probeModel(model(), { ...OPTIONS, deep: { stepsTokens: [1000, 4000, 8000, 16_000, 32_000] } })

    expect(result.maxAcceptedPromptTokens).toBe(8000)
    expect(result.failures.context).toContain('16000')
  })

  it('never puts the key into a stored failure text', async () => {
    provider.setHandler((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"data":[{"id":"fake-model-1"}]}')
        return
      }
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"Incorrect API key provided: test-key"}}')
    })

    const result = await probeModel(model(), OPTIONS)

    expect(JSON.stringify(result)).not.toContain('test-key')
  })
})

describe('probeStore', () => {
  const T0 = 5_000_000
  const DAY = 86_400_000

  it('stores a result and returns it until it expires', async () => {
    provider.setHandler(behaves())
    const clock = { now: T0 }
    const store = new ProbeStore(openDatabase(':memory:'), () => clock.now, { maxAgeMs: 7 * DAY })
    store.set(await probeModel(model(), { ...OPTIONS, now: () => T0 }))

    expect(store.get('probe-model')).toMatchObject({ tools: true })

    clock.now += 8 * DAY
    expect(store.get('probe-model')).toBeUndefined()
  })

  it('replaces the configured capabilities with what the probe measured', async () => {
    provider.setHandler(behaves({ tools: 'unsupported', images: false }))
    const resolved = model({ capabilities: { contextWindow: 32_768, tools: true, images: true } })
    const result = await probeModel(resolved, OPTIONS)

    const effective = withProbedCapabilities(resolved.capabilities, result)

    expect(effective).toMatchObject({ tools: false, images: false, streaming: true, contextWindow: 32_768 })
  })

  it('lowers the context window to the largest accepted prompt but never raises it', async () => {
    provider.setHandler(behaves({ contextLimit: 9000 }))
    const resolved = model()
    const deep = await probeModel(resolved, { ...OPTIONS, deep: { stepsTokens: [1000, 8000, 16_000] } })

    expect(withProbedCapabilities(resolved.capabilities, deep).maxPrompt).toBe(8000)
    expect(withProbedCapabilities({ ...resolved.capabilities, maxPrompt: 4000 }, deep).maxPrompt).toBe(4000)
  })

  it('keeps the configuration when the provider was unreachable, because that says nothing about capabilities', async () => {
    const resolved = model()
    const dead = { ...resolved, provider: { ...resolved.provider, baseURL: 'http://127.0.0.1:1/v1/' } }
    const result = await probeModel(dead, OPTIONS)

    expect(withProbedCapabilities(resolved.capabilities, result)).toEqual(resolved.capabilities)
  })
})
