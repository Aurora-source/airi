import type { ScreenFrame, VisionObservationPort } from '../ports/contracts'

import { Buffer } from 'node:buffer'

import { PerceptionFailure } from '../ports/failure'
import { visionRequestBody } from './request'

export interface OpenAiVisionConfiguration {
  id: string
  locality: 'cloud' | 'local'
  base_url: string
  model: string
  api_key?: string
  /** @default false */
  structured_output?: boolean
  fetch?: typeof fetch
}

/** A configured OpenAI-compatible vision endpoint. It does not use, start, or discover a local model. */
export class OpenAiVisionAdapter implements VisionObservationPort {
  readonly id: string
  readonly locality: 'cloud' | 'local'
  readonly capabilities: { vision: boolean, structured_output: boolean }
  private readonly endpoint: URL
  private readonly configuration: OpenAiVisionConfiguration

  constructor(configuration: OpenAiVisionConfiguration) {
    this.configuration = { ...configuration }
    this.id = configuration.id
    this.locality = configuration.locality
    this.capabilities = { vision: true, structured_output: configuration.structured_output === true }
    const base = new URL(configuration.base_url)
    if (!base.pathname.endsWith('/'))
      throw new Error('Vision base URL requires a trailing slash')
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
    if (base.username || base.password || base.search || base.hash
      || (configuration.locality === 'local' && !loopback)
      || (configuration.locality === 'cloud' && base.protocol !== 'https:')
      || !['http:', 'https:'].includes(base.protocol)) {
      throw new Error('Invalid vision endpoint')
    }
    this.endpoint = new URL('chat/completions', base)
  }

  async observe(input: { frame: ScreenFrame, signal: AbortSignal }): Promise<unknown> {
    if (input.signal.aborted)
      throw new PerceptionFailure('cancelled')
    const response = await (this.configuration.fetch ?? fetch)(this.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: input.signal,
      headers: { 'content-type': 'application/json', ...(this.configuration.api_key ? { authorization: `Bearer ${this.configuration.api_key}` } : {}) },
      body: JSON.stringify(visionRequestBody(this.configuration.model, input.frame, this.capabilities.structured_output)),
    })
    if (!response.ok) {
      await response.body?.cancel()
      const header = response.headers.get('retry-after')
      const seconds = Number(header)
      const duration = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.parse(header ?? '') - Date.now()
      const retry = Number.isFinite(duration) && duration > 0 ? duration : 5000
      throw new PerceptionFailure(response.status === 429 ? 'rate-limited' : 'provider-error', retry)
    }
    const reader = response.body?.getReader()
    if (!reader)
      throw new PerceptionFailure('malformed')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done)
          break
        size += next.value.length
        if (size > 32768)
          throw new PerceptionFailure('malformed')
        chunks.push(next.value)
      }
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!raw || typeof raw !== 'object' || !('choices' in raw) || !Array.isArray(raw.choices))
        throw new PerceptionFailure('malformed')
      const message: unknown = raw.choices[0]?.message
      if (!message || typeof message !== 'object' || !('content' in message) || typeof message.content !== 'string')
        throw new PerceptionFailure('malformed')
      return message.content
    }
    catch { throw new PerceptionFailure('malformed') }
    finally {
      await reader.cancel()
      reader.releaseLock()
    }
  }
}
