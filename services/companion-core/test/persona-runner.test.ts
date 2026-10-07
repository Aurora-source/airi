import type { ResultRow } from '../eval/persona/runner'
import type { RunningGateway } from '../src'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { GatewayClient, parseStream } from '../eval/persona/client'
import { buildSystemPrompt } from '../eval/persona/prompt'
import { runModel, runScenario } from '../eval/persona/runner'
import { SCENARIOS } from '../eval/persona/scenarios'
import { sse, startFakeProvider, startRoutedGateway, TEST_INFERENCE_TOKEN, writeEvents } from './support/harness'

let provider: Awaited<ReturnType<typeof startFakeProvider>>
let gateway: RunningGateway
let client: GatewayClient

const SYSTEM = buildSystemPrompt()
const scene = (id: string) => SCENARIOS.find(scenario => scenario.id === id)!

beforeAll(async () => {
  provider = await startFakeProvider()
})

beforeEach(async () => {
  ;({ gateway } = await startRoutedGateway({
    providers: { fake: { baseURL: provider.baseURL, keyRef: 'key-fake' } },
    models: { 'fake-model': { provider: 'fake', model: 'real-1', capabilities: { contextWindow: 100_000 } } },
    aliases: { 'companion-eval': { chain: ['fake-model'] } },
  }))
  client = new GatewayClient({ baseURL: gateway.baseURL.replace('v1/', ''), token: TEST_INFERENCE_TOKEN })
})

afterEach(async () => {
  await gateway.close()
  provider.requests.length = 0
})

afterAll(async () => {
  await provider.close()
})

const hasToolResult = (body: string) => JSON.parse(body).messages.some((message: { role: string }) => message.role === 'tool')

function replies(text: string) {
  return (_req: unknown, res: Parameters<typeof writeEvents>[0]) => void writeEvents(res, [
    sse({ choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 20 } }),
    sse('[DONE]'),
  ])
}

