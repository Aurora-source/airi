import type { AddressInfo } from 'node:net'

import type { CompanionHarness } from './support/companion'

import { Buffer } from 'node:buffer'
import { createServer as createNetServer } from 'node:net'

import { createServer } from '@proj-airi/server-runtime/server'
import { Client } from '@proj-airi/server-sdk'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createClientState, disconnectClient, ensureClient, handleSubtitle, handleVideoContext } from '../../../plugins/airi-plugin-web-extension/src/background/client'
import { DEFAULT_SETTINGS } from '../../../plugins/airi-plugin-web-extension/src/shared/constants'
import { ObservationStamper } from '../../../plugins/airi-plugin-web-extension/src/shared/observation-stamp'
import { WATCH_MODULE } from '../src/companion/watch'
import { eventually, startCompanionGateway } from './support/companion'
import { authHeaders, sse, startFakeProvider, TEST_OPS_TOKEN, writeEvents } from './support/harness'

type Provider = Awaited<ReturnType<typeof startFakeProvider>>

let provider: Provider
let harness: CompanionHarness | undefined
let channel: ReturnType<typeof createServer> | undefined
const peers: Client[] = []
let clock = Date.now()
const now = () => clock

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise(resolve => server.close(resolve))
  return port
}

beforeAll(async () => {
  provider = await startFakeProvider()
  provider.setHandler((req, res) => {
    if (req.url?.endsWith('/audio/transcriptions')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: 'Over here!' }))
      return
    }
    void writeEvents(res, [sse({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }), sse('[DONE]')])
  })
})

afterEach(async () => {
  for (const peer of peers.splice(0))
    peer.close()
  await harness?.close()
  harness = undefined
  await channel?.stop()
  channel = undefined
})

afterAll(async () => {
  await provider.close()
})

async function ops(path: string) {
  const response = await fetch(new URL(`../ops/${path}`, harness!.gateway.baseURL), { headers: { authorization: `Bearer ${TEST_OPS_TOKEN}` } })
  return await response.json() as Record<string, any>
}

async function watchStatus() {
  const response = await fetch(new URL('companion/tools/watch_status', harness!.gateway.baseURL), { method: 'POST', headers: authHeaders(), body: '{}' })
  return await response.json() as Record<string, any>
}

async function peer(name: string, possibleEvents: ConstructorParameters<typeof Client>[0]['possibleEvents'], url: string): Promise<Client> {
  const client = new Client({ url, name, possibleEvents })
  peers.push(client)
  await client.ready()
  return client
}

/**
 * The real AIRI server channel between the real extension background code and the Core.
 * It proves the stamp contract, session ends on disconnect and reconnect, targeted reaction and audio delivery, and
 * the voice activity signal, over the transport that production uses.
 */
