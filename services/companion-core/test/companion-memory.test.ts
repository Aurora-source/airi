import type { PromptDiagnostics } from '../src/budget/budgeter'
import type { MemoryPorts } from '../src/companion/memory'
import type { TurnIdentity } from '../src/companion/turn-identity'
import type { MemoryItem } from '../src/memory/ports'
import type { CompanionHarness } from './support/companion'
import type { ProviderHandler } from './support/harness'

import { Buffer } from 'node:buffer'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { persistedTurnOf } from '../src/companion/channel-observer'
import { usedItemIds } from '../src/companion/memory'
import { createCompanionMcpServer } from '../src/mcp/server'
import { eventually, identityHeaders, startCompanionGateway } from './support/companion'
import { ALLOWED_ORIGIN, authHeaders, sse, startFakeProvider, TEST_INFERENCE_TOKEN, TEST_OPS_TOKEN, writeEvents } from './support/harness'
import { filler, system, toolCall, user } from './support/wire'

type Provider = Awaited<ReturnType<typeof startFakeProvider>>

let provider: Provider
let harness: CompanionHarness | undefined

beforeAll(async () => {
  provider = await startFakeProvider()
})

afterEach(async () => {
  await harness?.close()
  harness = undefined
  provider.requests.length = 0
})

afterAll(async () => {
  await provider.close()
})

function answers(text: string): ProviderHandler {
  return (_req, res) => void writeEvents(res, [
    sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
    sse({ choices: [{ index: 0, delta: { content: text } }] }),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    sse('[DONE]'),
  ])
}

function callsTool(id: string, name: string): ProviderHandler {
  return (_req, res) => void writeEvents(res, [
    sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '{}' } }] } }] }),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    sse('[DONE]'),
  ])
}

const breaksMidStream: ProviderHandler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse({ choices: [{ index: 0, delta: { content: 'I was about to say' } }] }))
  setTimeout(() => res.destroy(), 20)
}

const CARD = system(filler(200, 'card'))

interface OpsBody {
  items?: MemoryItem[]
  item?: MemoryItem
  format?: string
  ok?: boolean
}

/** Memory ports that fail every call except the ones a test supplies. */
function stubPorts(overrides: Partial<MemoryPorts>): MemoryPorts {
  const fail = async () => Promise.reject(new Error('not stubbed'))
  return {
    ingest: async () => ({ status: 'inserted' }),
    setAuthorityAvailable: async () => {},
    recall: fail,
    inspect: fail,
    characters: fail,
    edit: fail,
    delete: fail,
    forget: fail,
    setPrivateMode: fail,
    exportUser: fail,
    backup: fail,
    consolidate: fail,
    review: async () => true,
    ...overrides,
  }
}

function identity(roundId: string, sessionId = 'session-1', characterId = 'card-mura'): TurnIdentity {
  return { sessionId, roundId, characterId }
}

async function chat(who: TurnIdentity | undefined, messages: unknown[], extra: Record<string, unknown> = {}) {
  const response = await fetch(new URL('chat/completions', harness!.gateway.baseURL), {
    method: 'POST',
    headers: who ? identityHeaders(who) : authHeaders(),
    body: JSON.stringify({ model: 'companion-chat', stream: true, messages, ...extra }),
  })
  return { response, text: await response.text() }
}

async function exportTables() {
  const memory = harness!.companion.memory!
  return (await memory.ports.exportUser(memory.userId)).tables
}

function sentMessages(index = -1): { role: string, content?: unknown }[] {
  return JSON.parse(provider.requests.at(index)!.body).messages
}

async function persist(turn: { who: TurnIdentity, userText: string, assistantText: string, assistantTurnId?: string }) {
  return harness!.companion.memory!.observePersistedTurn({
    sessionId: turn.who.sessionId,
    characterId: turn.who.characterId,
    userMessageId: turn.who.roundId,
    userText: turn.userText,
    assistantTurnId: turn.assistantTurnId ?? `turn-${turn.who.roundId}`,
    assistantText: turn.assistantText,
    occurredAt: Date.now(),
  })
}

