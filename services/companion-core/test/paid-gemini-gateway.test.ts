import type { RunningGateway } from '../src'
import type { ProviderHandler } from './support/harness'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { parseConfig, startGateway } from '../src'
import { authHeaders, sse, startFakeProvider, TEST_INFERENCE_TOKEN, TEST_OPS_TOKEN, TEST_PROVIDER_KEY, writeEvents } from './support/harness'
import { system, user } from './support/wire'

type Provider = Awaited<ReturnType<typeof startFakeProvider>>

/** A fixed clock inside 2026, so the 3.6 to 3.8 Flash prices are the 2026 prices. */
const NOW = Date.parse('2026-10-09T12:00:00Z')
const CAPABILITIES = { contextWindow: 128_000, images: true, structuredOutput: true }

let gemini: Provider
let other: Provider
let gateway: RunningGateway | undefined
let logs: string[] = []
const directories: string[] = []

beforeAll(async () => {
  ;[gemini, other] = await Promise.all([startFakeProvider(), startFakeProvider()])
})

afterEach(async () => {
  await gateway?.close()
  gateway = undefined
  gemini.requests.length = 0
  other.requests.length = 0
  logs = []
})

afterAll(async () => {
  await Promise.all([gemini.close(), other.close()])
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true })
})

/** The user's production shape: a free-tier fixture entry of 3.1 Flash-Lite first, then a non-Gemini fallback. */
function raw(overrides: Record<string, unknown> = {}, chain = ['gemini-flash-lite-31', 'other-model']) {
  return {
    port: 0,
    store: { path: ':memory:' },
    allowedOrigins: [],
    providers: {
      gemini: { baseURL: gemini.baseURL, keyRef: 'provider-gemini', compat: 'gemini' },
      other: { baseURL: other.baseURL, keyRef: 'provider-other' },
    },
    models: {
      'gemini-flash-lite-31': { provider: 'gemini', model: 'gemini-3.1-flash-lite', capabilities: CAPABILITIES, limits: { rpm: 15, rpd: 500 } },
      'other-model': { provider: 'other', model: 'other-1', capabilities: CAPABILITIES },
    },
    aliases: { 'companion-chat': { chain } },
    ...overrides,
  }
}

async function start(config: Record<string, unknown>, keys: Record<string, string> = { 'provider-gemini': TEST_PROVIDER_KEY, 'provider-other': `${TEST_PROVIDER_KEY}-other` }) {
  gateway = await startGateway({
    config: parseConfig(config),
    credentials: { inference: TEST_INFERENCE_TOKEN, ops: TEST_OPS_TOKEN },
    providerKeys: new Map(Object.entries(keys)),
    writeLog: line => logs.push(line),
    runtime: { now: () => NOW },
  })
  return gateway
}

function fileStore(): Record<string, unknown> {
  const directory = mkdtempSync(join(tmpdir(), 'companion-paid-'))
  directories.push(directory)
  return { path: join(directory, 'state.sqlite') }
}

function answers(usage?: Record<string, unknown>): ProviderHandler {
  return (_req, res) => {
    void writeEvents(res, [
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello there' } }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ...(usage ? [sse({ choices: [], usage })] : []),
      sse('[DONE]'),
    ])
  }
}

function fails(status: number): ProviderHandler {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'scripted failure' } }))
  }
}

async function chat(extra: Record<string, unknown> = {}) {
  const response = await fetch(new URL('chat/completions', gateway!.baseURL), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ model: 'companion-chat', stream: true, messages: [system('You are Mura.'), user('Hi Mura')], ...extra }),
  })
  return { response, text: await response.text() }
}

async function ops(path: string, body?: unknown, token = TEST_OPS_TOKEN) {
  const response = await fetch(new URL(`../ops/${path}`, gateway!.baseURL), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() as Record<string, any> }
}

const sent = (provider: Provider, index = -1) => JSON.parse(provider.requests.at(index)!.body) as Record<string, any>

