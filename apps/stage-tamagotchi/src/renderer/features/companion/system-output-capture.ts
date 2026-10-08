import type { PcmBlock } from '@proj-airi/pipelines-audio'
import type { WebSocketBaseEvent, WebSocketEventOptionalSource, WebSocketEvents } from '@proj-airi/server-sdk'

import { encodeBase64 } from '@moeru/std/base64'
import { toWav } from '@proj-airi/audio/encoding'

/** Longest recording. The Companion Core asks for at most 8 s, and this provider never records longer. */
const MAX_DURATION_MS = 8000
/** A recording that produces no samples ends after its duration plus this margin. */
const STALL_MARGIN_MS = 2000

type CaptureRequest = WebSocketEvents['audio:system-output:capture:request']

/** The part of the stage's server channel that the provider uses. `useModsServerChannelStore` implements it. */
export interface CaptureChannel {
  readonly connected: boolean
  send: (event: WebSocketEventOptionalSource) => void
  onEvent: <E extends keyof WebSocketEvents>(type: E, callback: (event: WebSocketBaseEvent<E, WebSocketEvents[E]>) => void | Promise<void>) => () => void
}

/** What the provider needs of a stream: its tracks, so it can stop them. A MediaStream has them. */
export interface StoppableStream {
  getTracks: () => { stop: () => void }[]
}

/**
 * @param S The stream type of the audio source. @default MediaStream
 */
export interface SystemOutputCaptureOptions<S extends StoppableStream = MediaStream> {
  channel: CaptureChannel
  /** Opens system output audio, for example Electron's desktop loopback. It never opens the microphone. */
  openSystemOutput: () => Promise<S>
  /** Reads PCM blocks of the stream until `signal` aborts. The browser implementation uses an AudioWorklet. */
  openPcm: (stream: S, signal: AbortSignal) => ReadableStream<PcmBlock>
  now?: () => number
}

/**
 * Records one short segment of system output when a module asks for it over the server channel.
 *
 * Protocol: the provider registers as the one consumer of `audio:system-output:capture:request` and
 * `audio:system-output:capture:cancel`. Each request records at most 8 s, starting after the request arrived, and
 * answers with `audio:system-output:capture:result` routed to the requesting module only. A cancel or `stop` aborts the
 * recording and answers `cancelled` without audio. One recording runs at a time. A second request fails at once.
 *
 * Lifecycle: {@link SystemOutputCaptureProvider.start} registers the consumer and the listeners.
 * {@link SystemOutputCaptureProvider.stop} aborts the recording and removes them. Every recording stops its tracks
 * and zeroes its sample buffers, whatever the outcome.
 */
export class SystemOutputCaptureProvider<S extends StoppableStream = MediaStream> {
  private recording?: { requestId: string, controller: AbortController }
  private readonly unsubscribes: (() => void)[] = []
  private readonly now: () => number

  constructor(private readonly options: SystemOutputCaptureOptions<S>) {
    this.now = options.now ?? Date.now
  }

  start(): void {
    if (this.unsubscribes.length > 0)
      return
    const { channel } = this.options
    for (const event of ['audio:system-output:capture:request', 'audio:system-output:capture:cancel'])
      channel.send({ type: 'module:consumer:register', data: { event, mode: 'consumer' } })
    this.unsubscribes.push(
      channel.onEvent('audio:system-output:capture:request', event => this.record(event.data)),
      channel.onEvent('audio:system-output:capture:cancel', (event) => {
        if (this.recording?.requestId === event.data.requestId)
          this.recording.controller.abort()
      }),
    )
  }

  stop(): void {
    this.recording?.controller.abort()
    for (const unsubscribe of this.unsubscribes.splice(0))
      unsubscribe()
    if (!this.options.channel.connected)
      return
    for (const event of ['audio:system-output:capture:request', 'audio:system-output:capture:cancel'])
      this.options.channel.send({ type: 'module:consumer:unregister', data: { event, mode: 'consumer' } })
  }

  private async record(request: CaptureRequest): Promise<void> {
    if (this.recording) {
      this.reply(request, { status: 'failed' })
      return
    }
    const controller = new AbortController()
    this.recording = { requestId: request.requestId, controller }
    const durationMs = Math.max(0, Math.min(MAX_DURATION_MS, request.maxDurationMs))
    const stall = setTimeout(() => controller.abort(), durationMs + STALL_MARGIN_MS)
    const parts: Float32Array[] = []
    let stream: S | undefined
    try {
      stream = await this.options.openSystemOutput()
      controller.signal.throwIfAborted()
      // Recording starts here, after the request arrived, so the segment never holds earlier audio.
      const startedAt = this.now()
      const reader = this.options.openPcm(stream, controller.signal).getReader()
      let sampleRate = 0
      let frames = 0
      while (sampleRate === 0 || frames < durationMs * sampleRate / 1000) {
        const { done, value } = await reader.read()
        if (done)
          break
        sampleRate = value.sampleRate
        const wanted = Math.ceil(durationMs * sampleRate / 1000) - frames
        const mono = mixDown(value.channels, Math.min(wanted, value.channels[0].length))
        parts.push(mono)
        frames += mono.length
      }
      const endedAt = this.now()
      void reader.cancel().catch(() => {})
      controller.signal.throwIfAborted()
      if (frames === 0 || sampleRate === 0) {
        this.reply(request, { status: 'failed' })
        return
      }
      const samples = new Float32Array(frames)
      let offset = 0
      for (const part of parts) {
        samples.set(part, offset)
        offset += part.length
      }
      const wav = new Uint8Array(toWav(samples.buffer, sampleRate))
      samples.fill(0)
      const base64 = encodeBase64(wav)
      wav.fill(0)
      this.reply(request, { status: 'captured', audio: { mimeType: 'audio/wav', base64 }, startedAt, endedAt })
    }
    catch {
      this.reply(request, { status: controller.signal.aborted ? 'cancelled' : 'failed' })
    }
    finally {
      clearTimeout(stall)
      // Releases the PCM source and its audio graph, also after a normal end.
      controller.abort()
      for (const part of parts)
        part.fill(0)
      for (const track of stream?.getTracks() ?? [])
        track.stop()
      if (this.recording?.controller === controller)
        this.recording = undefined
    }
  }

  private reply(request: CaptureRequest, result: Omit<WebSocketEvents['audio:system-output:capture:result'], 'requestId'>): void {
    if (!this.options.channel.connected)
      return
    this.options.channel.send({
      type: 'audio:system-output:capture:result',
      data: { requestId: request.requestId, ...result },
      route: { destinations: [{ type: 'module', modules: [request.replyTo] }] },
    })
  }
}

/** Averages the channels of a block into one, for at most `length` frames. Recognition models take mono. */
function mixDown(channels: readonly Float32Array[], length: number): Float32Array {
  const mono = new Float32Array(Math.max(0, length))
  for (const channel of channels) {
    for (let i = 0; i < mono.length; i++)
      mono[i] += channel[i] / channels.length
  }
  return mono
}