describe('memory injection (scenario A)', () => {
  it('recalls a remembered fact in a later turn and injects one bounded block before the current turn', async () => {
    harness = await startCompanionGateway(provider.baseURL)
    provider.setHandler(answers('Sure!'))
    await persist({ who: identity('r1'), userText: 'My favorite game is Hollow Knight, I play it every weekend.', assistantText: 'Hollow Knight is beautiful.' })

    await chat(identity('r2'), [CARD, user('What game should we talk about tonight?')])

    const messages = sentMessages()
    expect(messages).toHaveLength(3)
    expect(messages[1].role).toBe('user')
    expect(String(messages[1].content)).toContain('MEMORY')
    expect(String(messages[1].content)).toContain('Hollow Knight')
    expect(Buffer.byteLength(String(messages[1].content))).toBeLessThanOrEqual(2400)
    expect(messages[2]).toEqual(user('What game should we talk about tonight?'))
    const log = JSON.parse(harness.logs.find(line => line.includes('"outcome":"ok"'))!)
    expect(log.tokens.memory).toBeGreaterThan(0)
  })

  it('injects nothing for an unrelated question, for another character, or without AIRI turn identity', async () => {
    harness = await startCompanionGateway(provider.baseURL)
    provider.setHandler(answers('Hi'))
    await persist({ who: identity('r1'), userText: 'My sister is called Aiko.', assistantText: 'Nice to know about Aiko.' })

    await chat(identity('r2'), [CARD, user('How is the weather?')])
    await chat(identity('r3', 'session-2', 'card-other'), [CARD, user('Tell me about Aiko')])
    await chat(undefined, [CARD, user('Tell me about Aiko')])

    for (const index of [0, 1, 2])
      expect(JSON.stringify(sentMessages(index))).not.toContain('MEMORY')
  })

  it('reads global facts for every character and keeps character facts with their character', async () => {
    harness = await startCompanionGateway(provider.baseURL)
    provider.setHandler(answers('ok'))
    const memory = harness.companion.memory!
    await chat(identity('r1'), [CARD, user('hello')])
    await memory.rememberForTool({ text: 'The user is a nurse.', key: 'user.job', value: 'nurse', category: 'identity', scope: 'global' })
    await memory.rememberForTool({ text: 'Mura calls the user "captain".', key: 'nickname.user', value: 'captain', category: 'nickname', scope: 'character' })

    await chat(identity('r2', 'session-9', 'card-other'), [CARD, user('Do you remember my job as a nurse, captain?')])
    const other = JSON.stringify(sentMessages())
    expect(other).toContain('nurse')
    expect(other).not.toContain('calls the user')

    await chat(identity('r3'), [CARD, user('Do you remember my job as a nurse, captain?')])
    const own = JSON.stringify(sentMessages())
    expect(own).toContain('nurse')
    expect(own).toContain('captain')
  })
})

