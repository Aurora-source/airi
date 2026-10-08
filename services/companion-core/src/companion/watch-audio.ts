import type { WebSocketEventOptionalSource } from '@proj-airi/server-sdk'

import type { SystemAudioPort } from '../watch'

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'

import * as v from 'valibot'

/** Base64 of 8 s of 16 kHz mono 16-bit WAV is about 342 kB. A larger answer is refused before decoding. */
const MAX_BASE64_LENGTH = 400_000

const resultSchema = v.object({
  requestId: v.string(),
  status: v.picklist(['captured', 'failed', 'cancelled']),
  audio: v.optional(v.object({ mimeType: v.literal('audio/wav'), base64: v.pipe(v.string(), v.maxLength(MAX_BASE64_LENGTH)) })),
  startedAt: v.optional(v.pipe(v.number(), v.finite())),
  endedAt: v.optional(v.pipe(v.number(), v.finite())),
})

type Segment = Awaited<ReturnType<SystemAudioPort['capture']>>

interface Pending {
  resolve: (segment: Segment) => void
  reject: (error: Error) => void
}

/**
 * Records system audio output through AIRI desktop, over the server channel. The microphone is never used.
 *
 * Protocol, correlated by `requestId`:
 * - `audio:system-output:capture:request` goes to the one module that registered as its consumer (AIRI desktop).
 *   Its event id is the request id, so a "no consumer" error names the request.
 * - `audio:system-output:capture:result` comes back to {@link ChannelSystemAudioPort} only, through the `replyTo`
 *   route. A result for an unknown or abandoned request is dropped before its audio is decoded.
 * - An abort sends `audio:system-output:capture:cancel`. The provider discards that recording.
 *
 * The decoded buffer belongs to the caller. The watch fallback zeroes it after recognition or cancellation.
 */
export class ChannelSystemAudioPort implements SystemAudioPort {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly options: { send: (event: WebSocketEventOptionalSource) => boolean, replyTo: string }) {}

  capture(input: Parameters<SystemAudioPort['capture']>[0]): Promise<Segment> {
    input.signal.throwIfAborted()
    const requestId = randomUUID()
    return new Promise<Segment>((resolve, reject) => {
      const abort = () => {
        // A request that already settled has nothing left to cancel.
        if (!this.pending.delete(requestId))
          return
        this.options.send({ type: 'audio:system-output:capture:cancel', data: { requestId } })
        reject(new Error('System audio capture cancelled'))
      }
      const settle = () => {
        this.pending.delete(requestId)
        input.signal.removeEventListener('abort', abort)
      }
      input.signal.addEventListener('abort', abort, { once: true })
      this.pending.set(requestId, {
        resolve: (segment) => {
          settle()
          resolve(segment)
        },
        reject: (error) => {
          settle()
          reject(error)
        },
      })
      const sent = this.options.send({
        type: 'audio:system-output:capture:request',
        data: { requestId, maxDurationMs: input.max_duration_ms, replyTo: this.options.replyTo },
        metadata: { event: { id: requestId } },
      })
      if (!sent)
        this.pending.get(requestId)?.reject(new Error('Server channel unavailable'))
    })
  }

  /** Handles one result event. */
  receive(data: unknown): void {
    const parsed = v.safeParse(resultSchema, data)
    if (!parsed.success)
      return
    const result = parsed.output
    const entry = this.pending.get(result.requestId)
    // An unknown id is late, cancelled, or foreign. Its audio is never decoded.
    if (!entry)
      return
    if (result.status !== 'captured' || !result.audio || result.startedAt === undefined || result.endedAt === undefined || result.endedAt <= result.startedAt) {
      entry.reject(new Error(`System audio capture ${result.status}`))
      return
    }
    const buffer = Buffer.from(result.audio.base64, 'base64')
    entry.resolve({
      bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      mime_type: 'audio/wav',
      captured_at: result.endedAt,
      duration_ms: result.endedAt - result.startedAt,
    })
  }

  /** The server reported an error for one request, for example because no provider registered as consumer. */
  fail(requestId: string): void {
    this.pending.get(requestId)?.reject(new Error('System audio provider unavailable'))
  }

  /** Rejects every pending capture. The channel dropped or the owner shut down. */
  shutdown(): void {
    for (const entry of [...this.pending.values()])
      entry.reject(new Error('System audio capture stopped'))
  }
}
