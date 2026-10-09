import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { createUsageSniffer } from '../src/providers/usage-sniffer'
import { sse } from './support/harness'

async function run(chunks: string[], contentType = 'text/event-stream') {
  const sniffer = createUsageSniffer(contentType)
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(new Uint8Array(Buffer.from(chunk, 'utf8')))
      controller.close()
    },
  })
  const parts: Buffer[] = []
  for await (const chunk of input.pipeThrough(sniffer.stream))
    parts.push(Buffer.from(chunk))
  return { bytes: Buffer.concat(parts).toString('utf8'), usage: sniffer.usage() }
}

describe('createUsageSniffer', () => {
  it('reads the usage chunk of an event stream and passes every byte through', async () => {
    const events = [
      sse({ choices: [{ delta: { content: 'Hi' } }] }),
      sse({ choices: [], usage: { prompt_tokens: 4321, completion_tokens: 17, total_tokens: 4338 } }),
      sse('[DONE]'),
    ]

    const { bytes, usage } = await run(events)

    expect(bytes).toBe(events.join(''))
    expect(usage).toEqual({ promptTokens: 4321, completionTokens: 17, totalTokens: 4338 })
  })

  it('finds usage when an event is split across chunks', async () => {
    const event = sse({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } })

    const { usage } = await run([event.slice(0, 30), event.slice(30, 60), event.slice(60)])

    expect(usage).toEqual({ promptTokens: 100, completionTokens: 5 })
  })

  it('reads total, cached, and reasoning counts, and keeps the last usage chunk', async () => {
    const events = [
      sse({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 1, total_tokens: 51 } }),
      sse({ choices: [], usage: { prompt_tokens: 585, completion_tokens: 32, total_tokens: 1198, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 581 } } }),
    ]

    const { usage } = await run(events)

    expect(usage).toEqual({ promptTokens: 585, completionTokens: 32, totalTokens: 1198, cachedTokens: 100, reasoningTokens: 581 })
  })

  it('reads the usage of a JSON body', async () => {
    const body = JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } })

    const { bytes, usage } = await run([body.slice(0, 20), body.slice(20)], 'application/json')

    expect(bytes).toBe(body)
    expect(usage).toEqual({ promptTokens: 12, completionTokens: 3 })
  })

  it('reports nothing when the provider sends no usage', async () => {
    const { usage } = await run([sse({ choices: [{ delta: { content: 'Hi' } }] }), sse('[DONE]')])

    expect(usage).toBeUndefined()
  })

  it('ignores a usage field that is not numbers', async () => {
    const { usage } = await run([sse({ usage: { prompt_tokens: 'many' } })])

    expect(usage).toBeUndefined()
  })

  it('ignores events that are not JSON and keeps their bytes', async () => {
    const events = ['data: {broken "usage"\n\n', ': keep-alive\n\n']

    const { bytes, usage } = await run(events)

    expect(bytes).toBe(events.join(''))
    expect(usage).toBeUndefined()
  })

  it('does not hold a JSON body in memory beyond its limit', async () => {
    const huge = `{"x":"${'a'.repeat(3 * 1024 * 1024)}"}`

    const { bytes, usage } = await run([huge], 'application/json')

    expect(bytes.length).toBe(huge.length)
    expect(usage).toBeUndefined()
  })
})