describe('one logical event across observers (scenario B)', () => {
  it('merges the gateway observation and the persisted AIRI turn into one user event and one assistant event', async () => {
    harness = await startCompanionGateway(provider.baseURL)
    provider.setHandler(answers('Miso is such a sweet name!'))
    const who = identity('round-cat')

    await chat(who, [CARD, user('I adopted a cat named Miso yesterday')])
    await eventually(exportTables, tables => tables.events.length === 2)
    expect((await exportTables()).events.every(event => event.authority === 'provisional')).toBe(true)

    await persist({ who, userText: 'I adopted a cat named Miso yesterday', assistantText: 'Miso is such a sweet name!' })
    await persist({ who, userText: 'I adopted a cat named Miso yesterday', assistantText: 'Miso is such a sweet name!' })

    const tables = await exportTables()
    expect(tables.events).toHaveLength(2)
    expect(tables.events.map(event => event.authority)).toEqual(['authoritative', 'authoritative'])
    expect(tables.events.map(event => event.canonical_id).sort()).toEqual(['airi:session-1:msg:round-cat', 'airi:session-1:turn:turn-round-cat'])
    for (const event of tables.events)
      expect(tables.event_sources.filter(source => source.event_id === event.id).map(source => source.source).sort()).toEqual(['airi', 'gateway'])
  })

  it('keeps one event when the persisted turn arrives first and the gateway observation after it', async () => {
    harness = await startCompanionGateway(provider.baseURL)
    provider.setHandler(answers('Tea it is.'))
    const who = identity('round-tea')
    await persist({ who, userText: 'I prefer green tea over coffee', assistantText: 'Tea it is.' })

    await chat(who, [CARD, user('I prefer green tea over coffee')])
    await eventually(exportTables, tables => tables.event_sources.length === 4)

    const tables = await exportTables()
    expect(tables.events).toHaveLength(2)
    expect(tables.events.every(event => event.authority === 'authoritative')).toBe(true)
  })

  it('observes nothing for an interrupted generation, and one user event for a retried round', async () => {
    harness = await startCompanionGateway(provider.baseURL)
    const who = identity('round-retry')
    provider.setHandler(breaksMidStream)
    await chat(who, [CARD, user('Tell me a story about dragons')]).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 150))
    expect((await exportTables()).events).toHaveLength(0)

    provider.setHandler(answers('Once upon a time, a dragon...'))
    await chat(who, [CARD, user('Tell me a story about dragons')])
    await chat(who, [CARD, user('Tell me a story about dragons')])
    await eventually(exportTables, tables => tables.events.length >= 2)
    await new Promise(resolve => setTimeout(resolve, 150))
    const kinds = (await exportTables()).events.map(event => event.kind).sort()
    expect(kinds).toEqual(['assistant', 'user_text'])
  })

  it('observes a tool turn once: the user message on the first round, the final answer with tool evidence on the last', async () => {
    harness = await startCompanionGateway(provider.baseURL)
    const who = identity('round-tool')
    provider.setHandler(callsTool('call-7', 'get_weather'))
    const opening = [CARD, user('What is the weather in Osaka?')]
    await chat(who, opening, { tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }] })

    provider.setHandler(answers('It is sunny in Osaka.'))
    await chat(who, [...opening, { role: 'assistant', content: null, tool_calls: [toolCall('call-7', 'get_weather')] }, { role: 'tool', tool_call_id: 'call-7', content: '24 degrees, sunny' }])
    await eventually(exportTables, tables => tables.events.length === 2 && tables.tool_evidence.length === 1)

    const tables = await exportTables()
    expect(tables.events.map(event => event.kind).sort()).toEqual(['assistant', 'user_text'])
    expect(tables.tool_evidence[0]).toMatchObject({ call_id: 'call-7', name: 'get_weather' })
  })

  it('reads the identity envelope of a channel completion and rejects one without a character', () => {
    const data = {
      'turn': { sessionId: 's', turnId: 'u1', assistantTurnId: 'a1', characterId: 'c' },
      'message': { role: 'assistant', content: '<|ACT {"emotion":"happy"}|> Hi there', categorization: { speech: 'Hi there', reasoning: '' }, slices: [{ type: 'tool-call', toolCall: { toolCallId: 'k1', toolName: 'search' } }, { type: 'tool-call-result', id: 'k1', result: 'found' }] },
      'gen-ai:chat': { message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    }

    expect(persistedTurnOf(data, 5)).toEqual({
      sessionId: 's',
      characterId: 'c',
      userMessageId: 'u1',
      userText: 'hello',
      assistantTurnId: 'a1',
      assistantText: 'Hi there',
      occurredAt: 5,
      tools: [{ callId: 'k1', name: 'search', outcome: 'success', text: 'found' }],
    })
    expect(persistedTurnOf({ ...data, turn: { sessionId: 's', turnId: 'u1' } }, 5)).toBeUndefined()
    expect(persistedTurnOf({ message: data.message }, 5)).toBeUndefined()
  })

  it('removes AIRI ACT markers before memory stores or matches the text', async () => {
    harness = await startCompanionGateway(provider.baseURL)
    await persist({ who: identity('r-act'), userText: 'I love strawberries', assistantText: '<|ACT {"emotion":"happy"}|> Strawberries are the best! <|DELAY:1|>' })

    const items = await harness.companion.memory!.ports.inspect({ userId: 'local-user', characterId: 'card-mura' })
    expect(items[0].originalText).not.toContain('emotion')
    expect(items[0].originalText).toContain('Strawberries are the best!')
  })
})