describe('watch over the AIRI server channel', () => {
  it('follows the real extension, delivers reactions and audio only to their targets, and survives reconnects', async () => {
    const port = await freePort()
    const url = `ws://127.0.0.1:${port}/ws`
    channel = createServer({ hostname: '127.0.0.1', port })
    await channel.start()
    harness = await startCompanionGateway(provider.baseURL, {
      channel: { url },
      models: {
        'fake-model': { provider: 'fake', model: 'real-model-1', capabilities: { contextWindow: 128_000 } },
        'stt-model': { provider: 'fake', model: 'whisper-1', capabilities: { contextWindow: 448 } },
      },
      aliases: { 'companion-chat': { chain: ['fake-model'] }, 'companion-stt': { role: 'speech-recognition', chain: ['stt-model'] } },
      watch: { systemAudio: { enabled: true } },
    }, { channel: true, now })
    await eventually(ops.bind(null, 'watch/status'), status => status.channelConnected === true)

    // The stage turns Spark notifications into speech and reports voice activity. It also provides system audio.
    const stage = await peer('proj-airi:stage-tamagotchi', ['spark:notify', 'input:voice:activity', 'audio:system-output:capture:result'], url)
    const sparks: unknown[] = []
    stage.onEvent('spark:notify', event => void sparks.push(event.data))
    stage.send({ type: 'module:consumer:register', data: { event: 'audio:system-output:capture:request', mode: 'consumer' } })
    stage.onEvent('audio:system-output:capture:request', (event) => {
      const startedAt = clock
      clock += 2000
      const wav = Buffer.from([82, 73, 70, 70, 4, 3, 2, 1]).toString('base64')
      stage.send({
        type: 'audio:system-output:capture:result',
        data: { requestId: event.data.requestId, status: 'captured', audio: { mimeType: 'audio/wav', base64: wav }, startedAt, endedAt: clock },
        route: { destinations: [{ type: 'module', modules: [event.data.replyTo] }] },
      })
    })

    // The real background client and the real content stamper.
    const state = createClientState()
    const settings = { ...DEFAULT_SETTINGS, wsUrl: url, sendSparkNotify: false }
    await ensureClient(state, settings)
    const extensionSaw: string[] = []
    state.client!.onEvent('spark:notify', () => void extensionSaw.push('spark:notify'))
    state.client!.onEvent('audio:system-output:capture:result', () => void extensionSaw.push('audio'))
    const stamper = new ObservationStamper(now)
    const page = { site: 'youtube' as const, url: 'https://www.youtube.com/watch?v=frieren3', videoId: 'frieren3', title: 'Frieren Episode 3' }
    const video = (fields: { isPlaying: boolean, currentTimeSec: number, isEnded?: boolean }) => handleVideoContext(state, settings, { ...page, durationSec: 1420, ...fields }, { notify: false, stamp: stamper.stamp(page.site, page.url) })
    const subtitle = (text: string) => handleSubtitle(state, settings, { ...page, text, language: 'en' }, stamper.stamp(page.site, page.url))

    // A: a stamped video event becomes fresh watch state.
    video({ isPlaying: true, currentTimeSec: 10 })
    expect((await eventually(watchStatus, status => status.status === 'watching')).title.text).toBe('Frieren Episode 3')
    const firstSession = (await ops('watch/status')).session.id

    // B: captions progress through the channel.
    subtitle('First line')
    subtitle('Second line')
    expect((await eventually(watchStatus, status => status.dialogue?.text === 'Second line')).dialogue.source).toBe('subtitle')

    // Conditional STT: 31 s of captionless playback is impossible here because captions arrived, so audio is suppressed.
    expect(await (await fetch(new URL('companion/tools/watch_listen', harness.gateway.baseURL), { method: 'POST', headers: authHeaders(), body: '{}' })).json()).toMatchObject({ status: 'suppressed' })

    // D: a pause proves a gap. The reaction reaches the stage only.
    clock += 1000
    video({ isPlaying: false, currentTimeSec: 12 })
    await eventually(watchStatus, status => status.playback === 'paused')
    expect(harness.companion.watch!.offerReaction({ kind: 'pause', observation_key: 'campfire-pause', salience: 0.9 })).toBe(true)
    clock += 2000
    await eventually(async () => sparks.length, count => count === 1, 5000)
    expect(sparks[0]).toMatchObject({ kind: 'ping', urgency: 'immediate', destinations: ['character'], payload: { watch: { title: { text: 'Frieren Episode 3' } } } })

    // E: the stage reports user speech, and Watch stops at once.
    stage.send({ type: 'input:voice:activity', data: { active: true, inputId: 'voice-1' } })
    await eventually(ops.bind(null, 'watch/status'), status => status.userSpeaking === true)
    stage.send({ type: 'input:voice:activity', data: { active: false, inputId: 'voice-1' } })
    await eventually(ops.bind(null, 'watch/status'), status => status.userSpeaking === false)

    // System audio: a new captionless media plays 31 s, then one targeted segment comes back and goes through R3.
    const quiet = { site: 'youtube' as const, url: 'https://www.youtube.com/watch?v=quiet', videoId: 'quiet', title: 'A quiet documentary' }
    const quietVideo = (currentTimeSec: number) => handleVideoContext(state, settings, { ...quiet, isPlaying: true, currentTimeSec }, { notify: false, stamp: stamper.stamp(quiet.site, quiet.url) })
    quietVideo(0)
    await eventually(watchStatus, status => status.title?.text === 'A quiet documentary')
    for (const position of [15, 30]) {
      clock += 15_000
      quietVideo(position)
      await eventually(watchStatus, status => status.position?.seconds === position)
    }
    clock += 1000
    const listened = await (await fetch(new URL('companion/tools/watch_listen', harness.gateway.baseURL), { method: 'POST', headers: authHeaders(), body: '{}' })).json() as Record<string, any>
    expect(listened).toMatchObject({ status: 'transcribed', language: 'en', dialogue: { text: 'Over here!' } })
    expect(extensionSaw).toEqual([])

    // H: an explicit disconnect ends the session. A new connection starts another one.
    disconnectClient(state)
    await eventually(watchStatus, status => status.status === 'idle')
    expect((await ops('watch/status')).counters.sessionsEnded['producer-gone']).toBe(1)
    await ensureClient(state, settings)
    video({ isPlaying: true, currentTimeSec: 40 })
    await eventually(watchStatus, status => status.status === 'watching' && status.title?.text === 'Frieren Episode 3')
    expect((await ops('watch/status')).session.id).not.toBe(firstSession)

    // An automatic reconnect after a server restart gets a new connection id and keeps sending.
    const before = state.connection
    await channel.stop()
    await eventually(watchStatus, status => status.status === 'idle', 8000)
    await channel.start()
    await eventually(async () => state.connected && state.connection !== before, ready => ready, 20_000)
    await eventually(ops.bind(null, 'watch/status'), status => status.channelConnected === true, 20_000)
    video({ isPlaying: true, currentTimeSec: 45 })
    await eventually(watchStatus, status => status.status === 'watching', 8000)
    expect((await ops('watch/status')).counters.sessionsEnded['channel-lost']).toBeGreaterThanOrEqual(1)
    expect(WATCH_MODULE).toBe('companion-core-watch')
  }, 60_000)

  // The background replaces its client when the settings change. A real Chromium run showed the replaced client's
  // late connect() failure marking the new connection closed. Node settles that promise in another order, so this test
  // checks the observable behavior only. eval/watch/live-extension.mts reproduces the browser case.
  it('keeps sending after a settings change replaced a connecting client', async () => {
    const port = await freePort()
    const url = `ws://127.0.0.1:${port}/ws`
    channel = createServer({ hostname: '127.0.0.1', port })
    await channel.start()
    harness = await startCompanionGateway(provider.baseURL, { channel: { url } }, { channel: true })
    await eventually(ops.bind(null, 'watch/status'), status => status.channelConnected === true)

    // A server that accepts but never answers the handshake, so the first client still waits in connect().
    const silent = createNetServer(socket => void socket.on('error', () => {}))
    await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve))
    const silentPort = (silent.address() as AddressInfo).port
    const state = createClientState()
    void ensureClient(state, { ...DEFAULT_SETTINGS, wsUrl: `ws://127.0.0.1:${silentPort}/ws` })
    await new Promise(resolve => setTimeout(resolve, 200))
    // What the background does when the settings change.
    state.client?.close()
    state.client = null
    state.connected = false
    const settings = { ...DEFAULT_SETTINGS, wsUrl: url, sendSparkNotify: false }
    await ensureClient(state, settings)
    await new Promise(resolve => setTimeout(resolve, 500))

    expect(state.connected).toBe(true)
    const stamper = new ObservationStamper()
    const page = { site: 'youtube' as const, url: 'https://www.youtube.com/watch?v=race', videoId: 'race', title: 'Race Episode 1' }
    handleVideoContext(state, settings, { ...page, isPlaying: true, currentTimeSec: 1 }, { notify: false, stamp: stamper.stamp(page.site, page.url) })
    expect((await eventually(watchStatus, status => status.status === 'watching')).title.text).toBe('Race Episode 1')
    disconnectClient(state)
    silent.close()
  }, 40_000)
})