describe('runScenario', () => {
  it('records a plain answer with its timing, usage, checks, and the model that served it', async () => {
    provider.setHandler(replies('<|ACT {"emotion":"happy"}|> Welcome back! I was getting bored without you~'))

    const row = await runScenario(client, 'companion-eval:fake-model', 'fake-model', scene('casual-1'), SYSTEM)

    expect(row.record.text).toContain('Welcome back')
    expect(row.record.status).toBe(200)
    expect(row.record.firstByteMs).toBeGreaterThanOrEqual(0)
    expect(row.usage).toEqual({ promptTokens: 900, completionTokens: 20 })
    expect(row.servedBy).toBe('fake-model')
    expect(row.checks.every(check => check.pass)).toBe(true)
  })

  it('sends the persona prompt, the history, the injected context, and the user message in AIRI\'s order', async () => {
    provider.setHandler(replies('<|ACT {"emotion":"happy"}|> Mochi again?! That cat has a vendetta against your desk!'))

    await runScenario(client, 'companion-eval:fake-model', 'fake-model', scene('memory-2'), SYSTEM)

    const sent = JSON.parse(provider.requests[0].body).messages as { role: string, content: string }[]
    expect(sent.map(message => message.role)).toEqual(['system', 'user', 'user'])
    expect(sent[0].content).toContain('Your name is AIRI')
    expect(sent[1].content).toContain('Mochi')
    expect(sent[2].content).toContain('coffee')
    expect(JSON.parse(provider.requests[0].body).tools).toHaveLength(3)
  })

  it('runs both rounds of a tool scene and gives the model the mock result and its own call back', async () => {
    provider.setHandler((_req, res, received) => {
      if (hasToolResult(received.body)) {
        replies('<|ACT {"emotion":"happy"}|> It is 21 degrees and clear in Osaka, perfect for a walk!')(_req, res)
        return
      }
      void writeEvents(res, [
        sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', extra_content: { google: { thought_signature: 'sig-1' } }, function: { name: 'get_weather', arguments: '{"location":' } }] } }] }),
        sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Osaka"}' } }] } }] }),
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        sse('[DONE]'),
      ])
    })

    const row = await runScenario(client, 'companion-eval:fake-model', 'fake-model', scene('tool-1'), SYSTEM)

    expect(row.record.toolCalls).toEqual([{ name: 'get_weather', arguments: '{"location":"Osaka"}' }])
    expect(row.record.text).toContain('21 degrees')
    expect(row.checks.find(check => check.id === 'tool-behavior')?.pass).toBe(true)
    const second = JSON.parse(provider.requests[1].body).messages as { role: string, content?: string, tool_calls?: { id: string, extra_content?: unknown }[], tool_call_id?: string }[]
    expect(second.at(-2)?.tool_calls?.[0]).toMatchObject({ id: 'call_1', extra_content: { google: { thought_signature: 'sig-1' } } })
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: '21 degrees Celsius, clear sky' })
  })

  it('fails the tool check of a scene that needed no tool when the model calls one', async () => {
    provider.setHandler((_req, res) => void writeEvents(res, [
      sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'get_weather', arguments: '{"location":"Osaka"}' } }] } }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      sse('[DONE]'),
    ]))

    const row = await runScenario(client, 'companion-eval:fake-model', 'fake-model', scene('casual-1'), SYSTEM)

    expect(row.checks.find(check => check.id === 'tool-behavior')?.pass).toBe(false)
  })

  it('waits out a rate limit and tries again, without counting the wait in the answer time', async () => {
    let first = true
    provider.setHandler((_req, res) => {
      if (first) {
        first = false
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
        res.end('{"error":{"message":"slow down"}}')
        return
      }
      replies('<|ACT {"emotion":"happy"}|> Welcome back! I was getting bored without you~')(_req, res)
    })

    const row = await runScenario(client, 'companion-eval:fake-model', 'fake-model', scene('casual-1'), SYSTEM)

    expect(row.record.status).toBe(200)
    expect(row.waitedMs).toBeGreaterThanOrEqual(1000)
    expect(row.record.totalMs).toBeLessThan(row.waitedMs)
  }, 20_000)

  it('does not wait for a limit that lasts hours, such as a daily quota, and records the 429 at once', async () => {
    provider.setHandler((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '14400' })
      res.end('{"error":{"message":"daily quota"}}')
    })
    const started = performance.now()

    const row = await runScenario(client, 'companion-eval:fake-model', 'fake-model', scene('casual-1'), SYSTEM)

    expect(row.record.status).toBe(429)
    expect(row.waitedMs).toBe(0)
    expect(performance.now() - started).toBeLessThan(3000)
  })

  it('records a final failure and goes on, such as a request that no wait can fix', async () => {
    provider.setHandler((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"bad request"}}')
    })

    const row = await runScenario(client, 'companion-eval:fake-model', 'fake-model', scene('casual-1'), SYSTEM)

    expect(row.record.status).toBe(400)
    expect(row.record.error).toContain('bad request')
    expect(row.checks.find(check => check.id === 'act-valid')?.pass).toBe(false)
  })
})

describe('runModel', () => {
  it('skips the scenes that a resumed run already has', async () => {
    provider.setHandler(replies('<|ACT {"emotion":"happy"}|> Welcome back! I was getting bored without you~'))
    const rows: ResultRow[] = []

    await runModel({
      client,
      alias: 'companion-eval',
      modelId: 'fake-model',
      scenarios: [scene('casual-1'), scene('casual-3')],
      systemPrompt: SYSTEM,
      done: new Set(['casual-1|fake-model']),
      onRow: row => rows.push(row),
    })

    expect(rows.map(row => row.scenarioId)).toEqual(['casual-3'])
  })
})

describe('parseStream', () => {
  it('flags a reasoning channel and keeps text and usage', () => {
    const parsed = parseStream([
      sse({ choices: [{ delta: { reasoning: 'thinking about it' } }] }),
      sse({ choices: [{ delta: { content: 'Hi!' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    ].join(''))

    expect(parsed).toMatchObject({ text: 'Hi!', reasoningChannel: true, finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 2 } })
  })

  it('assembles parallel tool calls that arrive without an index, one per id', () => {
    const parsed = parseStream([
      sse({ choices: [{ delta: { tool_calls: [{ id: 'a', function: { name: 'f', arguments: '{"x":' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ function: { arguments: '1}' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ id: 'b', function: { name: 'g', arguments: '{}' } }] } }] }),
    ].join(''))

    expect(parsed.toolCalls).toEqual([{ id: 'a', name: 'f', arguments: '{"x":1}' }, { id: 'b', name: 'g', arguments: '{}' }])
  })
})