describe('paid Gemini selection', () => {
  it('leads the alias with the recommended default, 3.8 Flash low, and asks for streamed usage', async () => {
    await start(raw())
    gemini.setHandler(answers({ prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 }))

    const { response } = await chat()

    expect(response.status).toBe(200)
    expect(response.headers.get('x-companion-model')).toBe('selected:gemini-3.8-flash')
    expect(response.headers.get('x-companion-effort')).toBe('low')
    const body = sent(gemini)
    expect(body.model).toBe('gemini-3.8-flash')
    expect(body.reasoning_effort).toBe('low')
    expect(body.stream_options).toEqual({ include_usage: true })
    const models = (await ops('models')).json
    expect(models.selection).toMatchObject({ model: 'gemini-3.8-flash', effort: 'low', source: 'default', active: true })
    expect(models.fallback).toEqual(['gemini-flash-lite-31', 'other-model'])
  })

  it('applies an Ops selection to the next real request', async () => {
    await start(raw())
    gemini.setHandler(answers())

    const selected = await ops('models/select', { model: 'gemini-3.6-flash', effort: 'minimal' })
    await chat()

    expect(selected.status).toBe(200)
    expect(selected.json.selection).toMatchObject({ model: 'gemini-3.6-flash', effort: 'minimal', source: 'user' })
    expect(sent(gemini)).toMatchObject({ model: 'gemini-3.6-flash', reasoning_effort: 'minimal' })
  })

  it('rejects unsupported pairs and unknown models without changing the selection', async () => {
    await start(raw())

    const minimal = await ops('models/select', { model: 'gemini-3.8-flash', effort: 'minimal' })
    const off = await ops('models/select', { model: 'gemini-3.6-flash', effort: 'none' })
    const unknown = await ops('models/select', { model: 'gemini-3-flash-preview', effort: 'low' })

    expect(minimal.status).toBe(400)
    expect(minimal.json.error).toMatchObject({ code: 'unsupported_effort', supported: ['low', 'medium', 'high'] })
    expect(off.status).toBe(400)
    expect(unknown.status).toBe(400)
    expect(unknown.json.error.code).toBe('unknown_model')
    expect((await ops('models')).json.selection).toMatchObject({ model: 'gemini-3.8-flash', effort: 'low', source: 'default' })
  })

  it('accepts selection only with the ops token', async () => {
    await start(raw())

    const inference = await ops('models/select', { model: 'gemini-3.6-flash', effort: 'low' }, TEST_INFERENCE_TOKEN)
    const usage = await ops('usage', undefined, TEST_INFERENCE_TOKEN)

    expect(inference.status).toBe(401)
    expect(usage.status).toBe(401)
    expect((await ops('models')).json.selection.source).toBe('default')
  })

  it('keeps the selection and the usage ledger across a restart', async () => {
    const store = fileStore()
    await start(raw({ store }))
    gemini.setHandler(answers({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }))
    await ops('models/select', { model: 'gemini-3.7-flash', effort: 'high' })
    await chat()
    await gateway!.close()

    await start(raw({ store }))
    await chat()

    expect((await ops('models')).json.selection).toMatchObject({ model: 'gemini-3.7-flash', effort: 'high', source: 'user' })
    expect(sent(gemini)).toMatchObject({ model: 'gemini-3.7-flash', reasoning_effort: 'high' })
    expect((await ops('usage')).json.today.settled).toBe(2)
  })

  it('falls back through the configured chain without converting the effort', async () => {
    await start(raw())
    gemini.setHandler((req, res, received) => {
      const body = JSON.parse(received.body) as { model: string }
      return (body.model === 'gemini-3.8-flash' ? fails(503) : answers({ prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 }))(req, res, received)
    })

    const { response } = await chat()

    expect(response.headers.get('x-companion-model')).toBe('gemini-flash-lite-31')
    expect(response.headers.get('x-companion-effort')).toBeNull()
    expect(gemini.requests).toHaveLength(2)
    expect(sent(gemini, 0).reasoning_effort).toBe('low')
    expect(sent(gemini, 1).reasoning_effort).toBeUndefined()
    const usage = (await ops('usage')).json
    expect(usage.recent.map((record: Record<string, unknown>) => [record.model, record.status, record.effort, record.effortSource])).toEqual([
      ['gemini-3.1-flash-lite', 'settled', 'minimal', 'provider-default'],
      ['gemini-3.8-flash', 'failed', 'low', 'selection'],
    ])
    expect(usage.errors).toEqual({ server: 1 })
  })

  it('does not try a configured entry of the selected model again', async () => {
    await start(raw())
    await ops('models/select', { model: 'gemini-3.1-flash-lite', effort: 'low' })
    gemini.setHandler(fails(503))
    other.setHandler(answers())

    const { response } = await chat()

    expect(gemini.requests).toHaveLength(1)
    expect(response.headers.get('x-companion-model')).toBe('other-model')
    expect((await ops('models')).json.fallback).toEqual(['other-model'])
  })

  it('skips a model whose levels exclude a client reasoning_effort', async () => {
    await start(raw())
    other.setHandler(answers())

    const pinned = await chat({ model: 'companion-chat:gemini-flash-lite-31', reasoning_effort: 'none' })

    expect(pinned.response.status).toBe(400)
    expect(pinned.text).toContain('THINKING_UNSUPPORTED')
    expect(gemini.requests).toHaveLength(0)
  })

  it('refuses a selection in the local profile', async () => {
    await start(raw({ profile: 'local', providers: { gemini: { baseURL: gemini.baseURL, keyRef: 'provider-gemini', compat: 'gemini' }, local: { baseURL: other.baseURL, locality: 'local' } }, models: { 'local-model': { provider: 'local', model: 'gemma', capabilities: CAPABILITIES } } }, ['local-model']))

    const selected = await ops('models/select', { model: 'gemini-3.8-flash', effort: 'low' })

    expect(selected.status).toBe(409)
    expect((await ops('models')).json).toMatchObject({ available: false })
  })
})

