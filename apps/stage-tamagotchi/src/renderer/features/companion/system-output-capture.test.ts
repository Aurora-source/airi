import type { PcmBlock } from '@proj-airi/pipelines-audio'
import type { WebSocketBaseEvent, WebSocketEventOptionalSource, WebSocketEvents } from '@proj-airi/server-sdk'

import type { CaptureChannel } from './system-output-capture'

import { decodeBase64 } from '@moeru/std/base64'
import { describe, expect, it, vi } from 'vitest'

import { SystemOutputCaptureProvider } from './system-output-capture'

/** A stage server channel that records sends and lets the test deliver events. */
class FakeChannel implements CaptureChannel {
  connected = true
  readonly sent: WebSocketEventOptionalSource[] = []
  private readonly listeners = new Map<string, (event: unknown) => void>()

  send(event: WebSocketEventOptionalSource) {
    this.sent.push(event)
  }

  onEvent<E extends keyof WebSocketEvents>(type: E, callback: (event: WebSocketBaseEvent<E, WebSocketEvents[E]>) => void | Promise<void>) {
    this.listeners.set(type, event => void callback(event as WebSocketBaseEvent<E, WebSocketEvents[E]>))
    return () => this.listeners.delete(type)
  }

  deliver<E extends keyof WebSocketEvents>(type: E, data: WebSocketEvents[E]) {
    this.listeners.get(type)?.({ type, data })
  }

  results() {
    return this.sent.filter((event): event is Extract<WebSocketEventOptionalSource, { type: 'audio:system-output:capture:result' }> => event.type === 'audio:system-output:capture:result')
  }
}

/** A loopback stream whose tracks report `stop`. */
function fakeStream() {
  const track = { stop: vi.fn() }
  return { track, stream: { getTracks: () => [track] } }
}

/** Stereo PCM at 16 kHz, 100 ms per block, pushed by the test. */
function pcmPushSource() {
  let push!: (block: PcmBlock) => void
  let end!: () => void
  const blocks = new ReadableStream<PcmBlock>({ start(controller) {
    push = block => controller.enqueue(block)
    end = () => controller.close()
  } })
  const block = (startFrame: number): PcmBlock => ({ range: { sourceId: 'loopback', startFrame, endFrame: startFrame + 1600 }, sampleRate: 16_000, channels: [new Float32Array(1600).fill(0.5), new Float32Array(1600).fill(0.1)] })
  return { blocks, push: (startFrame: number) => push(block(startFrame)), end: () => end() }
}

async function flush() {
  for (let i = 0; i < 10; i++)
    await new Promise(resolve => setTimeout(resolve, 0))
}

describe('system output capture provider', () => {
  it('registers as consumer and answers one request with a mono WAV routed to the requester only', async () => {
    const channel = new FakeChannel()
    const { stream, track } = fakeStream()
    const pcm = pcmPushSource()
    let clock = 1000
    const provider = new SystemOutputCaptureProvider({ channel, openSystemOutput: async () => stream, openPcm: () => pcm.blocks, now: () => clock })
    provider.start()
    expect(channel.sent.map(event => event.type)).toEqual(['module:consumer:register', 'module:consumer:register'])

    channel.deliver('audio:system-output:capture:request', { requestId: 'r1', maxDurationMs: 300, replyTo: 'companion-core-watch' })
    await flush()
    clock = 1300
    for (const startFrame of [0, 1600, 3200, 4800])
      pcm.push(startFrame)
    await flush()

    const [result] = channel.results()
    expect(result.route).toEqual({ destinations: [{ type: 'module', modules: ['companion-core-watch'] }] })
    expect(result.data).toMatchObject({ requestId: 'r1', status: 'captured', startedAt: 1000, endedAt: 1300 })
    const wav = decodeBase64(result.data.audio!.base64)
    // 300 ms at 16 kHz mono 16-bit, plus the 44 byte header.
    expect(wav.byteLength).toBe(44 + 4800 * 2)
    expect(new DataView(wav.buffer, wav.byteOffset).getUint16(22, true)).toBe(1)
    expect(track.stop).toHaveBeenCalled()
  })

  it('answers cancelled without audio when the requester cancels, and fails a second request while one records', async () => {
    const channel = new FakeChannel()
    const { stream, track } = fakeStream()
    const pcm = pcmPushSource()
    const provider = new SystemOutputCaptureProvider({ channel, openSystemOutput: async () => stream, openPcm: (_stream, signal) => {
      signal.addEventListener('abort', () => pcm.end(), { once: true })
      return pcm.blocks
    } })
    provider.start()

    channel.deliver('audio:system-output:capture:request', { requestId: 'r1', maxDurationMs: 8000, replyTo: 'companion-core-watch' })
    await flush()
    channel.deliver('audio:system-output:capture:request', { requestId: 'r2', maxDurationMs: 8000, replyTo: 'companion-core-watch' })
    pcm.push(0)
    channel.deliver('audio:system-output:capture:cancel', { requestId: 'r1' })
    await flush()

    expect(channel.results().map(result => [result.data.requestId, result.data.status, result.data.audio])).toEqual([['r2', 'failed', undefined], ['r1', 'cancelled', undefined]])
    expect(track.stop).toHaveBeenCalled()
  })

  it('never records longer than 8 s, whatever the request asks', async () => {
    const channel = new FakeChannel()
    const { stream } = fakeStream()
    const pcm = pcmPushSource()
    const provider = new SystemOutputCaptureProvider({ channel, openSystemOutput: async () => stream, openPcm: () => pcm.blocks })
    provider.start()
    channel.deliver('audio:system-output:capture:request', { requestId: 'long', maxDurationMs: 60_000, replyTo: 'companion-core-watch' })
    await flush()
    for (let frame = 0; frame < 16_000 * 9; frame += 1600)
      pcm.push(frame)
    await flush()

    const wav = decodeBase64(channel.results()[0].data.audio!.base64)
    expect(wav.byteLength).toBe(44 + 16_000 * 8 * 2)
  })
})
