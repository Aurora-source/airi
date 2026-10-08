import type { Price } from '../eval/gemini/accounting'

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { costNano, parseUsage, SpendLedger } from '../eval/gemini/accounting'
import { clockContinuation } from '../eval/gemini/capabilities'
import { DIALOGUES, fingerprint, history, PRICES, SYSTEM } from '../eval/gemini/corpus'
import { airiEnvelope } from '../eval/gemini/envelope'
import { measureFixtures } from '../eval/gemini/fixtures'
import { projectMonthly } from '../eval/gemini/monthly'
import { PRICE_VALID_UNTIL, sourceDigest, validatePreflight } from '../eval/gemini/preflight'
import { discover, StreamMeter, summarize } from '../eval/gemini/protocol'
import { aggregate, worksheet } from '../eval/gemini/report'
import { Benchmark, configuration } from '../eval/gemini/runner'
import { replayVoiceText } from '../eval/gemini/voice'
import { startFakeProvider, writeEvents } from './support/harness'

const price: Price = { input: 0.25, cached: 0.025, output: 1.5 }
const directories: string[] = []
const ledgers: SpendLedger[] = []

function open(ceiling = 4_500_000_000, concurrency = 2) {
  const directory = mkdtempSync(join(tmpdir(), 'gemini-guard-'))
  directories.push(directory)
  const path = join(directory, 'ledger.json')
  const ledger = new SpendLedger(path, ceiling, concurrency)
  ledgers.push(ledger)
  return { ledger, path }
}