describe('corrections (scenario C)', () => {
  it('supersedes the old value and recalls only the current one as a present fact', async () => {
    harness = await startCompanionGateway(provider.baseURL)
    provider.setHandler(answers('Noted!'))
    const memory = harness.companion.memory!

    const first = identity('r1', 'session-a')
    await chat(first, [CARD, user('My favorite game is Celeste.')])
    await persist({ who: first, userText: 'My favorite game is Celeste.', assistantText: 'Noted!' })
    await memory.rememberForTool({ text: 'The user\'s favorite game is Celeste.', key: 'user.favorite_game', value: 'Celeste', category: 'preference', scope: 'global' })

    const second = identity('r2', 'session-b')
    await chat(second, [CARD, user('Actually I don\'t like Celeste anymore. Hades is my favorite.')])
    await persist({ who: second, userText: 'Actually I don\'t like Celeste anymore. Hades is my favorite.', assistantText: 'Noted!' })
    await memory.rememberForTool({ text: 'The user\'s favorite game is Hades.', key: 'user.favorite_game', value: 'Hades', category: 'preference', scope: 'global', correction: true })

    const facts = await memory.ports.inspect({ userId: 'local-user', characterId: 'card-mura', kind: 'fact' })
    const celeste = facts.find(fact => fact.semanticValue === 'celeste')!
    const hades = facts.find(fact => fact.semanticValue === 'hades')!
    expect(celeste.state).toBe('superseded')
    expect(celeste.supersededBy).toBe(hades.id)
    expect(celeste.validTo).not.toBeNull()
    expect(hades.state).toBe('active')
    expect(hades.provenance[0].source).toBe('admin')

    await chat(identity('r3', 'session-c'), [CARD, user('Which game is my favorite game?')])
    const block = String(sentMessages()[1].content)
    expect(block).toMatch(/fact remembered global [^\]]+\] "The user's favorite game is Hades\."/)
    // The old fact and the old conversation that stated it are both gone. Celeste appears only inside the correction.
    expect(block).not.toContain('favorite game is Celeste')
    expect(block).not.toContain('My favorite game is Celeste')
    expect(block.split('\n').filter(line => line.includes('Celeste')).every(line => line.includes('don\'t like Celeste anymore'))).toBe(true)
  })
})

