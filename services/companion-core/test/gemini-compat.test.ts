import type { RunningGateway } from '../src'

import { Buffer } from 'node:buffer'

import { streamText } from '@xsai/stream-text'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createGeminiToolCallIndexer } from '../src/providers/gemini-compat'
import { authHeaders, readChunks, sse, startFakeProvider, startTestGateway, TEST_INFERENCE_TOKEN } from './support/harness'

/** Runs text through the indexer, split into chunks of `size` bytes, and returns the output text. */
async function repair(text: string, size = Number.POSITIVE_INFINITY): Promise<string> {
  const bytes = Buffer.from(text, 'utf8')
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += Math.min(size, bytes.length))
        controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + size)))
      controller.close()
    },
  })
  const parts: Buffer[] = []
  for await (const chunk of input.pipeThrough(createGeminiToolCallIndexer()))
    parts.push(Buffer.from(chunk))
  return Buffer.concat(parts).toString('utf8')
}

/** Parses SSE text into the tool-call fragments of each event, in order. */
function toolCallsOf(text: string) {
  return text.split('\n\n')
    .filter(event => event.startsWith('data: {'))
    .flatMap(event => JSON.parse(event.slice(6)).choices.flatMap((choice: { index: number, delta: { tool_calls?: unknown[] } }) =>
      (choice.delta.tool_calls ?? []).map(call => ({ choice: choice.index, ...(call as object) }))))
}

/** Builds one Gemini-shaped event: tool-call fragments without `index`, as the Gemini endpoint sends them. */
function geminiToolEvent(calls: object[], choice = 0): string {
  return sse({ choices: [{ delta: { role: 'assistant', tool_calls: calls }, index: choice }], model: 'gemini-3.5-flash-lite' })
}

const SIGNATURE = { google: { thought_signature: 'EmAKXgFpFH0T-signature' } }
const FINISH_STOP = sse({ choices: [{ delta: { role: 'assistant' }, finish_reason: 'stop', index: 0 }] })

