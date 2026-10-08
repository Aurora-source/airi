import type { CompanionConfig } from '../config/config'
import type { SpeechRecognitionPort } from './contracts'

/**
 * Marks a transcription upload of system output. The gateway counts every other upload as user speech, which revokes
 * pending reactions. Only this in-process adapter sets it.
 */
export const SYSTEM_OUTPUT_AUDIO_HEADER = 'x-companion-audio-source'

/**
 * Calls R3's existing gateway audio capability with a configured speech-recognition alias.
 * The gateway retains provider selection, compute profile, quota, failover and credentials.
 * R6 adds no provider protocol, microphone controller or general STT routing system.
 */
export class GatewaySpeechRecognition implements SpeechRecognitionPort {
  private readonly endpoint: URL

  constructor(private readonly config: { base_url: string, alias: string, aliases: CompanionConfig['aliases'], token?: string, transport?: typeof fetch }) {
    const base = new URL(config.base_url)
    if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', '[::1]'].includes(base.hostname)
      || base.username || base.password || base.search || base.hash || base.pathname !== '/v1/'
      || config.aliases[config.alias]?.role !== 'speech-recognition') {
      throw new Error('Invalid watch speech-recognition gateway configuration')
    }
    this.endpoint = new URL('audio/transcriptions', base)
  }

  async transcribe(input: Parameters<SpeechRecognitionPort['transcribe']>[0]): Promise<string> {
    input.signal.throwIfAborted()
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(input.bytes)], { type: input.mime_type }), input.mime_type === 'audio/wav' ? 'segment.wav' : 'segment.webm')
    form.append('model', this.config.alias)
    form.append('language', input.language)
    form.append('response_format', 'json')
    const response = await (this.config.transport ?? fetch)(this.endpoint, {
      method: 'POST',
      body: form,
      signal: input.signal,
      headers: { [SYSTEM_OUTPUT_AUDIO_HEADER]: 'system-output', ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}) },
    })
    input.signal.throwIfAborted()
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error('Watch transcription unavailable')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    const abort = () => {
      void reader.cancel().catch(() => {})
    }
    input.signal.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        input.signal.throwIfAborted()
        const { done, value } = await reader.read()
        input.signal.throwIfAborted()
        if (done)
          break
        size += value.byteLength
        if (size > 16384) {
          await reader.cancel()
          throw new Error('Watch transcription response too large')
        }
        chunks.push(value)
      }
    }
    finally {
      input.signal.removeEventListener('abort', abort)
      reader.releaseLock()
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    let data: unknown
    try {
      data = JSON.parse(new TextDecoder().decode(bytes))
    }
    catch {
      throw new Error('Invalid watch transcription response')
    }
    finally {
      bytes.fill(0)
    }
    if (!data || typeof data !== 'object' || !('text' in data) || typeof data.text !== 'string' || data.text.length > 4000)
      throw new Error('Invalid watch transcription response')
    return data.text.slice(0, 320)
  }
}