describe('budget (scenario I) and failure (scenario J)', () => {
  it('keeps memory inside the model budget: older history goes first, the memory block stays', async () => {
    harness = await startCompanionGateway(provider.baseURL, {
      models: { 'fake-model': { provider: 'fake', model: 'real-model-1', capabilities: { contextWindow: 128_000, maxPrompt: 3000 } } },
      aliases: { 'companion-chat': { chain: ['fake-model'], prompt: { softTarget: 3000 } } },
    })
    provider.setHandler(answers('ok'))
    await persist({ who: identity('r0'), userText: 'My dog is named Biscuit and loves the beach.', assistantText: 'Biscuit sounds adorable.' })
    const history = Array.from({ length: 20 }, (_, i) => [user(filler(150, `u${i}`)), { role: 'assistant', content: filler(150, `a${i}`) }]).flat()

    await chat(identity('r1'), [CARD, ...history, user('How is Biscuit doing at the beach?')])

    const status = await (await fetch(new URL('../ops/status', harness.gateway.baseURL), { headers: { authorization: `Bearer ${TEST_OPS_TOKEN}` } })).json() as { recentRoutes: { prompt: PromptDiagnostics }[] }
    const prompt = status.recentRoutes.at(-1)!.prompt
    expect(prompt.memoryTokens).toBeGreaterThan(0)
    expect(prompt.totalEstimatedTokens - prompt.estimatedOutputTokens).toBeLessThanOrEqual(3000)
    expect(sentMessages().length).toBeLessThan(history.length)
    expect(JSON.stringify(sentMessages())).toContain('Biscuit')
  })

  it('answers normally without memory when recall hangs or fails', async () => {
    const hanging = stubPorts({ recall: () => new Promise(() => {}) })
    harness = await startCompanionGateway(provider.baseURL, { memory: { recallDeadlineMs: 50 } }, { memoryPorts: hanging })
    provider.setHandler(answers('Still here!'))

    const started = performance.now()
    const { response, text } = await chat(identity('r1'), [CARD, user('Do you remember me?')])

    expect(response.status).toBe(200)
    expect(text).toContain('Still here!')
    expect(performance.now() - started).toBeLessThan(1000)
    expect(JSON.stringify(sentMessages())).not.toContain('MEMORY')

    const failing = stubPorts({ recall: async () => Promise.reject(new Error('worker gone')) })
    await harness.close()
    harness = await startCompanionGateway(provider.baseURL, {}, { memoryPorts: failing })
    expect((await chat(identity('r2'), [CARD, user('Do you remember me?')])).response.status).toBe(200)
  })
})

describe('review of used items', () => {
  it('counts an item as used only when the answer repeats its distinctive words', () => {
    const items = [{ id: 'a', text: 'user_text: My favorite game is Hollow Knight' }, { id: 'b', text: 'The user is a nurse working nights' }]

    expect(usedItemIds(items, 'You must be playing Hollow Knight again!')).toEqual(['a'])
    expect(usedItemIds(items, 'Good morning!')).toEqual([])
  })
})

