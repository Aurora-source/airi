import type { TurnIdentity } from '../src/companion/turn-identity'
import type { CompanionHarness } from './support/companion'
import type { ProviderHandler } from './support/harness'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { eventually, identityHeaders, startCompanionGateway } from './support/companion'
import { sse, startFakeProvider, TEST_INFERENCE_TOKEN, TEST_OPS_TOKEN, writeEvents } from './support/harness'
import { FakeStage } from './support/stage'
import { FakeChannel } from './support/watch'

type Provider = Awaited<ReturnType<typeof startFakeProvider>>

let provider: Provider
let harness: CompanionHarness | undefined
let stage: FakeStage
let watchChannel: FakeChannel

/** Answers with a tool call first when the request has no tool result yet and tools are offered. */
const route: ProviderHandler = (_req, res, received) => {
  const parsed = JSON.parse(received.body) as { tools?: unknown[], messages: { role: string }[] }
  const wantsTool = Array.isArray(parsed.tools) && parsed.tools.length > 0 && parsed.messages.at(-1)?.role !== 'tool'
  void writeEvents(res, wantsTool
    ? [
        sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] } }] }),
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        sse('[DONE]'),
      ]
    : [
        sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Here is my answer.' } }] }),
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        sse('[DONE]'),
      ])
}

beforeAll(async () => {
  provider = await startFakeProvider()
  provider.setHandler(route)
})

beforeEach(() => {
  stage = new FakeStage()
  watchChannel = new FakeChannel()
})

afterEach(async () => {
  await harness?.close()
  harness = undefined
  provider.requests.length = 0
})

afterAll(async () => {
  await provider.close()
})

async function start(raw: Record<string, unknown> = {}) {
  harness = await startCompanionGateway(provider.baseURL, raw, { watchPorts: { createClient: watchChannel.connect }, directorPorts: { createClient: stage.channel.connect } })
  watchChannel.ready(true)
  stage.ready()
  return harness
}

function identity(roundId: string, characterId = 'card-mura'): TurnIdentity {
  return { sessionId: 'session-1', roundId, characterId }
}

async function chat(who: TurnIdentity, messages: unknown[], tools?: unknown[]) {
  const response = await fetch(new URL('chat/completions', harness!.gateway.baseURL), {
    method: 'POST',
    headers: identityHeaders(who),
    body: JSON.stringify({ model: 'companion-chat', stream: true, messages, ...(tools ? { tools } : {}) }),
  })
  return { status: response.status, text: await response.text() }
}

async function ops(path: string, body?: unknown, token = TEST_OPS_TOKEN) {
  const response = await fetch(new URL(`../ops/${path}`, harness!.gateway.baseURL), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, any> }
}

const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }]

describe('director in the real gateway', () => {
  it('answers one user request once across a tool round, with the Director attached to that answer', async () => {
    await start()
    const who = identity('round-1')
    const first = await chat(who, [{ role: 'user', content: 'Look it up please' }], tools)
    expect(first.text).toContain('tool_calls')
    const second = await chat(who, [
      { role: 'user', content: 'Look it up please' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'found' },
    ], tools)
    expect(second.text).toContain('Here is my answer.')
    expect(provider.requests.filter(request => request.url.endsWith('/chat/completions'))).toHaveLength(2)

    const status = await eventually(async () => (await ops('director/status')).body, body => body.conversation.attached === 0 && body.director.resources.inFlightOutput === 0)
    expect(status.director.metrics.speechAttempts).toBe(1)
    expect(status.conversation.requests).toBe(1)
    // The Director never asked the stage for a second answer.
    expect(stage.notifies).toHaveLength(0)
  })

  it('serves status without identities or text, and takes controls only with the ops token', async () => {
    await start()
    await chat(identity('round-1'), [{ role: 'user', content: 'My secret plan is private' }])
    const status = await ops('director/status')
    expect(status.status).toBe(200)
    const visible = JSON.stringify(status.body)
    expect(visible).not.toContain('secret plan')
    expect(visible).not.toContain('card-mura')
    expect(visible).not.toContain('session-1')
    expect(status.body.director.configuration.proactiveSpeech).toBe(false)

    expect((await ops('director/configure', { proactiveSpeech: true }, TEST_INFERENCE_TOKEN)).status).toBe(401)
    expect((await ops('director/configure', { proactiveSpeech: 'yes' })).status).toBe(400)
    expect((await ops('director/configure', { proactiveSpeech: true, quietPeriods: [{ startMinute: 1380, endMinute: 60 }] })).status).toBe(200)
    expect((await ops('director/status')).body.director.configuration).toMatchObject({ proactiveSpeech: true, quietPeriods: [{ startMinute: 1380, endMinute: 60 }] })
    expect((await ops('director/activity', { activity: 'working' })).status).toBe(200)
    expect((await ops('director/status')).body.director.attention).toMatchObject({ activity: 'working', source: 'user-declared' })
    expect((await ops('director/cancel', {})).status).toBe(200)
  })

  it('keeps normal chat unchanged with the Director disabled', async () => {
    await start({ director: { enabled: false } })
    const answer = await chat(identity('round-1'), [{ role: 'user', content: 'Hello' }])
    expect(answer.status).toBe(200)
    expect(answer.text).toContain('Here is my answer.')
    expect(harness!.companion.director).toBeUndefined()
    expect((await ops('director/status')).body).toEqual({ enabled: false })
    expect((await ops('director/configure', { quietMode: true })).status).toBe(503)
  })
})
