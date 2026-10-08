import type { BudgetOptions, BudgetResult } from '../src/budget/budgeter'
import type { WireMessage, WireRequest } from '../src/budget/wire'

import { describe, expect, it } from 'vitest'

import { budgetRequest, checkContextInvariants, promptTokensOf } from '../src/budget/budgeter'
import { createTokenEstimator } from '../src/budget/estimate'
import { parseConversation } from '../src/budget/request-units'
import { AIRI_TOOLS, assistant, assistantCalls, filler, system, toolCall, toolResult, user } from './support/wire'

const estimator = createTokenEstimator()

function request(messages: WireMessage[], extra: Partial<WireRequest> = {}): WireRequest {
  return { model: 'companion-chat', stream: true, messages, ...extra }
}

function options(targetTokens: number, extra: Partial<BudgetOptions> = {}): BudgetOptions {
  return { estimator, targetTokens, outputReserveTokens: 1024, ...extra }
}

/** The prompt size of a request, with no trimming. */
function sizeOf(body: WireRequest): number {
  return promptTokensOf(budgetRequest(body, options(Number.MAX_SAFE_INTEGER)).diagnostics)
}

function messagesOf(result: BudgetResult): WireMessage[] {
  if (result.status === 'impossible')
    throw new Error('the result has no body')
  return result.body.messages!
}

/** Ten plain turns of about 200 tokens each. */
function longChat(turns = 10, tokensPerMessage = 100): WireMessage[] {
  const messages: WireMessage[] = [system(filler(300, 's'))]
  for (let turn = 0; turn < turns; turn++)
    messages.push(user(filler(tokensPerMessage, `u${turn}`)), assistant(filler(tokensPerMessage, `a${turn}`)))
  messages.push(user(filler(40, 'now')))
  return messages
}

describe('budgetRequest diagnostics', () => {
  it('counts system, conversation, tool schema, and output reserve separately', () => {
    const body = request([system(filler(500, 's')), user(filler(200, 'u')), assistant(filler(300, 'a')), user('hi')], { tools: AIRI_TOOLS })

    const { diagnostics } = budgetRequest(body, options(Number.MAX_SAFE_INTEGER, { outputReserveTokens: 900 }))

    expect(diagnostics.systemTokens).toBeGreaterThan(490)
    expect(diagnostics.systemTokens).toBeLessThan(520)
    expect(diagnostics.conversationTokens).toBeGreaterThan(490)
    expect(diagnostics.toolSchemaTokens).toBe(estimator.json(AIRI_TOOLS))
    expect(diagnostics.memoryTokens).toBe(0)
    expect(diagnostics.awarenessTokens).toBe(0)
    expect(diagnostics.watchTokens).toBe(0)
    expect(diagnostics.estimatedOutputTokens).toBe(900)
    expect(diagnostics.totalEstimatedTokens).toBe(
      diagnostics.systemTokens + diagnostics.conversationTokens + diagnostics.toolSchemaTokens + diagnostics.estimatedOutputTokens,
    )
  })

  it('takes the output reserve from max_tokens when the request sets it', () => {
    const body = request([user('hi')], { max_tokens: 200 })

    expect(budgetRequest(body, options(10_000)).diagnostics.estimatedOutputTokens).toBe(200)
  })

  it('measures the real AIRI tool set at about two thousand tokens, a large share of a small request', () => {
    const body = request([system(filler(600, 's')), user('hello')], { tools: AIRI_TOOLS })

    const { diagnostics } = budgetRequest(body, options(10_000))

    expect(diagnostics.toolSchemaTokens).toBeGreaterThan(1800)
    expect(diagnostics.toolSchemaTokens / promptTokensOf(diagnostics)).toBeGreaterThan(0.6)
  })
})

