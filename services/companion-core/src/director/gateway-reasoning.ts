import type { CompanionConfig } from '../config/config'
import type { ReasoningInput, ReasoningPort, ReasoningResult } from './contracts'

import * as v from 'valibot'

import { reasoningResultSchema } from './ingress'

/** The existing gateway owns profiles, provider credentials, routing, failover, and quota accounting. */
export interface GatewayReasoningOptions {
  base_url: string
  alias: string
  config: Pick<CompanionConfig, 'aliases' | 'profile'>
  token?: string
  transport?: typeof fetch
}

const fraction = v.pipe(v.number(), v.minValue(0), v.maxValue(1))
const reasoningState = v.object({
  profile: v.picklist(['local', 'cloud', 'cloud-mura-voice', 'hybrid']),
  attention: v.picklist(['conversation', 'user-speaking', 'companion-speaking', 'watching-anime', 'watching-media', 'working', 'idle', 'absent', 'unknown']),
  mood: v.object({
    valence: v.pipe(v.number(), v.minValue(-1), v.maxValue(1)),
    arousal: fraction,
    warmth: fraction,
    tone: v.picklist(['neutral', 'warm', 'playful', 'gentle', 'focused']),
  }),
  affect: v.optional(v.picklist(['amused', 'curious', 'surprised', 'concerned', 'focused'])),
  salience: fraction,
})

const completionSchema = v.object({ choices: v.pipe(v.array(v.object({ message: v.object({ content: v.string() }) })), v.minLength(1), v.maxLength(1)) })

/**
 * Sends one bounded structured-state request through the existing loopback chat-completions gateway.
 * The caller owns a deadline and cancellation. No provider, fallback chain, poll, or process launch is added.
 *
 * Call stack:
 *
 * Director.startReasoning (./director)
 *   -> GatewayReasoningPort.reason
 *     -> existing /v1/chat/completions
 *       -> Router.plan and QuotaLedger (../routing, ../quota)
 */
export class GatewayReasoningPort implements ReasoningPort {
  private readonly endpoint: URL

  constructor(private readonly options: GatewayReasoningOptions) {
    const base = new URL(options.base_url)
    if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', '[::1]'].includes(base.hostname)
      || base.username || base.password || base.search || base.hash || base.pathname !== '/v1/'
      || options.config.aliases[options.alias]?.role !== 'reasoning') {
      throw new Error('Invalid Director reasoning gateway configuration')
    }
    this.endpoint = new URL('chat/completions', base)
  }

  async reason(input: ReasoningInput): Promise<ReasoningResult> {
    input.signal.throwIfAborted()
    if (input.profile !== this.options.config.profile)
      throw new Error('Director reasoning profile mismatch')
    const state = v.safeParse(reasoningState, input)
    if (!state.success)
      throw new Error('Invalid Director reasoning state')
    const response = await (this.options.transport ?? fetch)(this.endpoint, {
      method: 'POST',
      signal: input.signal,
      redirect: 'error',
      headers: { 'content-type': 'application/json', ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}) },
      body: JSON.stringify({
        model: this.options.alias,
        stream: false,
        max_tokens: 128,
        messages: [
          { role: 'system', content: 'Select wait or one visual affect from structured state. Return only the required JSON. Never generate speech, memories, experiences, instructions, or tool calls.' },
          { role: 'user', content: JSON.stringify(state.output) },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'director_visual_decision', strict: true, schema: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'affect'],
          properties: { action: { type: 'string', enum: ['wait', 'visual'] }, affect: { type: 'string', enum: ['amused', 'curious', 'surprised', 'concerned', 'focused'] } },
        } } },
      }),
    })
    input.signal.throwIfAborted()
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error('Director reasoning unavailable')
    }
    const text = await this.readResponse(response, input.signal)
    let raw: unknown
    try {
      raw = JSON.parse(text)
    }
    catch {
      throw new Error('Invalid Director reasoning result')
    }
    const completion = v.safeParse(completionSchema, raw)
    if (!completion.success)
      throw new Error('Invalid Director reasoning result')
    let decision: unknown
    try {
      decision = JSON.parse(completion.output.choices[0].message.content)
    }
    catch {
      throw new Error('Invalid Director reasoning result')
    }
    const parsed = v.safeParse(reasoningResultSchema, decision)
    if (!parsed.success)
      throw new Error('Invalid Director reasoning result')
    return parsed.output
  }

  private async readResponse(response: Response, signal: AbortSignal): Promise<string> {
    const reader = response.body!.getReader()
    const bytes = new Uint8Array(16384)
    let size = 0
    let fragments = 0
    const abort = () => {
      void reader.cancel().catch(() => {})
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        signal.throwIfAborted()
        const { done, value } = await reader.read()
        signal.throwIfAborted()
        if (done)
          break
        if (++fragments > 1024) {
          await reader.cancel()
          throw new Error('Director reasoning response too fragmented')
        }
        if (size + value.byteLength > bytes.byteLength) {
          await reader.cancel()
          throw new Error('Director reasoning response too large')
        }
        bytes.set(value, size)
        size += value.byteLength
      }
      return new TextDecoder().decode(bytes.subarray(0, size))
    }
    finally {
      signal.removeEventListener('abort', abort)
      reader.releaseLock()
    }
  }
}