describe('paid Gemini usage telemetry', () => {
  it('counts Gemini thinking once and prices it as output', async () => {
    await start(raw())
    await ops('models/select', { model: 'gemini-3.8-flash', effort: 'medium' })
    gemini.setHandler(answers({ prompt_tokens: 585, completion_tokens: 32, total_tokens: 1198, prompt_tokens_details: { cached_tokens: 0 } }))

    await chat()
    const usage = (await ops('usage')).json

    expect(usage.today).toMatchObject({ requests: 1, settled: 1, inputTokens: 585, outputTokens: 613, thinkingTokens: 581, cachedTokens: 0 })
    expect(usage.today.costUsd).toBeCloseTo(0.0027375, 9)
    expect(usage.byModel).toEqual([expect.objectContaining({ model: 'gemini-3.8-flash', effort: 'medium', requests: 1 })])
    expect(usage.recent[0]).toMatchObject({ model: 'gemini-3.8-flash', effort: 'medium', effortSource: 'selection', status: 'settled', thinkingTokens: 581 })
    expect(usage.basis).toContain('not an invoice')
    expect(usage.timeZone).toBe('America/Los_Angeles')
  })

  it('records missing usage as unknown with a conservative estimate, and HTTP errors as failed', async () => {
    await start(raw({}, ['gemini-flash-lite-31']))
    gemini.setHandler(answers())
    await chat()
    gemini.setHandler(fails(429))
    await chat()

    const usage = (await ops('usage')).json

    expect(usage.today).toMatchObject({ requests: 3, settled: 0, unknown: 1 })
    expect(usage.today.failed).toBe(2)
    expect(usage.today.unknownEstimateUsd).toBeGreaterThan(0)
    expect(usage.recent.at(-1)).toMatchObject({ status: 'unknown', error: 'usage-missing' })
  })

  it('applies a spending limit only after the user sets one, then falls back to a non-Gemini model', async () => {
    await start(raw())
    gemini.setHandler(answers({ prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 }))
    other.setHandler(answers())
    await chat()

    const controls = await ops('usage/controls', { dailyLimitUsd: 0.000001, monthlyWarningUsd: 10 })
    const { response } = await chat()
    const usage = (await ops('usage')).json

    expect(controls.json.controls).toEqual({ dailyWarningUsd: null, monthlyWarningUsd: 10, dailyLimitUsd: 0.000001, monthlyLimitUsd: null })
    expect(response.headers.get('x-companion-model')).toBe('other-model')
    expect(response.headers.get('x-companion-skipped')).toContain('SPENDING_LIMIT')
    expect(usage.alerts).toMatchObject({ dailyLimit: true, monthlyWarning: false })
  })

  it('answers 429 when only Gemini models remain under a reached limit', async () => {
    await start(raw({}, ['gemini-flash-lite-31']))
    gemini.setHandler(answers({ prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 }))
    await chat()
    await ops('usage/controls', { monthlyLimitUsd: 0 })

    const { response, text } = await chat()

    expect(response.status).toBe(429)
    expect(text).toContain('spending_limit_reached')
  })

  it('never puts keys or tokens into Ops replies or logs', async () => {
    await start(raw())
    gemini.setHandler(answers({ prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }))
    await chat()

    const replies = JSON.stringify([(await ops('models')).json, (await ops('usage')).json, (await ops('status')).json])

    for (const secret of [TEST_PROVIDER_KEY, TEST_INFERENCE_TOKEN, TEST_OPS_TOKEN]) {
      expect(replies).not.toContain(secret)
      expect(logs.join('\n')).not.toContain(secret)
    }
  })
})

describe('model discovery and cloud suspension', () => {
  it('stores which catalog ids the key can list, and refuses a missing model', async () => {
    await start(raw())
    gemini.setHandler((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'models/gemini-3.8-flash' }, { id: 'models/gemini-3.6-flash' }] }))
        return
      }
      fails(500)(req, res, undefined as never)
    })

    const discovered = await ops('models/discover', {})
    const missing = await ops('models/select', { model: 'gemini-3.5-flash', effort: 'low' })

    expect(discovered.json.discovery).toMatchObject({ ok: true, found: ['gemini-3.6-flash', 'gemini-3.8-flash'] })
    expect(gemini.requests[0].headers.authorization).toBe(`Bearer ${TEST_PROVIDER_KEY}`)
    expect(missing.status).toBe(409)
    expect(missing.json.error.code).toBe('model_not_available')
    expect(JSON.stringify(discovered.json)).not.toContain(TEST_PROVIDER_KEY)
  })

  it('suspends every cloud model until Ops resumes it, across a restart', async () => {
    const store = fileStore()
    await start(raw({ store }))
    gemini.setHandler(answers())

    await ops('cloud', { suspended: true })
    await gateway!.close()
    await start(raw({ store }))
    const suspended = await chat()
    await ops('cloud', { suspended: false })
    const resumed = await chat()

    expect(suspended.response.status).toBe(503)
    expect(suspended.text).toContain('cloud_suspended')
    expect(resumed.response.status).toBe(200)
  })
})