describe('memory administration and tools: authorization', () => {
  it('serves memory administration only with the ops token, and tools only with the inference token', async () => {
    harness = await startCompanionGateway(provider.baseURL)
    const base = harness.gateway.baseURL
    const status = (token?: string) => fetch(new URL('../ops/memory/status', base), { headers: token ? { authorization: `Bearer ${token}` } : {} })
    const tool = (token?: string, headers: Record<string, string> = {}) => fetch(new URL('companion/tools/memory_recall', base), { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: '{"query":"x"}' })

    expect((await status()).status).toBe(401)
    expect((await status(TEST_INFERENCE_TOKEN)).status).toBe(401)
    expect((await status(TEST_OPS_TOKEN)).status).toBe(200)
    expect((await tool()).status).toBe(401)
    expect((await tool(TEST_OPS_TOKEN)).status).toBe(401)
    expect((await tool(TEST_INFERENCE_TOKEN, { origin: 'http://evil.example' })).status).toBe(403)
    // No AIRI turn yet, so no character is bound.
    expect((await tool(TEST_INFERENCE_TOKEN)).status).toBe(409)
  })

  it('lets a browser preflight carry the AIRI turn identity headers', async () => {
    harness = await startCompanionGateway(provider.baseURL)
    const response = await fetch(new URL('chat/completions', harness.gateway.baseURL), {
      method: 'OPTIONS',
      headers: { 'origin': ALLOWED_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type, x-airi-session-id, x-airi-round-id, x-airi-character-id' },
    })
    expect(response.status).toBe(204)
  })

  it('inspects, edits, forgets, and exports through Ops, and holds new memory in private mode', async () => {
    harness = await startCompanionGateway(provider.baseURL)
    const ops = (path: string, body?: unknown) => fetch(new URL(`../ops/memory/${path}`, harness!.gateway.baseURL), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'authorization': `Bearer ${TEST_OPS_TOKEN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async response => ({ status: response.status, json: await response.json() as OpsBody }))
    await persist({ who: identity('r1'), userText: 'I grew up in Hokkaido', assistantText: 'Snowy and lovely.' })

    const items = (await ops('items?characterId=card-mura')).json.items!
    expect(items).toHaveLength(1)
    expect(items[0].provenance.map(source => source.source)).toEqual(['airi', 'airi'])
    expect((await ops('search', { characterId: 'card-mura', query: 'Hokkaido' })).json.items).toHaveLength(1)
    expect((await ops('items/edit', { itemId: items[0].id, pinned: true })).json.item?.pinned).toBe(true)
    expect((await ops('export')).json.format).toBe('companion-memory-v1')
    expect((await ops('backup', {})).json.ok).toBe(true)
    expect((await ops('items/forget', { itemId: items[0].id })).json.ok).toBe(true)
    expect((await ops('items?characterId=card-mura')).json.items).toHaveLength(0)

    await ops('private', { enabled: true })
    const results = await persist({ who: identity('r2'), userText: 'Secret plans for Saturday', assistantText: 'My lips are sealed.' })
    expect(results.map(result => result.status)).toEqual(['private', 'private'])
    expect((await ops('status')).json).toMatchObject({ enabled: true, userId: 'local-user' })
    expect((await ops('consolidate', {})).status).toBe(200)
  })
})

describe('mCP memory tools', () => {
  async function connect() {
    const server = createCompanionMcpServer({ baseURL: harness!.gateway.baseURL, token: TEST_INFERENCE_TOKEN })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(clientSide)
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[], isError?: boolean }
      return { isError: result.isError === true, body: JSON.parse(result.content[0].text) }
    }
    const close = async () => {
      await client.close()
      await server.close()
    }
    return { client, call, close }
  }

  it('lists the tools and remembers, recalls, and forgets for the active character, idempotently', async () => {
    harness = await startCompanionGateway(provider.baseURL)
    provider.setHandler(answers('ok'))
    const mcp = await connect()

    expect((await mcp.client.listTools()).tools.map(tool => tool.name)).toEqual(['memory_recall', 'memory_remember', 'memory_forget', 'look_now', 'watch_status', 'watch_listen'])
    expect((await mcp.call('memory_recall', { query: 'birthday' })).isError).toBe(true)

    await chat(identity('r1'), [CARD, user('My birthday is on March 3rd.')])
    const fact = { text: 'The user\'s birthday is March 3rd.', key: 'user.birthday', value: 'March 3', category: 'identity', scope: 'global' }
    const first = await mcp.call('memory_remember', fact)
    const repeated = await mcp.call('memory_remember', fact)
    expect(first.body.status).toBe('inserted')
    expect(repeated.body.status).toBe('duplicate')

    const recalled = await mcp.call('memory_recall', { query: 'birthday' })
    const stored = recalled.body.items.find((item: { kind: string }) => item.kind === 'fact')
    expect(stored).toMatchObject({ kind: 'fact', scope: 'global', text: 'The user\'s birthday is March 3rd.' })

    expect((await mcp.call('memory_forget', { itemId: '00000000-0000-0000-0000-000000000000' })).body.status).toBe('not-shown')
    expect((await mcp.call('memory_forget', { itemId: stored.id })).body.status).toBe('forgotten')
    // Forget removes the source event too, so the command's episode cannot bring the fact back.
    expect(JSON.stringify((await mcp.call('memory_recall', { query: 'birthday' })).body.items)).not.toContain('March 3rd')
    expect((await mcp.call('memory_remember', { ...fact, userId: 'someone-else' })).isError).toBe(true)
    await mcp.close()
  })
})