describe('createGeminiToolCallIndexer', () => {
  it('adds index 0 to a single tool call and keeps every other field', async () => {
    const input = geminiToolEvent([{ extra_content: SIGNATURE, function: { arguments: '{"city":"Kobe"}', name: 'get_weather' }, id: 'call_1', type: 'function' }]) + FINISH_STOP + sse('[DONE]')

    const output = await repair(input)
    const [call] = toolCallsOf(output)

    expect(call).toEqual({ choice: 0, index: 0, extra_content: SIGNATURE, function: { arguments: '{"city":"Kobe"}', name: 'get_weather' }, id: 'call_1', type: 'function' })
    expect(output.endsWith(FINISH_STOP + sse('[DONE]'))).toBe(true)
  })

  it('numbers several calls in one delta by first appearance of their ids', async () => {
    const input = geminiToolEvent([
      { id: 'call_w', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } },
      { id: 'call_t', type: 'function', function: { name: 'get_local_time', arguments: '{"city":"Tokyo"}' } },
    ])

    const calls = toolCallsOf(await repair(input))

    expect(calls.map(call => [call.id, call.index])).toEqual([['call_w', 0], ['call_t', 1]])
  })

  it('keeps a stable id to index mapping across events', async () => {
    const input = [
      geminiToolEvent([{ id: 'call_a', type: 'function', function: { name: 'search', arguments: '{"q":' } }]),
      geminiToolEvent([{ id: 'call_b', type: 'function', function: { name: 'clock', arguments: '{}' } }]),
      geminiToolEvent([{ id: 'call_a', function: { arguments: '"frieren"}' } }]),
    ].join('')

    const calls = toolCallsOf(await repair(input))

    expect(calls.map(call => [call.id, call.index])).toEqual([['call_a', 0], ['call_b', 1], ['call_a', 0]])
  })

  it('joins fragmented arguments without an id to the call that is still streaming', async () => {
    const input = [
      geminiToolEvent([{ id: 'call_a', type: 'function', function: { name: 'search', arguments: '' } }]),
      geminiToolEvent([{ function: { arguments: '{"q":"fri' } }]),
      geminiToolEvent([{ function: { arguments: 'eren"}' } }]),
      geminiToolEvent([{ id: 'call_b', type: 'function', function: { name: 'clock', arguments: '' } }]),
      geminiToolEvent([{ function: { arguments: '{}' } }]),
    ].join('')

    const calls = toolCallsOf(await repair(input))
    const argumentsByIndex = new Map<number, string>()
    for (const call of calls as { index: number, function: { arguments: string } }[])
      argumentsByIndex.set(call.index, (argumentsByIndex.get(call.index) ?? '') + call.function.arguments)

    expect(calls.map(call => call.index)).toEqual([0, 0, 0, 1, 1])
    expect(JSON.parse(argumentsByIndex.get(0)!)).toEqual({ q: 'frieren' })
    expect(JSON.parse(argumentsByIndex.get(1)!)).toEqual({})
  })

  it('keeps separate numbering for each choice', async () => {
    const input = geminiToolEvent([{ id: 'x', function: { name: 'a', arguments: '{}' } }], 0)
      + geminiToolEvent([{ id: 'y', function: { name: 'b', arguments: '{}' } }], 1)
      + geminiToolEvent([{ id: 'z', function: { name: 'c', arguments: '{}' } }], 1)

    const calls = toolCallsOf(await repair(input))

    expect(calls.map(call => [call.choice, call.id, call.index])).toEqual([[0, 'x', 0], [1, 'y', 0], [1, 'z', 1]])
  })

  it('leaves events that already have an index, text events, finish reasons, and [DONE] byte for byte', async () => {
    const input = `${sse({ choices: [{ delta: { role: 'assistant', content: '<|ACT {"emotion":"happy"}|>  Hi\n\tthere' }, index: 0 }] })
      + sse({ choices: [{ delta: { tool_calls: [{ index: 3, id: 'c', function: { name: 'f', arguments: '{}' } }] }, index: 0 }] })
      + FINISH_STOP
    }: keep-alive comment\n\n${
      sse('[DONE]')}`

    expect(await repair(input)).toBe(input)
  })

  it('passes a malformed tool-call event through unchanged', async () => {
    const input = 'data: {"choices":[{"delta":{"tool_calls":[{"id":"c","function":{"arguments":"{\\"ci\n\n'

    expect(await repair(input)).toBe(input)
  })

  it('gives the same result for any chunk boundary, including inside multibyte characters', async () => {
    const input = sse({ choices: [{ delta: { content: 'こんにちは 👋 ' }, index: 0 }] })
      + geminiToolEvent([{ id: 'call_1', extra_content: SIGNATURE, function: { name: 'get_weather', arguments: '{"city":"大阪"}' } }])
      + FINISH_STOP
      + sse('[DONE]')
    const whole = await repair(input)

    for (const size of [1, 2, 3, 5, 7, 64])
      expect(await repair(input, size)).toBe(whole)
    expect(toolCallsOf(whole)[0]).toMatchObject({ index: 0, id: 'call_1' })
  })

  it('handles CRLF event boundaries', async () => {
    const input = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{}' } }] }, index: 0 }] })}\r\n\r\n`

    const output = await repair(input)

    expect(output.endsWith('\r\n\r\n')).toBe(true)
    expect(JSON.parse(output.slice(6).trim()).choices[0].delta.tool_calls[0].index).toBe(0)
  })
})