describe('budgetRequest target', () => {
  it('returns the very same request when it fits the target', () => {
    const body = request(longChat(3))

    const result = budgetRequest(body, options(sizeOf(body) + 10))

    expect(result.status).toBe('fits')
    expect(messagesOf(result)).toBe(body.messages)
  })

  it('fits at exactly the target and trims at one token below it', () => {
    const body = request(longChat(6))
    const size = sizeOf(body)

    expect(budgetRequest(body, options(size)).status).toBe('fits')
    expect(budgetRequest(body, options(size - 1)).status).toBe('trimmed')
  })

  it('drops the oldest turns first and keeps the recent turns and the newest message', () => {
    const body = request(longChat(10))
    const size = sizeOf(body)

    const result = budgetRequest(body, options(Math.round(size * 0.5)))

    expect(result.status).toBe('trimmed')
    const out = messagesOf(result)
    expect(out[0]).toBe(body.messages![0])
    expect(out.at(-1)).toBe(body.messages!.at(-1))
    // Messages 1 and 19 are the first and the last user turn of the history.
    expect(out).not.toContain(body.messages![1])
    expect(out).toContain(body.messages![19])
    expect(promptTokensOf(result.diagnostics)).toBeLessThanOrEqual(Math.round(size * 0.5))
    expect(checkContextInvariants(body.messages!, out)).toEqual([])
  })

  it('trims down to the low-water mark, so that the next requests keep the same prefix', () => {
    const body = request(longChat(20))
    const size = sizeOf(body)
    const target = Math.round(size * 0.6)

    const result = budgetRequest(body, options(target, { lowWaterRatio: 0.8, summaryMaxTokens: 100 }))

    expect(promptTokensOf(result.diagnostics)).toBeLessThanOrEqual(Math.round(target * 0.8))
    expect(promptTokensOf(result.diagnostics)).toBeGreaterThan(target * 0.6)
  })

  it('keeps every other request field and its key order', () => {
    const body: WireRequest = { model: 'companion-chat', temperature: 0.7, messages: longChat(8), stream: true, tools: AIRI_TOOLS, tool_choice: 'auto' }

    // The tool schemas and the system card are fixed, so only a target above them leaves room to trim.
    const result = budgetRequest(body, options(Math.round(sizeOf(body) * 0.8)))

    if (result.status === 'impossible')
      throw new Error('unexpected')
    expect(result.status).toBe('trimmed')
    expect(Object.keys(result.body)).toEqual(Object.keys(body))
    expect(result.body.temperature).toBe(0.7)
    expect(result.body.tools).toBe(AIRI_TOOLS)
  })

  it('is deterministic', () => {
    const body = request(longChat(12))
    const target = Math.round(sizeOf(body) * 0.5)

    expect(JSON.stringify(budgetRequest(body, options(target)))).toBe(JSON.stringify(budgetRequest(body, options(target))))
  })

  it('reports impossible, never a silent truncation, when the fixed part alone exceeds the target', () => {
    const body = request([system(filler(500, 's')), user(filler(900, 'u'))], { tools: AIRI_TOOLS })

    const result = budgetRequest(body, options(1500))

    expect(result.status).toBe('impossible')
    if (result.status === 'impossible')
      expect(result.requiredTokens).toBeGreaterThan(3000)
  })

  it('reports impossible for a huge tool set even with an empty history', () => {
    const hugeTools = Array.from({ length: 40 }, (_, i) => ({ type: 'function', function: { name: `tool_${i}`, description: filler(300, 'd'), parameters: { type: 'object', properties: {} } } }))

    const result = budgetRequest(request([user('hi')], { tools: hugeTools }), options(8000))

    expect(result.status).toBe('impossible')
  })

  it('counts a request that is near a provider rate limit as over target and trims the old turns', () => {
    // 4.5k prompt target, as for a 7k TPM model that also has to carry the second round of a tool turn.
    const body = request([system(filler(500, 's')), ...longChat(8).slice(1)], { tools: AIRI_TOOLS })

    const result = budgetRequest(body, options(4500))

    expect(result.status).toBe('trimmed')
    expect(promptTokensOf(result.diagnostics)).toBeLessThanOrEqual(4500)
  })
})