afterEach(() => {
  for (const ledger of ledgers.splice(0))
    ledger.close()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('model discovery and streaming measurements', () => {
  it('measures cancellation at the upstream peer and cloud failover with zero paid requests', async () => {
    const result = await measureFixtures(1)
    expect(result.paidCalls).toBe(0)
    expect(result.cancellation[0].peerClosed).toBe(true)
    expect(result.cancellation[0].abortToPeerCloseMs).toBeLessThan(2000)
    expect(result.failover[0].status).toBe(200)
    expect(result.failover[0].attempts).toEqual(['first=server', 'second=ok'])
    expect(result.failover[0].servedBy).toBe('second')
  })
  it('prices monthly tool continuations and the STT ten-second minimum separately', () => {
    const light = projectMonthly('gemini-3.8-flash', { visible: 60, thinking: 0, n: 18 })[0]
    expect(light.low.chatTurns).toBe(900)
    expect(light.low.toolContinuations).toBe(90)
    expect(light.low.chatUsd).toBeCloseTo(2.45025)
    expect(light.low.sttUsd).toBeCloseTo(0.07)
    expect(light.high.totalUsd).toBeGreaterThan(light.low.totalUsd)
  })
  it('applies future Flash prices to inference without doubling local TTS or STT costs', () => {
    const current = projectMonthly('gemini-3.8-flash', { visible: 60, thinking: 0, n: 18 })[0].low
    const future = projectMonthly('gemini-3.8-flash', { visible: 60, thinking: 0, n: 18 }, 2)[0].low
    expect(future.chatUsd).toBe(current.chatUsd * 2)
    expect(future.sttUsd).toBe(current.sttUsd)
    expect(future.localTtsUsd).toBe(0)
  })
  it('loads the actual AIRI tool-schema fixture with synthetic history and no tool execution', () => {
    const envelope = airiEnvelope()
    expect(envelope.tools).toHaveLength(5)
    expect(JSON.stringify(envelope.tools)).toContain('builtIn_mcpCallTool')
    expect(envelope.messages.at(-1)?.content).toContain('making tea together')
    expect(envelope.messages[0].content).toContain('native API tool_calls')
    expect(envelope.messages.length).toBeGreaterThan(10)
  })
  it('keeps API tool signatures and supplies only validated synthetic clock results', () => {
    const messages = [{ role: 'user', content: 'Read the synthetic clock.' }]
    const call = { id: 'call-clock', type: 'function', function: { name: 'synthetic_clock', arguments: '{"location":"Kyoto"}' }, extra_content: { google: { thought_signature: 'synthetic-signature' } } }
    const result = clockContinuation(messages, { text: '', calls: [call] })
    expect(result?.at(-2)?.tool_calls).toEqual([call])
    expect(result?.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call-clock', content: '{"location":"Kyoto","time":"19:30","source":"synthetic"}' })
  })
  it('records stage CALL markers as a failed API invocation without a fabricated continuation', () => {
    expect(clockContinuation([], { text: '<|CALL ["synthetic_clock", {"location":"Kyoto"}]|>', calls: [] })).toBeUndefined()
    expect(clockContinuation([], { text: '', calls: [{ id: 'wrong', function: { name: 'delete_all_memories', arguments: '{}' } }] })).toBeUndefined()
    expect(clockContinuation([], { text: '', calls: [{ id: 'clock', function: { name: 'synthetic_clock', arguments: '{invalid' } }] })).toBeUndefined()
    expect(clockContinuation([], { text: '', calls: [{ id: 'clock', function: { name: 'synthetic_clock', arguments: '{"location":"Osaka"}' } }] })).toBeUndefined()
  })
  it('replays real upstream TTS chunk readiness separately from audible latency', async () => {
    const result = await replayVoiceText([{ atMs: 10, text: '<|ACT {"emotion":{"name":"happy","intensity":0.8}}' }, { atMs: 20, text: '|> One two three four, next sentence.' }], 30)
    expect(result.firstChunkAtMs).toBe(20)
    expect(result.chunks.join(' ')).toContain('One two three four')
    expect(result.chunks.join(' ')).not.toContain('ACT')
    const malformed = await replayVoiceText([{ atMs: 10, text: '<|ACT broken One two three four.' }], 20)
    expect(malformed.firstChunkAtMs).toBeUndefined()
  })
  it('paginates model metadata without inference and retains exact API IDs', async () => {
    const urls: string[] = []
    const transport: typeof fetch = async (url) => {
      urls.push(String(url))
      return Response.json(urls.length === 1
        ? { models: [{ name: 'models/gemini-test', inputTokenLimit: 100, outputTokenLimit: 20, supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'page-two' }
        : { models: [{ name: 'models/gemini-other', inputTokenLimit: 200, outputTokenLimit: 30, supportedGenerationMethods: ['generateContent'] }] })
    }
    const models = await discover('synthetic-key', transport)
    expect(models.map(model => model.name)).toEqual(['models/gemini-test', 'models/gemini-other'])
    expect(urls[1]).toContain('pageToken=page-two')
    expect(urls.some(url => url.includes('synthetic-key'))).toBe(false)
    expect(urls.some(url => url.includes('generateContent'))).toBe(false)
  })

  it('rejects model-list network failure and malformed metadata', async () => {
    await expect(discover('synthetic-key', async () => new Response('', { status: 403 }))).rejects.toThrow(/403/)
    await expect(discover('synthetic-key', async () => Response.json({ models: [{ name: 'wrong' }] }))).rejects.toThrow()
  })

  it('separates raw first byte, ACT completion, meaningful text, and sentence timing', () => {
    const meter = new StreamMeter()
    const encode = (text: string) => new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`)
    meter.push(encode('<|ACT {"emotion":"happy"'), 10)
    meter.push(encode('}|> '), 20)
    meter.push(encode('Hi'), 30)
    meter.push(encode(' there.'), 40)
    meter.push(new TextEncoder().encode('data: {"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3},"choices":[]}\n\ndata: [DONE]\n\n'), 50)
    const result = meter.finish(60)
    expect(result.firstByteMs).toBe(10)
    expect(result.firstTextMs).toBe(30)
    expect(result.firstSentenceMs).toBe(40)
    expect(result.totalMs).toBe(60)
    expect(result.done).toBe(true)
    expect(result.usage?.output).toBe(2)
  })

  it('assembles index-less tool fragments and preserves thought signatures', () => {
    const meter = new StreamMeter()
    for (const [i, call] of [{ id: 'call-1', function: { name: 'weather', arguments: '{"city":' }, extra_content: { google: { thought_signature: 'synthetic-signature' } } }, { function: { arguments: '"Kyoto"}' } }].entries())
      meter.push(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}\n\n`), 10 + i)
    const result = meter.finish(20)
    expect(result.firstToolMs).toBe(10)
    expect(result.missingIndices).toBe(2)
    expect(result.calls[0].function?.arguments).toBe('{"city":"Kyoto"}')
    expect(result.calls[0].extra_content).toEqual({ google: { thought_signature: 'synthetic-signature' } })
  })

  it('handles UTF-8 and SSE split boundaries without counting reasoning as speech', () => {
    const meter = new StreamMeter()
    const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"日本語。"}}]}\r\n\r\n')
    for (const [i, byte] of bytes.entries())
      meter.push(Uint8Array.of(byte), i)
    const result = meter.finish(bytes.length)
    expect(result.text).toBe('日本語。')
    expect(result.reasoningChannel).toBe(true)
    expect(result.firstTextMs).toBeGreaterThan(60)
    expect(result.done).toBe(false)
  })

  it('distinguishes empty and interrupted streams and rejects malformed events', () => {
    expect(new StreamMeter().finish(10).done).toBe(false)
    const meter = new StreamMeter()
    expect(() => meter.push(new TextEncoder().encode('data: broken-json\n\n'), 1)).toThrow()
  })

  it('never treats preliminary usage as final after later generated content', () => {
    const meter = new StreamMeter()
    meter.push(new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":0,"total_tokens":1}}\n\ndata: {"choices":[{"delta":{"content":"Hi."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'), 10)
    expect(meter.finish(20).usage).toBeUndefined()
  })

  it('rejects decreasing usage instead of releasing the larger charge', () => {
    const meter = new StreamMeter()
    meter.push(new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}\n\n'), 10)
    expect(() => meter.push(new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n'), 20)).toThrow(/usage/i)
  })

  it('reports empirical quantiles with sample counts and suppresses tiny-sample p95', () => {
    expect(summarize([3, 1, 2])).toMatchObject({ n: 3, min: 1, max: 3, mean: 2, p50: 2, p90: undefined, p95: undefined })
    expect(summarize(Array.from({ length: 20 }, (_, i) => i + 1))).toMatchObject({ n: 20, p50: 10.5, p90: 18.1, p95: 19.05 })
    expect(() => summarize([])).toThrow()
    expect(() => summarize([Number.NaN])).toThrow()
  })
})

describe('paid benchmark monetary accounting', () => {
  it('prices cached input once and includes thinking inside completion totals', () => {
    expect(costNano(price, { input: 1000, cached: 400, output: 200, thinking: 80 })).toBe(460_000)
  })

  it('selects the high tier from total prompt size including cached tokens', () => {
    const tiered = { ...price, threshold: 200_000, above: { input: 2.5, cached: 0.25, output: 15 } }
    expect(costNano(tiered, { input: 200_000, cached: 0, output: 0, thinking: 0 })).toBe(50_000_000)
    expect(costNano(tiered, { input: 200_001, cached: 200_000, output: 1, thinking: 1 })).toBe(50_017_500)
  })

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid token count %s', (input) => {
    expect(() => costNano(price, { input, cached: 0, output: 1, thinking: 0 })).toThrow()
  })

  it('rejects negative rates and inconsistent billable categories', () => {
    expect(() => costNano({ ...price, input: -1 }, { input: 1, cached: 0, output: 1, thinking: 0 })).toThrow()
    expect(() => costNano(price, { input: 1, cached: 2, output: 1, thinking: 0 })).toThrow()
    expect(() => costNano(price, { input: 1, cached: 0, output: 1, thinking: 2 })).toThrow()
  })

  it('validates compatibility usage and preserves reported cached and thinking fields', () => {
    expect(parseUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 8 } })).toEqual({ input: 10, cached: 3, output: 20, thinking: 8 })
  })

  it.each([undefined, {}, { prompt_tokens: 1 }, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 2 }, { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 }])('rejects unknown or inconsistent usage', (value) => {
    expect(() => parseUsage(value)).toThrow()
  })

  it('accounts Gemini thinking from the reported total when completion excludes it', () => {
    expect(parseUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 38 })).toEqual({ input: 10, cached: 0, output: 28, thinking: 8 })
    expect(() => parseUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 38, completion_tokens_details: { reasoning_tokens: 3 } })).toThrow(/inconsistent/i)
  })

  it('rejects unaccounted audio, tool, or image-output token categories', () => {
    expect(() => parseUsage({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, completion_tokens_details: { audio_tokens: 1 } })).toThrow()
  })
})