describe('gateway with the gemini compat adapter', () => {
  let provider: Awaited<ReturnType<typeof startFakeProvider>>
  let geminiGateway: RunningGateway
  let plainGateway: RunningGateway
  let logs: string[]

  beforeAll(async () => {
    provider = await startFakeProvider()
    ;({ gateway: geminiGateway, logs } = await startTestGateway(provider.baseURL, { compat: 'gemini' }))
    ;({ gateway: plainGateway } = await startTestGateway(provider.baseURL))
  })

  afterEach(() => {
    provider.requests.length = 0
  })

  afterAll(async () => {
    await geminiGateway.close()
    await plainGateway.close()
    await provider.close()
  })

  const toolTurn = geminiToolEvent([{ extra_content: SIGNATURE, function: { arguments: '{"city":"Kobe"}', name: 'get_weather' }, id: 'call_817486', type: 'function' }])
    + FINISH_STOP
    + sse('[DONE]')

  it('lets the xsAI client that AIRI uses execute a Gemini tool call and continue with the signature intact', async () => {
    provider.setHandler(async (_req, res, received) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // The second round carries the tool result. It answers in text.
      res.end(received.body.includes('"role":"tool"')
        ? sse({ choices: [{ delta: { content: 'Light rain in Kobe.' }, finish_reason: 'stop', index: 0 }] }) + sse('[DONE]')
        : toolTurn)
    })
    let executions = 0

    const result = streamText({
      baseURL: geminiGateway.baseURL,
      apiKey: TEST_INFERENCE_TOKEN,
      model: 'companion-chat',
      messages: [{ role: 'user', content: 'Weather in Kobe?' }],
      tools: [{
        type: 'function',
        function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
        execute: async () => {
          executions++
          return '{"sky":"light rain"}'
        },
      }],
      stopWhen: () => false,
    })
    const steps = await result.steps
    const followUp = JSON.parse(provider.requests[1].body)

    expect(executions).toBe(1)
    expect(provider.requests).toHaveLength(2)
    expect(steps.at(-1)?.text).toBe('Light rain in Kobe.')
    expect(followUp.messages[1].tool_calls[0].id).toBe('call_817486')
    expect(followUp.messages[1].tool_calls[0].extra_content).toEqual(SIGNATURE)
    expect(followUp.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_817486' })
  })

  it('does not change streams from a provider without the compat setting', async () => {
    provider.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(toolTurn)
    })

    const response = await fetch(new URL('chat/completions', plainGateway.baseURL), { method: 'POST', headers: authHeaders(), body: JSON.stringify({ model: 'companion-chat', stream: true, messages: [] }) })

    expect((await readChunks(response)).bytes.toString('utf8')).toBe(toolTurn)
  })

  it('does not change error bodies', async () => {
    const body = '[{"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}]'
    provider.setHandler((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(body)
    })

    const response = await fetch(new URL('chat/completions', geminiGateway.baseURL), { method: 'POST', headers: authHeaders(), body: JSON.stringify({ model: 'companion-chat', stream: true, messages: [] }) })

    expect(response.status).toBe(429)
    expect(await response.text()).toBe(body)
  })

  it('still aborts the provider request when the client cancels during a repaired stream', async () => {
    provider.setHandler(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(geminiToolEvent([{ id: 'call_1', function: { name: 'f', arguments: '' } }]))
      for (let i = 0; i < 200 && !res.destroyed; i++) {
        await new Promise(resolve => setTimeout(resolve, 20))
        if (!res.destroyed)
          res.write(geminiToolEvent([{ function: { arguments: ' ' } }]))
      }
    })
    const controller = new AbortController()

    const response = await fetch(new URL('chat/completions', geminiGateway.baseURL), { method: 'POST', headers: authHeaders(), body: JSON.stringify({ model: 'companion-chat', stream: true, messages: [] }), signal: controller.signal })
    const reader = response.body!.getReader()
    const first = await reader.read()
    controller.abort()

    expect(Buffer.from(first.value!).toString('utf8')).toContain('"index":0')
    await expect(Promise.race([provider.requests[0].closed, new Promise((_, reject) => setTimeout(() => reject(new Error('provider request still open')), 2000))])).resolves.toBeUndefined()
    await expect.poll(() => logs.some(line => line.includes('client_closed_during_response'))).toBe(true)
  })
})