describe('budgetRequest tool exchanges', () => {
  function toolHistory(): WireMessage[] {
    return [
      system(filler(200, 's')),
      user(filler(60, 'u0')),
      assistantCalls([toolCall('a', 'search'), toolCall('b', 'weather'), toolCall('c', 'lookup')], 'checking'),
      toolResult('b', filler(400, 'rb')),
      toolResult('c', filler(400, 'rc')),
      toolResult('a', filler(400, 'ra')),
      assistant(filler(80, 'final0')),
      user(filler(60, 'u1')),
      assistantCalls([toolCall('d', 'list')]),
      toolResult('d', filler(300, 'rd')),
      assistantCalls([toolCall('e', 'call')]),
      toolResult('e', '{"isError":true,"content":[{"type":"text","text":"failed"}]}'),
      assistant(filler(80, 'final1')),
      user(filler(60, 'u2')),
      assistant(filler(60, 'a2')),
      user(filler(60, 'u3')),
      assistantCalls([toolCall('f', 'now')]),
      toolResult('f', filler(100, 'rf')),
      assistant(filler(60, 'final3')),
      user(filler(40, 'now')),
    ]
  }

  it('never splits an exchange at any target between the minimum and the full size', () => {
    const body = request(toolHistory())
    const size = sizeOf(body)
    const smallest = promptTokensOf(budgetRequest(body, options(1)).diagnostics)

    let trimmedCount = 0
    for (let target = 1; target <= size; target += 3) {
      const result = budgetRequest(body, options(target, { lowWaterRatio: 1 }))
      if (result.status === 'impossible')
        continue
      trimmedCount += result.status === 'trimmed' ? 1 : 0
      const out = messagesOf(result)

      expect(checkContextInvariants(body.messages!, out), `target ${target}`).toEqual([])
      expect(parseConversation(out).ok, `target ${target}`).toBe(true)
      if (result.status === 'trimmed')
        expect(promptTokensOf(result.diagnostics), `target ${target}`).toBeLessThanOrEqual(target)
    }
    expect(trimmedCount).toBeGreaterThan(20)
    expect(smallest).toBeGreaterThan(0)
  })

  it('compacts old tool exchanges to the final answer before it drops any turn', () => {
    const body = request(toolHistory())
    const size = sizeOf(body)

    const result = budgetRequest(body, options(size - 200, { lowWaterRatio: 1, protectedRecentGroups: 1 }))

    expect(result.status).toBe('trimmed')
    const text = JSON.stringify(messagesOf(result))
    // The first turn is compacted: its user message and final answer stay, its three tool results go.
    expect(text).toContain('u0:')
    expect(text).toContain('final0:')
    expect(text).not.toContain('rb:')
    expect(text).not.toContain('ra:')
    expect(result.status === 'trimmed' && result.trim.droppedGroups).toBe(0)
    expect(result.status === 'trimmed' && result.trim.compactedGroups).toBeGreaterThan(0)
    expect(result.status === 'trimmed' && result.trim.summary).toBeUndefined()
  })

  it('keeps the most recent turns complete while it compacts older ones', () => {
    const body = request(toolHistory())
    const size = sizeOf(body)

    const result = budgetRequest(body, options(size - 150, { lowWaterRatio: 1, protectedRecentGroups: 3 }))

    const out = messagesOf(result)
    // Turn 3 has a tool exchange and is among the three protected turns, so it stays whole.
    expect(out.filter(message => message.role === 'tool').some(message => message.tool_call_id === 'f')).toBe(true)
    expect(checkContextInvariants(body.messages!, out)).toEqual([])
  })

  it('keeps an agent continuation whole: the call and its result stay with the final user turn', () => {
    const body = request([
      system(filler(200, 's')),
      ...longChat(8).slice(1, -1),
      user('what is the weather?'),
      assistantCalls([toolCall('w', 'get_weather', { location: 'Osaka' })]),
      toolResult('w', '21C clear'),
    ])

    const result = budgetRequest(body, options(Math.round(sizeOf(body) * 0.4)))

    const out = messagesOf(result)
    expect(out.at(-1)).toBe(body.messages!.at(-1))
    expect(out.at(-2)).toBe(body.messages!.at(-2))
    expect(out.at(-3)).toBe(body.messages!.at(-3))
    expect(checkContextInvariants(body.messages!, out)).toEqual([])
  })

  it('reports impossible when the in-progress turn itself is larger than the target', () => {
    const body = request([
      system('card'),
      user('read the file'),
      assistantCalls([toolCall('r', 'read_file')]),
      toolResult('r', filler(5000, 'big')),
    ])

    expect(budgetRequest(body, options(2000)).status).toBe('impossible')
  })

  it('passes a request with a broken tool history through untouched', () => {
    const cases: [string, WireMessage[]][] = [
      ['orphan tool result', [system('c'), user(filler(500, 'a')), toolResult('x', 'r'), user(filler(500, 'b'))]],
      ['interrupted generation', [system('c'), user(filler(500, 'a')), assistantCalls([toolCall('x', 'f')])]],
      ['missing result before next user', [system('c'), user(filler(500, 'a')), assistantCalls([toolCall('x', 'f')]), user(filler(500, 'b'))]],
    ]

    for (const [name, messages] of cases) {
      const body = request(messages)
      const result = budgetRequest(body, options(100))

      expect(result.status, name).toBe('untrimmed')
      expect(messagesOf(result), name).toBe(body.messages)
    }
  })
})