describe('durable spend guard', () => {
  it('reserves before dispatch and settles reported consumption', () => {
    const { ledger, path } = open()
    ledger.reserve('one', 'candidate', price, 1000, 1000)
    expect(ledger.snapshot().exposureNano).toBe(1_750_000)
    expect(readFileSync(path, 'utf8')).toContain('reserved')
    ledger.settle('one', { input: 100, cached: 0, output: 100, thinking: 0 })
    expect(ledger.snapshot().spentNano).toBe(175_000)
    expect(ledger.snapshot().exposureNano).toBe(175_000)
  })

  it('rejects a request that reaches the target ceiling', () => {
    const { ledger } = open(1_750_000)
    expect(() => ledger.reserve('one', 'candidate', price, 1000, 1000)).toThrow(/budget/i)
    expect(ledger.snapshot().exposureNano).toBe(0)
  })

  it('includes all in-flight reservations and limits concurrency', () => {
    const { ledger } = open(4_000_000, 2)
    ledger.reserve('one', 'candidate', price, 1000, 1000)
    ledger.reserve('two', 'candidate', price, 1000, 1000)
    expect(ledger.snapshot().exposureNano).toBe(3_500_000)
    expect(() => ledger.reserve('three', 'candidate', price, 1, 1)).toThrow(/concurrency/i)
  })

  it('retains charges and halts after cancellation, network failure, or missing usage', () => {
    const { ledger } = open()
    ledger.reserve('one', 'candidate', price, 1000, 1000)
    ledger.settle('one', undefined)
    expect(ledger.snapshot().halted).toBe(true)
    expect(ledger.snapshot().exposureNano).toBe(1_750_000)
    expect(() => ledger.reserve('two', 'candidate', price, 1, 1)).toThrow(/unknown|halt/i)
  })

  it('retains conservative exposure when actual usage exceeds its reservation', () => {
    const { ledger } = open()
    ledger.reserve('one', 'candidate', price, 1, 1)
    expect(() => ledger.settle('one', { input: 100, cached: 0, output: 100, thinking: 0 })).toThrow(/reservation/i)
    expect(ledger.snapshot().halted).toBe(true)
    expect(ledger.snapshot().exposureNano).toBeGreaterThanOrEqual(175_000)
  })

  it('refuses a second process owner and duplicate reservations', () => {
    const { ledger, path } = open()
    expect(() => new SpendLedger(path)).toThrow(/lock|owner/i)
    ledger.reserve('one', 'candidate', price, 1, 1)
    expect(() => ledger.reserve('one', 'candidate', price, 1, 1)).toThrow(/duplicate/i)
  })

  it('halts on an unresolved reservation after restart', () => {
    const { ledger, path } = open()
    ledger.reserve('one', 'candidate', price, 1, 1)
    ledger.close()
    const restarted = new SpendLedger(path)
    ledgers.push(restarted)
    expect(restarted.snapshot().halted).toBe(true)
    expect(() => restarted.reserve('two', 'candidate', price, 1, 1)).toThrow()
  })

  it('preserves settled costs after restart and refuses unsafe limits', () => {
    const { ledger, path } = open()
    ledger.reserve('one', 'candidate', price, 1000, 1000)
    ledger.settle('one', { input: 100, cached: 0, output: 100, thinking: 0 })
    ledger.close()
    const restarted = new SpendLedger(path)
    ledgers.push(restarted)
    expect(restarted.snapshot().spentNano).toBe(175_000)
    expect(() => new SpendLedger(`${path}-unsafe`, 5_000_000_001)).toThrow()
  })

  it('halts after persistence failure and retains the unissued reservation', () => {
    const { ledger, path } = open()
    mkdirSync(`${path}.pending`)
    expect(() => ledger.reserve('one', 'candidate', price, 1000, 1000)).toThrow()
    expect(ledger.snapshot().halted).toBe(true)
    expect(() => ledger.reserve('two', 'candidate', price, 1, 1)).toThrow(/halt|unknown/i)
  })

  it.each(['missing', 'inconsistent', 'duplicate'])('rejects %s settled ledger data on reopen', (fault) => {
    const { ledger, path } = open()
    ledger.reserve('one', 'candidate', price, 1000, 1000)
    ledger.settle('one', { input: 100, cached: 0, output: 100, thinking: 0 })
    ledger.close()
    const stored = JSON.parse(readFileSync(path, 'utf8'))
    if (fault === 'missing')
      delete stored.entries[0].costNano
    if (fault === 'inconsistent')
      stored.entries[0].costNano = 0
    if (fault === 'duplicate')
      stored.entries.push(stored.entries[0])
    writeFileSync(path, JSON.stringify(stored))
    expect(() => new SpendLedger(path)).toThrow(/ledger/i)
  })
})

