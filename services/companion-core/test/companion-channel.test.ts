import type { AddressInfo } from 'node:net'

import type { CompanionHarness } from './support/companion'

import { createServer as createNetServer } from 'node:net'

import { createServer } from '@proj-airi/server-runtime/server'
import { Client } from '@proj-airi/server-sdk'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { eventually, identityHeaders, startCompanionGateway } from './support/companion'
import { sse, startFakeProvider, writeEvents } from './support/harness'
import { filler, system, user } from './support/wire'

type Provider = Awaited<ReturnType<typeof startFakeProvider>>

let provider: Provider
let harness: CompanionHarness | undefined
let stage: Client | undefined
let channel: ReturnType<typeof createServer> | undefined

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise(resolve => server.close(resolve))
  return port
}

beforeAll(async () => {
  provider = await startFakeProvider()
})

afterEach(async () => {
  stage?.close()
  stage = undefined
  await harness?.close()
  harness = undefined
  await channel?.stop()
  channel = undefined
})

afterAll(async () => {
  await provider.close()
})

/**
 * The real AIRI server channel between a stage peer and the Core module. It proves that a stored turn reported by AIRI
 * reaches memory as authoritative evidence and merges with the gateway's provisional evidence.
 */
describe('server channel observer', () => {
  it('admits the stored AIRI turn as authoritative evidence and merges it with the gateway observation', async () => {
    const port = await freePort()
    channel = createServer({ hostname: '127.0.0.1', port })
    await channel.start()
    harness = await startCompanionGateway(provider.baseURL, { channel: { url: `ws://127.0.0.1:${port}/ws` } }, { channel: true })
    const memory = harness.companion.memory!
    await eventually(async () => memory.status().channelConnected, connected => connected)

    provider.setHandler((_req, res) => void writeEvents(res, [
      sse({ choices: [{ index: 0, delta: { content: 'Kyoto in autumn sounds perfect.' } }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      sse('[DONE]'),
    ]))
    const who = { sessionId: 'session-kyoto', roundId: 'user-msg-1', characterId: 'card-mura' }
    await fetch(new URL('chat/completions', harness.gateway.baseURL), {
      method: 'POST',
      headers: identityHeaders(who),
      body: JSON.stringify({ model: 'companion-chat', stream: true, messages: [system(filler(100, 'card')), user('I want to visit Kyoto in autumn')] }),
    }).then(response => response.text())

    stage = new Client({ url: `ws://127.0.0.1:${port}/ws`, name: 'stage-test', possibleEvents: ['output:gen-ai:chat:complete'] })
    await stage.ready()
    stage.send({
      type: 'output:gen-ai:chat:complete',
      data: {
        'message': { role: 'assistant', content: 'Kyoto in autumn sounds perfect.', slices: [], tool_results: [] },
        'turn': { sessionId: who.sessionId, turnId: who.roundId, assistantTurnId: 'assistant-turn-1', characterId: who.characterId },
        'toolCalls': [],
        'usage': { promptTokens: 0, completionTokens: 0, totalTokens: 0, source: 'estimate-based' },
        'gen-ai:chat': { message: { role: 'user', content: 'I want to visit Kyoto in autumn' }, contexts: {}, composedMessage: [] },
      },
    } as Parameters<Client['send']>[0])

    const tables = await eventually(
      async () => (await memory.ports.exportUser(memory.userId)).tables,
      current => current.events.length === 2 && current.events.every(event => event.authority === 'authoritative'),
    )
    expect(tables.events.map(event => event.canonical_id).sort()).toEqual(['airi:session-kyoto:msg:user-msg-1', 'airi:session-kyoto:turn:assistant-turn-1'])
    expect(tables.authority_windows.some(window => window.character_id === 'card-mura' && window.ended_at === null)).toBe(true)

    await channel.stop()
    channel = undefined
    await eventually(async () => memory.status().channelConnected, connected => !connected)
    await eventually(
      async () => (await memory.ports.exportUser(memory.userId)).tables.authority_windows,
      windows => windows.every(window => window.ended_at !== null),
    )
  })
})