describe('budgetRequest user turns with images', () => {
  const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(200_000)}` } }

  it('counts an older image turn at the image cost and keeps all its parts when it stays', () => {
    const picture: WireMessage = { role: 'user', content: [{ type: 'text', text: 'look at this' }, image] }
    const body = request([system('card'), picture, assistant('nice'), user('and now?')])

    const result = budgetRequest(body, options(5000))

    expect(result.status).toBe('fits')
    expect(promptTokensOf(result.diagnostics)).toBeLessThan(estimator.imageTokens + 100)
    expect(messagesOf(result)[1]).toBe(picture)
  })

  it('drops an old image turn as a whole, never its text without the image', () => {
    const picture: WireMessage = { role: 'user', content: [{ type: 'text', text: 'look at this' }, image] }
    const body = request([system('card'), picture, assistant('nice'), ...longChat(6).slice(1)])

    const result = budgetRequest(body, options(Math.round(sizeOf(body) * 0.7)))

    const out = messagesOf(result)
    expect(out.includes(picture) || !JSON.stringify(out).includes('look at this') || JSON.stringify(out).includes('Earlier conversation')).toBe(true)
    for (const message of out) {
      if (Array.isArray(message.content) && message.content.some(part => (part as { type?: string }).type === 'text' && (part as { text?: string }).text === 'look at this'))
        expect(message).toBe(picture)
    }
  })

  it('reports impossible when the newest turn holds more images than the target allows', () => {
    const body = request([system('card'), { role: 'user', content: [image, image, image] }])

    expect(budgetRequest(body, options(2000)).status).toBe('impossible')
  })
})

describe('budgetRequest summary of dropped history', () => {
  it('covers exactly the dropped turns and never repeats them verbatim', () => {
    const body = request(longChat(12))

    const result = budgetRequest(body, options(Math.round(sizeOf(body) * 0.5)))

    if (result.status !== 'trimmed')
      throw new Error('expected a trimmed result')
    const covered = result.trim.summary!.coversMessages
    expect(covered.start).toBe(1)
    expect(covered.end).toBeGreaterThan(1)
    // Every kept original message lies outside the covered range, and the summary message is the only new message.
    for (const index of result.trim.keptIndexes)
      expect(index < covered.start || index >= covered.end).toBe(true)
    const out = messagesOf(result)
    expect(out.length).toBe(result.trim.keptIndexes.length + 1)
    expect(out[1].role).toBe('user')
    expect(String(out[1].content)).toContain('Earlier conversation')
    for (const message of out.slice(2))
      expect(body.messages!.includes(message)).toBe(true)
  })

  it('keeps the recap inside its own token bound', () => {
    const body = request(longChat(60, 200))

    const result = budgetRequest(body, options(Math.round(sizeOf(body) * 0.3), { summaryMaxTokens: 300 }))

    if (result.status !== 'trimmed')
      throw new Error('expected a trimmed result')
    expect(result.trim.summary!.tokens).toBeLessThanOrEqual(300)
    expect(result.trim.summary!.tokens).toBeGreaterThan(20)
  })

  it('writes a one-line notice when the summary mode is notice', () => {
    const body = request(longChat(12))

    const result = budgetRequest(body, options(Math.round(sizeOf(body) * 0.5), { summary: 'notice' }))

    if (result.status !== 'trimmed')
      throw new Error('expected a trimmed result')
    expect(result.trim.summary!.tokens).toBeLessThan(60)
  })

  it('adds no message when the summary mode is none', () => {
    const body = request(longChat(12))

    const result = budgetRequest(body, options(Math.round(sizeOf(body) * 0.5), { summary: 'none' }))

    if (result.status !== 'trimmed')
      throw new Error('expected a trimmed result')
    expect(result.trim.summary).toBeUndefined()
    expect(messagesOf(result).every(message => body.messages!.includes(message))).toBe(true)
  })

  it('never summarizes a summary: a re-budgeted request starts again from the verbatim history', () => {
    const body = request(longChat(30))
    const target = Math.round(sizeOf(body) * 0.4)

    const first = budgetRequest(body, options(target))
    const second = budgetRequest(body, options(target))

    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    const summaries = messagesOf(first).filter(message => String(message.content).includes('Earlier conversation'))
    expect(summaries).toHaveLength(1)
  })
})

describe('budgetRequest speed', () => {
  it('budgets a 50k-token request in well under 100 ms', () => {
    const body = request(longChat(250, 200), { tools: AIRI_TOOLS })
    const started = performance.now()

    const result = budgetRequest(body, options(20_000))

    expect(performance.now() - started).toBeLessThan(100)
    expect(result.status).toBe('trimmed')
  })
})

describe('budgetRequest injected units', () => {
  const memory = (tokens = 120) => ({ kind: 'memory' as const, message: user(`MEMORY ${filler(tokens, 'm')}`) })
  const awareness = (tokens = 80) => ({ kind: 'awareness' as const, message: user(`NOW ${filler(tokens, 'n')}`) })

  it('places units directly before the current turn and counts them in their own fields', () => {
    const body = request(longChat(3))
    const units = [memory(), awareness()]

    const result = budgetRequest(body, options(Number.MAX_SAFE_INTEGER, { injected: units }))

    expect(result.status).toBe('fits')
    const out = messagesOf(result)
    const original = body.messages!
    expect(out.slice(0, original.length - 1)).toEqual(original.slice(0, -1))
    expect(out.at(-3)).toBe(units[0].message)
    expect(out.at(-2)).toBe(units[1].message)
    expect(out.at(-1)).toBe(original.at(-1))
    expect(result.diagnostics.memoryTokens).toBe(estimator.message(units[0].message))
    expect(result.diagnostics.awarenessTokens).toBe(estimator.message(units[1].message))
    expect(result.diagnostics.conversationTokens).toBe(budgetRequest(body, options(Number.MAX_SAFE_INTEGER)).diagnostics.conversationTokens)
    expect(checkContextInvariants(original, out)).toEqual([])
  })

  it('trims older history before it drops a unit, and keeps the result within the target', () => {
    const body = request(longChat(10))
    const units = [memory(), awareness()]
    const target = Math.round(sizeOf(body) * 0.6)

    const result = budgetRequest(body, options(target, { injected: units }))

    expect(result.status).toBe('trimmed')
    const out = messagesOf(result)
    expect(out).toContain(units[0].message)
    expect(out).toContain(units[1].message)
    expect(result.status === 'trimmed' && result.injection).toEqual({ kept: ['memory', 'awareness'], dropped: [] })
    expect(promptTokensOf(result.diagnostics)).toBeLessThanOrEqual(target)
    expect(checkContextInvariants(body.messages!, out)).toEqual([])
  })

  it('drops awareness before memory when only the fixed part and one unit fit', () => {
    const body = request([system(filler(300, 's')), user(filler(100, 'now'))])
    const units = [awareness(200), memory(200)]

    const result = budgetRequest(body, options(sizeOf(body) + estimator.message(units[1].message) + 5, { injected: units }))

    const out = messagesOf(result)
    expect(out).toContain(units[1].message)
    expect(out).not.toContain(units[0].message)
    expect(result.status !== 'impossible' && result.status !== 'untrimmed' && result.injection).toEqual({ kept: ['memory'], dropped: ['awareness'] })
  })

  it('never lets a unit make a request impossible, and never adds a unit to a malformed history', () => {
    const tight = request([system(filler(300, 's')), user(filler(100, 'now'))])
    const result = budgetRequest(tight, options(sizeOf(tight), { injected: [memory(400)] }))
    expect(result.status).toBe('fits')
    expect(messagesOf(result)).toBe(tight.messages)

    const broken = request([system('c'), user('a'), toolResult('x', 'r'), user('b')])
    const untrimmed = budgetRequest(broken, options(10_000, { injected: [memory()] }))
    expect(untrimmed.status).toBe('untrimmed')
    expect(messagesOf(untrimmed)).toBe(broken.messages)
  })

  it('puts units before a tool continuation turn and keeps its exchange whole', () => {
    const messages = [system('card'), user(filler(200, 'old')), assistant(filler(200, 'old reply')), user('what is the weather'), assistantCalls([toolCall('c1', 'weather')]), toolResult('c1', 'sunny')]
    const body = request(messages)
    const unit = memory(50)

    const out = messagesOf(budgetRequest(body, options(Number.MAX_SAFE_INTEGER, { injected: [unit] })))

    expect(out.indexOf(unit.message)).toBe(3)
    expect(out.slice(4)).toEqual(messages.slice(3))
    expect(checkContextInvariants(messages, out)).toEqual([])
  })
})
