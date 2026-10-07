import type { RunningGateway } from '../src'

import { Buffer } from 'node:buffer'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { authHeaders, readChunks, sse, startFakeProvider, startTestGateway, TEST_INFERENCE_TOKEN, TEST_PROVIDER_KEY, writeEvents } from './support/harness'

let provider: Awaited<ReturnType<typeof startFakeProvider>>
let gateway: RunningGateway
let logs: string[]

beforeAll(async () => {
  provider = await startFakeProvider()
  ;({ gateway, logs } = await startTestGateway(provider.baseURL))
})

afterEach(() => {
  provider.requests.length = 0
})

afterAll(async () => {
  await gateway.close()
  await provider.close()
})

function post(body: unknown, init: RequestInit = {}) {
  return fetch(new URL('chat/completions', gateway.baseURL), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    ...init,
  })
}

const STREAM_EVENTS = [
  sse({ id: 'c1', object: 'chat.completion.chunk', model: 'real-model-1', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
  sse({ id: 'c1', object: 'chat.completion.chunk', model: 'real-model-1', choices: [{ index: 0, delta: { content: 'Hello' } }] }),
  sse({ id: 'c1', object: 'chat.completion.chunk', model: 'real-model-1', choices: [{ index: 0, delta: { content: ' ' } }] }),
  sse({ id: 'c1', object: 'chat.completion.chunk', model: 'real-model-1', choices: [{ index: 0, delta: { content: '<|ACT {"emotion":"happy"}|>' } }] }),
  sse({ id: 'c1', object: 'chat.completion.chunk', model: 'real-model-1', choices: [{ index: 0, delta: { content: 'world!' } }] }),
  sse({ id: 'c1', object: 'chat.completion.chunk', model: 'real-model-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }),
  sse('[DONE]'),
]

describe('chat completions passthrough', () => {
  it('a: forwards a non-streaming chat unchanged except the model, and returns the provider JSON as sent', async () => {
    const providerBody = '{"id":"x1","object":"chat.completion","model":"real-model-1","choices":[{"index":0,"message":{"role":"assistant","content":"Hi there."},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":3,"total_tokens":6}}'
    provider.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req-1', 'set-cookie': 'tracking=1' })
      res.end(providerBody)
    })
    const request = {
      model: 'companion-chat',
      messages: [
        { role: 'system', content: 'You are AIRI. <|ACT {"emotion":"neutral"}|> markers are allowed.' },
        { role: 'user', content: 'Hi' },
      ],
      temperature: 0.7,
      max_tokens: 16,
      some_unknown_field: { kept: true },
    }

    const response = await post(request)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(providerBody)
    expect(response.headers.get('x-request-id')).toBe('req-1')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0].url).toBe('/v1/chat/completions')
    expect(JSON.parse(provider.requests[0].body)).toEqual({ ...request, model: 'real-model-1' })
    expect(provider.requests[0].headers.authorization).toBe(`Bearer ${TEST_PROVIDER_KEY}`)
    expect(JSON.stringify(provider.requests[0].headers)).not.toContain(TEST_INFERENCE_TOKEN)
  })

  it('b: streams server-sent events byte for byte without buffering the response', async () => {
    const firstChunkSeen = Promise.withResolvers<void>()
    provider.setHandler(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(STREAM_EVENTS[0])
      // The provider holds the rest until the client has the first event. A buffering gateway would deadlock here.
      await firstChunkSeen.promise
      for (const event of STREAM_EVENTS.slice(1))
        res.write(event)
      res.end()
    })

    const response = await post({ model: 'companion-chat', stream: true, messages: [{ role: 'user', content: 'Hi' }] })
    const reader = response.body!.getReader()
    const first = await reader.read()
    firstChunkSeen.resolve()
    const parts = [Buffer.from(first.value!)]
    for (let next = await reader.read(); !next.done; next = await reader.read())
      parts.push(Buffer.from(next.value))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(Buffer.from(first.value!).toString('utf8')).toBe(STREAM_EVENTS[0])
    expect(Buffer.concat(parts).toString('utf8')).toBe(STREAM_EVENTS.join(''))
    expect(JSON.parse(provider.requests[0].body).stream).toBe(true)
  })

  it('c: keeps whitespace, punctuation, and multibyte text when events are split at arbitrary byte boundaries', async () => {
    const text = STREAM_EVENTS.join('')
      + sse({ choices: [{ index: 0, delta: { content: '  \n\t こんにちは、世界！ 👋 "quotes" — dash…' } }] })
    const bytes = Buffer.from(text, 'utf8')
    provider.setHandler(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // Split inside events and inside multibyte characters.
      for (let offset = 0; offset < bytes.length; offset += 7) {
        res.write(bytes.subarray(offset, offset + 7))
        await new Promise(resolve => setTimeout(resolve, 1))
      }
      res.end()
    })

    const response = await post({ model: 'companion-chat', stream: true, messages: [{ role: 'user', content: 'Hi' }] })
    const { bytes: received } = await readChunks(response)

    expect(received.equals(bytes)).toBe(true)
  })

  it.each([
    { name: 'd: 400', status: 400, body: '{"error":{"message":"Invalid value for messages","type":"invalid_request_error","code":"bad_request"}}', headers: {} },
    { name: 'e: 429 with Retry-After and rate-limit headers', status: 429, body: '[{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}]', headers: { 'retry-after': '17', 'x-ratelimit-remaining-requests': '0' } },
    { name: 'f: 500', status: 500, body: '{"error":{"message":"Internal error","type":"server_error"}}', headers: {} },
  ])('$name: passes provider errors through with status, headers, and body', async ({ status, body, headers }) => {
    provider.setHandler((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(body)
    })

    const response = await post({ model: 'companion-chat', stream: true, messages: [{ role: 'user', content: 'Hi' }] })

    expect(response.status).toBe(status)
    expect(await response.text()).toBe(body)
    for (const [name, value] of Object.entries(headers))
      expect(response.headers.get(name)).toBe(value)
  })

  it('g: returns 502 in the OpenAI error shape when the provider is unreachable', async () => {
    const unreachable = await startFakeProvider()
    await unreachable.close()
    const isolated = await startTestGateway(unreachable.baseURL)
    try {
      const response = await fetch(new URL('chat/completions', isolated.gateway.baseURL), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ model: 'companion-chat', messages: [{ role: 'user', content: 'Hi' }] }),
      })
      const body = await response.json() as { error: { code: string, message: string } }

      expect(response.status).toBe(502)
      expect(body.error.code).toBe('provider_unreachable')
      expect(body.error.message).not.toContain(TEST_PROVIDER_KEY)
    }
    finally {
      await isolated.gateway.close()
    }
  })

  it('h: aborts the provider request when the client cancels before the first token', async () => {
    const reached = Promise.withResolvers<void>()
    provider.setHandler(() => {
      // Never answer. Only a cancellation can end this request.
      reached.resolve()
    })
    const controller = new AbortController()

    const pending = post({ model: 'companion-chat', stream: true, messages: [{ role: 'user', content: 'Hi' }] }, { signal: controller.signal })
    await reached.promise
    controller.abort()

    await expect(pending).rejects.toThrow()
    await expect(withTimeout(provider.requests[0].closed, 2000)).resolves.toBeUndefined()
    await expect.poll(() => logs.some(line => line.includes('client_closed_before_response'))).toBe(true)
  })

  it('i: aborts the provider stream when the client cancels in the middle of a response', async () => {
    let writesAfterCancel = 0
    provider.setHandler(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(STREAM_EVENTS[1])
      // Keep streaming until the gateway closes the connection.
      for (let i = 0; i < 200 && !res.destroyed && !res.writableEnded; i++) {
        await new Promise(resolve => setTimeout(resolve, 20))
        if (res.destroyed)
          break
        res.write(STREAM_EVENTS[2])
        writesAfterCancel++
      }
    })
    const controller = new AbortController()

    const response = await post({ model: 'companion-chat', stream: true, messages: [{ role: 'user', content: 'Hi' }] }, { signal: controller.signal })
    const reader = response.body!.getReader()
    await reader.read()
    controller.abort()
    const countAtCancel = writesAfterCancel

    await expect(withTimeout(provider.requests[0].closed, 2000)).resolves.toBeUndefined()
    await new Promise(resolve => setTimeout(resolve, 100))
    // A few events can be in flight while the close propagates. The stream must not run to its natural end.
    expect(writesAfterCancel - countAtCancel).toBeLessThan(10)
    await expect.poll(() => logs.some(line => line.includes('client_closed_during_response'))).toBe(true)
  })

  it('j: passes one streamed tool call with partial argument JSON through unchanged', async () => {
    const events = [
      sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] }),
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] } }] }),
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Tok' } }] } }] }),
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'yo"}' } }] } }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      sse('[DONE]'),
    ]
    provider.setHandler((_req, res) => writeEvents(res, events, 2))
    const request = {
      model: 'companion-chat',
      stream: true,
      messages: [{ role: 'user', content: 'Weather in Tokyo?' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
      tool_choice: 'auto',
    }

    const response = await post(request)
    const { bytes } = await readChunks(response)

    expect(bytes.toString('utf8')).toBe(events.join(''))
    expect(JSON.parse(provider.requests[0].body)).toEqual({ ...request, model: 'real-model-1' })
  })

  it('k: passes several parallel tool calls with interleaved deltas through unchanged', async () => {
    const events = [
      sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'search', arguments: '' } }, { index: 1, id: 'call_b', type: 'function', function: { name: 'clock', arguments: '' } }] } }] }),
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{}' } }] } }] }),
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"frieren"}' } }] } }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      sse('[DONE]'),
    ]
    provider.setHandler((_req, res) => writeEvents(res, events))

    const response = await post({ model: 'companion-chat', stream: true, messages: [{ role: 'user', content: 'Search and tell the time.' }], tools: [], parallel_tool_calls: true })
    const { bytes } = await readChunks(response)

    expect(bytes.toString('utf8')).toBe(events.join(''))
  })

  it('l: forwards assistant tool calls and tool results in the original order for the follow-up generation', async () => {
    provider.setHandler((_req, res) => writeEvents(res, [sse({ choices: [{ index: 0, delta: { content: 'It is sunny in Tokyo.' }, finish_reason: 'stop' }] }), sse('[DONE]')]))
    const messages = [
      { role: 'system', content: 'You are AIRI.' },
      { role: 'user', content: 'Weather in Tokyo and the time?' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } },
        { id: 'call_b', type: 'function', function: { name: 'clock', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'call_a', content: '{"sky":"sunny"}' },
      { role: 'tool', tool_call_id: 'call_b', content: 'Error: clock unavailable' },
    ]

    const response = await post({ model: 'companion-chat', stream: true, messages })
    await readChunks(response)

    expect(JSON.parse(provider.requests[0].body).messages).toEqual(messages)
  })

  it('m: forwards image and text content parts unchanged and never logs the image data', async () => {
    provider.setHandler((_req, res) => writeEvents(res, [sse({ choices: [{ index: 0, delta: { content: 'A cat.' }, finish_reason: 'stop' }] }), sse('[DONE]')]))
    const imageData = `data:image/png;base64,${Buffer.alloc(300_000, 7).toString('base64')}`
    const content = [
      { type: 'text', text: 'What is in this picture?  ' },
      { type: 'image_url', image_url: { url: imageData, detail: 'low' } },
    ]

    const response = await post({ model: 'companion-chat', stream: true, messages: [{ role: 'user', content }] })
    await readChunks(response)

    expect(JSON.parse(provider.requests[0].body).messages[0].content).toEqual(content)
    expect(logs.join('\n')).not.toContain(imageData.slice(30, 90))
    expect(Math.max(...logs.map(line => line.length))).toBeLessThan(2000)
  })

  it('n: ends the client stream when the provider breaks in the middle of a tool-call event, and keeps serving', async () => {
    provider.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"ci')
      setTimeout(() => res.socket?.destroy(), 20)
    })

    const response = await post({ model: 'companion-chat', stream: true, messages: [{ role: 'user', content: 'Hi' }] })

    expect(response.status).toBe(200)
    await expect(readChunks(response)).rejects.toThrow()

    provider.setHandler((_req, res) => writeEvents(res, STREAM_EVENTS))
    const next = await post({ model: 'companion-chat', stream: true, messages: [{ role: 'user', content: 'Again' }] })
    expect((await readChunks(next)).bytes.toString('utf8')).toBe(STREAM_EVENTS.join(''))
  })

  it('rejects an unknown alias with 404 and does not call the provider', async () => {
    const response = await post({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] })
    const body = await response.json() as { error: { code: string } }

    expect(response.status).toBe(404)
    expect(body.error.code).toBe('model_not_found')
    expect(provider.requests).toHaveLength(0)
  })

  it('rejects a body that is not a JSON object with 400', async () => {
    const response = await fetch(new URL('chat/completions', gateway.baseURL), { method: 'POST', headers: authHeaders(), body: '[1,2' })

    expect(response.status).toBe(400)
    expect(provider.requests).toHaveLength(0)
  })

  it('lists configured aliases at /v1/models', async () => {
    const response = await fetch(new URL('models', gateway.baseURL), { headers: authHeaders() })
    const body = await response.json() as { object: string, data: { id: string }[] }

    expect(response.status).toBe(200)
    expect(body.object).toBe('list')
    expect(body.data.map(model => model.id)).toEqual(['companion-chat'])
  })
})

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms))])
}