describe('guarded benchmark reproducibility and Gateway path', () => {
  const models = [{ name: 'models/gemini-3.5-flash-lite', inputTokenLimit: 1_048_576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] }]

  it('requires fresh matching discovery, pricing, and source receipts before paid execution', () => {
    const capturedAt = '2026-10-08T18:00:00.000Z'
    const now = Date.parse(capturedAt)
    const discovery = { capturedAt, projectId: 'gen-lang-client-0341576079', projectNumber: '825264326503', projectSource: 'user-confirmed', inferenceCalls: 0, models }
    const receipt = { schemaVersion: 1, capturedAt, sourceSha256: sourceDigest(), discoverySha256: fingerprint(discovery), pricesSha256: fingerprint(PRICES), testsPassed: 42, paidCalls: 0, ceilingUsd: 4.5, concurrency: 2, priceValidUntil: PRICE_VALID_UNTIL }
    expect(validatePreflight(receipt, discovery, now)).toEqual(models)
    expect(() => validatePreflight({ ...receipt, sourceSha256: 'changed' }, discovery, now)).toThrow(/fingerprint/i)
    expect(() => validatePreflight(receipt, { ...discovery, models: [] }, now)).toThrow(/fingerprint/i)
    expect(() => validatePreflight(receipt, discovery, now + 25 * 3600_000)).toThrow(/stale/i)
    expect(() => validatePreflight(receipt, discovery, Date.parse(PRICE_VALID_UNTIL))).toThrow()
  })

  it('propagates cancellation to the transport and stops with retained spending exposure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gemini-runner-'))
    directories.push(directory)
    const bench = new Benchmark(directory, 'synthetic-key', models)
    const controller = new AbortController()
    try {
      const request = bench.request({ model: 'gemini-3.5-flash-lite', path: 'direct', scenario: 'fixture-cancellation', body: { model: 'gemini-3.5-flash-lite', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 128 }, signal: controller.signal, transport: async (_url, options) => {
        controller.abort()
        expect(options?.signal?.aborted).toBe(true)
        throw new Error('synthetic abort')
      } })
      await expect(request).rejects.toThrow()
      expect(bench.ledger.snapshot()).toMatchObject({ halted: true, spentNano: 0 })
      const sample = JSON.parse(readFileSync(join(directory, 'samples.ndjson'), 'utf8'))
      expect(sample.error).toBe('cancelled')
    }
    finally {
      await bench.close()
    }
  })

  it('uses source baseline limits and fresh paid capacities without a local model', () => {
    const baseline = configuration(models, false)
    const paid = configuration(models, true)
    expect(baseline.models['gemini-3.5-flash-lite'].limits).toMatchObject({ rpm: 15, rpd: 500, tpm: 250_000 })
    expect(paid.models['gemini-3.5-flash-lite'].capabilities.maxOutput).toBe(65536)
    expect(paid.models['gemini-3.5-flash-lite'].limits.rpd).toBeUndefined()
    expect(paid.profile).toBe('cloud')
    expect(paid.store.path).toBe(':memory:')
    expect(paid.perception.enabled).toBe(false)
    expect(paid.watch.enabled).toBe(false)
    expect(Object.values(paid.providers).every(provider => provider.locality === 'cloud')).toBe(true)
  })

  it('reproduces synthetic prompts and covers all six multi-turn sequences', () => {
    expect(fingerprint(history(4000))).toBe(fingerprint(history(4000)))
    expect(fingerprint(history(4000))).not.toBe(fingerprint(history(8000)))
    expect(DIALOGUES.flatMap(dialogue => dialogue.turns)).toHaveLength(18)
    expect(SYSTEM).toContain('Mura')
    expect(SYSTEM).toContain('ACT')
  })

  it('reserves before a direct network call and halts on missing usage', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gemini-runner-'))
    directories.push(directory)
    const bench = new Benchmark(directory, 'synthetic-key', models)
    try {
      await expect(bench.request({ model: 'gemini-3.5-flash-lite', path: 'direct', scenario: 'fixture-network-error', body: { model: 'gemini-3.5-flash-lite', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 128, stream: true }, transport: async () => {
        expect(bench.ledger.snapshot().exposureNano).toBeGreaterThan(0)
        throw new Error('synthetic network failure')
      } })).rejects.toThrow()
      expect(bench.ledger.snapshot().halted).toBe(true)
    }
    finally {
      await bench.close()
    }
  })

  it('rejects alternate generation limits before any provider dispatch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gemini-runner-'))
    directories.push(directory)
    const bench = new Benchmark(directory, 'synthetic-key', models)
    let dispatched = false
    try {
      const request = {
        model: 'gemini-3.5-flash-lite',
        path: 'direct' as const,
        scenario: 'fixture-unsafe-limit',
        body: { model: 'gemini-3.5-flash-lite', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 128, max_completion_tokens: 8192 },
        transport: async () => {
          dispatched = true
          return new Response('')
        },
      }
      await expect(bench.request(request)).rejects.toThrow(/unsupported|override|limit/i)
      expect(dispatched).toBe(false)
      expect(bench.ledger.snapshot().exposureNano).toBe(0)
    }
    finally {
      await bench.close()
    }
  })

  it('accounts reported usage from a failed HTTP response without retrying', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gemini-runner-'))
    directories.push(directory)
    const bench = new Benchmark(directory, 'synthetic-key', models)
    try {
      await expect(bench.request({ model: 'gemini-3.5-flash-lite', path: 'direct', scenario: 'fixture-http-error', body: { model: 'gemini-3.5-flash-lite', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 128 }, transport: async () => Response.json({ error: { message: 'synthetic' }, usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }, { status: 500 }) })).rejects.toThrow()
      expect(bench.ledger.snapshot()).toMatchObject({ spentNano: 53_000, exposureNano: 53_000, halted: false })
    }
    finally {
      await bench.close()
    }
  })

  it('retains both reservations when concurrent Gateway routes cannot identify failed usage', async () => {
    const provider = await startFakeProvider()
    let entered!: () => void
    let release!: () => void
    const received = new Promise<void>(resolve => entered = resolve)
    const held = new Promise<void>(resolve => release = resolve)
    provider.setHandler(async (_req, res) => {
      entered()
      await held
      res.writeHead(500)
      res.end('{}')
    })
    const directory = mkdtempSync(join(tmpdir(), 'gemini-runner-'))
    directories.push(directory)
    const bench = new Benchmark(directory, 'synthetic-key', models, provider.baseURL)
    try {
      const first = bench.request({ model: 'gemini-3.5-flash-lite', path: 'gateway-paid', scenario: 'fixture-concurrent-first', body: { model: 'gemini-3.5-flash-lite', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 128 } }).catch(() => undefined)
      await received
      await expect(bench.request({ model: 'gemini-3.5-flash-lite', path: 'gateway-paid', scenario: 'fixture-concurrent-rejection', body: { model: 'gemini-3.5-flash-lite', messages: [{ role: 'system', content: 'synthetic '.repeat(200_000) }, { role: 'user', content: 'Hello' }], max_tokens: 128 } })).rejects.toThrow()
      release()
      await first
      expect(provider.requests).toHaveLength(1)
      expect(bench.ledger.snapshot().halted).toBe(true)
      expect(bench.ledger.snapshot().exposureNano).toBeGreaterThan(600_000_000)
    }
    finally {
      release()
      await bench.close()
      await provider.close()
    }
  })

  it('reads a real existing Gateway stream with Gemini repair and usage accounting', async () => {
    const provider = await startFakeProvider()
    provider.setHandler(async (_req, res) => writeEvents(res, [
      'data: {"choices":[{"index":0,"delta":{"content":"<|ACT {\\"emotion\\":\\"happy\\"}|> Hi there."}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}\n\n',
      'data: [DONE]\n\n',
    ], 2))
    const directory = mkdtempSync(join(tmpdir(), 'gemini-runner-'))
    directories.push(directory)
    const bench = new Benchmark(directory, 'synthetic-key', models, provider.baseURL)
    try {
      const sample = await bench.request({ model: 'gemini-3.5-flash-lite', path: 'gateway-paid', scenario: 'fixture-gateway', body: { model: 'gemini-3.5-flash-lite', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 128, stream: true } })
      expect(sample.status).toBe(200)
      expect(sample.firstTextMs).toBeGreaterThanOrEqual(sample.firstByteMs!)
      expect(sample.done).toBe(true)
      expect(sample.costNano).toBe(53_000)
      expect(sample.providerSelectionAndBudgetMs).toBeGreaterThanOrEqual(0)
      expect(sample.contextAssemblyMs).toBeGreaterThanOrEqual(0)
      expect(provider.requests).toHaveLength(1)
      expect(provider.requests[0].body).toContain('gemini-3.5-flash-lite')
      expect(aggregate([sample])).toMatchObject({ sampleCount: 1, knownCostUsd: 0.000053, latency: [] })
      expect(aggregate([{ ...sample, scenario: 'latency', usage: undefined, costNano: undefined }])).toMatchObject({ unknownUsageSamples: 1, latency: [] })
      expect(configuration(models, true, provider.baseURL, true).models['gemini-3.5-flash-lite'].styleReminder).toContain('exactly')
      const blind = worksheet([{ ...sample, scenario: 'persona/casual-humor/0' }])
      expect(blind.markdown).toContain('Hi there.')
      expect(blind.markdown).toContain('quiet evening')
      expect(blind.markdown).not.toContain('gemini-3.5-flash-lite')
      expect(blind.key).toBeTruthy()
    }
    finally {
      await bench.close()
      await provider.close()
    }
  })
})
