import { describe, expect, it } from 'vitest'

import { resolveAudioRoutes } from '../src/audio/audio-config'
import { parseConfig } from '../src/config/config'

/** Groq reports a 448-token context for its Whisper models. Speech recognition ignores the value. */
const WHISPER = { contextWindow: 448, streaming: false, tools: false }

function config(input: { profile?: string, local?: string, chain?: string[], audio?: { timeoutMs?: number, maxRequestBytes?: number, maxResponseBytes?: number } } = {}) {
  return parseConfig({
    profile: input.profile ?? 'cloud-mura-voice',
    audio: input.audio,
    providers: {
      groq: { baseURL: 'https://api.groq.com/openai/v1/', keyRef: 'provider-groq' },
      ...(input.local ? { 'local-stt': { baseURL: input.local, locality: 'local' } } : {}),
    },
    models: {
      'groq-whisper-turbo': { provider: 'groq', model: 'whisper-large-v3-turbo', capabilities: WHISPER },
      'groq-whisper': { provider: 'groq', model: 'whisper-large-v3', capabilities: WHISPER },
      ...(input.local ? { 'local-whisper': { provider: 'local-stt', model: 'explicit-local-model', capabilities: WHISPER } } : {}),
      'chat-model': { provider: 'groq', model: 'openai/gpt-oss-120b', capabilities: { contextWindow: 131_072 } },
    },
    aliases: {
      'companion-chat': { chain: ['chat-model'] },
      'companion-stt': { role: 'speech-recognition', chain: input.chain ?? ['groq-whisper-turbo', 'groq-whisper'] },
    },
  })
}

describe('audio routes', () => {
  it('reads each speech-recognition alias chain from the R2B configuration', () => {
    const routes = resolveAudioRoutes(config())!

    expect([...routes.aliases.keys()]).toEqual(['companion-stt'])
    expect(routes.aliases.get('companion-stt')!.map(model => ({ id: model.id, url: model.url.href, model: model.model, keyRef: model.keyRef, locality: model.locality }))).toEqual([
      { id: 'groq-whisper-turbo', url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo', keyRef: 'provider-groq', locality: 'cloud' },
      { id: 'groq-whisper', url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3', keyRef: 'provider-groq', locality: 'cloud' },
    ])
    expect(routes.limits).toEqual({ maxRequestBytes: 25 * 1024 * 1024, maxResponseBytes: 1024 * 1024, timeoutMs: 15_000 })
  })

  it('disables audio when no alias has the speech-recognition role', () => {
    const plain = parseConfig({
      providers: { groq: { baseURL: 'https://api.groq.com/openai/v1/', keyRef: 'provider-groq' } },
      models: { 'chat-model': { provider: 'groq', model: 'openai/gpt-oss-120b', capabilities: { contextWindow: 131_072 } } },
      aliases: { 'companion-chat': { chain: ['chat-model'] } },
    })

    expect(resolveAudioRoutes(plain)).toBeUndefined()
  })

  it.each(['cloud', 'cloud-mura-voice'])('rejects a local speech model in the %s profile', (profile) => {
    expect(() => config({ profile, local: 'http://127.0.0.1:11437/v1/', chain: ['groq-whisper-turbo', 'local-whisper'] })).toThrow('does not allow the local model "local-whisper"')
  })

  it('keeps a hybrid local speech model behind every cloud model', () => {
    expect(() => config({ profile: 'hybrid', local: 'http://127.0.0.1:11437/v1/', chain: ['local-whisper', 'groq-whisper-turbo'] })).toThrow('must come after every cloud model')

    const routes = resolveAudioRoutes(config({ profile: 'hybrid', local: 'http://127.0.0.1:11437/v1/', chain: ['groq-whisper-turbo', 'local-whisper'] }))!

    expect(routes.aliases.get('companion-stt')!.map(model => model.locality)).toEqual(['cloud', 'local'])
  })

  it.each(['http://192.168.1.1/v1/', 'http://169.254.169.254/v1/', 'http://localhost/v1/', 'https://attacker.example/v1/', 'http://127.0.0.1/v1/?url=http://evil', 'http://user:password@127.0.0.1/v1/', 'http://127.0.0.1/v1/#fragment'])('rejects a local speech target that is not a literal loopback address: %s', (baseURL) => {
    // A query or fragment already fails the provider schema, which requires a URL that ends with a slash.
    expect(() => resolveAudioRoutes(config({ profile: 'local', local: baseURL, chain: ['local-whisper'] }))).toThrow(/literal loopback address|Invalid companion-core configuration/)
  })

  it.each([{ timeoutMs: 0 }, { maxRequestBytes: 100 * 1024 * 1024 }, { maxResponseBytes: 8 * 1024 * 1024 }])('rejects audio limits outside their bounds %j', (audio) => {
    expect(() => config({ audio })).toThrow('Invalid companion-core configuration')
  })
})
