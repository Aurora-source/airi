import type { RunningGateway } from '../src/server'

import { Buffer } from 'node:buffer'
import { request } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseConfig } from '../src/config/config'
import { startGateway } from '../src/server'
import { ALLOWED_ORIGIN, startFakeProvider, TEST_INFERENCE_TOKEN, TEST_OPS_TOKEN, TEST_PROVIDER_KEY } from './support/harness'

const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse())
    await close()
})

function upload(fields: Record<string, string | undefined> = {}): FormData {
  const body = new FormData()
  body.set('model', 'companion-stt')
  body.set('file', new Blob(['private-audio-bytes'], { type: 'audio/webm' }), 'private-diary.webm')
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined)
      body.set(name, value)
  }
  return body
}

/** Groq reports a 448-token context for its Whisper models. Speech recognition ignores the value. */
const WHISPER = { contextWindow: 448, streaming: false, tools: false }

interface SttOptions {
  profile?: 'local' | 'cloud' | 'cloud-mura-voice' | 'hybrid'
  /** An explicit loopback speech model. The local and hybrid profiles use it. */
  local?: { baseURL: string, model: string, keyRef?: string }
  audio?: { maxRequestBytes?: number, maxResponseBytes?: number, timeoutMs?: number }
}

/** One `speech-recognition` alias: the two Groq Whisper models, then the local model when one is given. */
function sttConfig(options: SttOptions = {}) {
  const profile = options.profile ?? 'cloud-mura-voice'
  const cloud = profile !== 'local'
  return parseConfig({
    port: 0,
    allowedOrigins: [ALLOWED_ORIGIN],
    store: { path: ':memory:' },
    profile,
    audio: options.audio,
    providers: {
      ...(cloud ? { groq: { baseURL: 'https://api.groq.com/openai/v1/', keyRef: 'provider-groq' } } : {}),
      ...(options.local ? { 'local-stt': { baseURL: options.local.baseURL, keyRef: options.local.keyRef, locality: 'local' } } : {}),
    },
    models: {
      ...(cloud
        ? {
            'groq-whisper-turbo': { provider: 'groq', model: 'whisper-large-v3-turbo', capabilities: WHISPER },
            'groq-whisper': { provider: 'groq', model: 'whisper-large-v3', capabilities: WHISPER },
          }
        : {}),
      ...(options.local ? { 'local-whisper': { provider: 'local-stt', model: options.local.model, capabilities: WHISPER } } : {}),
    },
    aliases: {
      'companion-stt': { role: 'speech-recognition', chain: [...(cloud ? ['groq-whisper-turbo', 'groq-whisper'] : []), ...(options.local ? ['local-whisper'] : [])] },
    },
  })
}

async function setup(options: { stt?: SttOptions, keys?: ReadonlyMap<string, string> } = {}) {
  const provider = await startFakeProvider()
  cleanup.push(provider.close)
  const logs: string[] = []
  // The configuration names the real Groq host. The network boundary maps it to a fake HTTP server for these tests.
  const gateway = await startGateway({
    config: sttConfig(options.stt),
    credentials: { inference: TEST_INFERENCE_TOKEN, ops: TEST_OPS_TOKEN },
    providerKeys: options.keys ?? new Map([['provider-groq', TEST_PROVIDER_KEY]]),
    audioFetch: (input, init) => fetch(new URL(String(input)).hostname === 'api.groq.com' ? new URL('audio/transcriptions', provider.baseURL) : input, init),
    writeLog: line => logs.push(line),
  })
  cleanup.push(gateway.close)
  provider.setHandler((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ text: 'こんにちは' }))
  })
  return { gateway, provider, logs }
}

function transcribe(gateway: RunningGateway, body = upload(), headers: Record<string, string> = {}) {
  return fetch(new URL('audio/transcriptions', gateway.baseURL), {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_INFERENCE_TOKEN}`, ...headers },
    body,
  })
}

describe('audio transcriptions', () => {
  it('forwards an upload with the configured Groq model and a safe filename', async () => {
    const { gateway, provider } = await setup()
    const response = await transcribe(gateway, upload({ language: 'ja', response_format: 'json' }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ text: 'こんにちは' })
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0].url).toBe('/v1/audio/transcriptions')
    expect(provider.requests[0].headers.authorization).toBe(`Bearer ${TEST_PROVIDER_KEY}`)
    expect(provider.requests[0].body).toContain('whisper-large-v3-turbo')
    expect(provider.requests[0].body).toContain('filename="audio.webm"')
    expect(provider.requests[0].body).toContain('private-audio-bytes')
    expect(provider.requests[0].body).toContain('ja')
    expect(provider.requests[0].body).not.toContain('private-diary')
    expect(provider.requests[0].body).not.toContain('companion-stt')
  })

  it('lists companion-stt only when audio is configured', async () => {
    const { gateway } = await setup()
    const response = await fetch(new URL('models', gateway.baseURL), { headers: { authorization: `Bearer ${TEST_INFERENCE_TOKEN}` } })

    const body = await response.json() as { data: unknown }

    expect(body.data).toEqual([{ id: 'companion-stt', object: 'model', created: 0, owned_by: 'companion-core' }])
  })

  it.each([undefined, 'wrong-token', TEST_OPS_TOKEN])('rejects inference authentication %s before upload forwarding', async (token) => {
    const { gateway, provider } = await setup()
    const response = await transcribe(gateway, upload(), { authorization: token ? `Bearer ${token}` : '' })

    expect(response.status).toBe(401)
    expect(provider.requests).toHaveLength(0)
  })

  it('rejects a foreign Origin before upload forwarding', async () => {
    const { gateway, provider } = await setup()
    const response = await transcribe(gateway, upload(), { origin: 'https://evil.example' })

    expect(response.status).toBe(403)
    expect(provider.requests).toHaveLength(0)
  })

  it('rejects a foreign Host before upload forwarding', async () => {
    const { gateway, provider } = await setup()
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(new URL('audio/transcriptions', gateway.baseURL), { method: 'POST', headers: { host: 'evil.example', authorization: `Bearer ${TEST_INFERENCE_TOKEN}` } }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      req.on('error', reject)
      req.end(Buffer.from('not-read'))
    })

    expect(status).toBe(421)
    expect(provider.requests).toHaveLength(0)
  })

  it.each(['text', 'verbose_json'])('returns usable %s responses', async (format) => {
    const { gateway, provider } = await setup()
    provider.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': format === 'text' ? 'text/plain' : 'application/json' })
      res.end(format === 'text' ? 'hello' : JSON.stringify({ text: 'hello', language: 'english', segments: [] }))
    })
    const response = await transcribe(gateway, upload({ response_format: format }))

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('hello')
    expect(provider.requests[0].body).toContain(format)
  })

  it.each([{ url: 'http://169.254.169.254/' }, { file: 'https://example.com/audio.wav' }, { model: 'whisper-large-v3' }, { profile: 'LOCAL' }, { response_format: 'srt' }, { language: '../../ja' }, { temperature: 'NaN' }])('rejects unsupported input %j before forwarding', async (fields) => {
    const { gateway, provider } = await setup()
    const response = await transcribe(gateway, upload(fields))

    expect(response.status).toBe(fields.model ? 404 : 400)
    expect(provider.requests).toHaveLength(0)
  })

  it('returns sanitized provider errors with status and Retry-After', async () => {
    const { gateway, provider, logs } = await setup()
    provider.setHandler((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '17' })
      res.end(JSON.stringify({ error: { message: `Limit reached ${TEST_PROVIDER_KEY} secret-prompt`, code: 'rate_limit_exceeded', type: 'rate_limit_error' } }))
    })
    const response = await transcribe(gateway, upload({ prompt: 'secret-prompt' }))
    const body = await response.text()

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('17')
    expect(body).toContain('Limit reached')
    expect(body).not.toContain(TEST_PROVIDER_KEY)
    expect(body).not.toContain('secret-prompt')
    expect(provider.requests).toHaveLength(1)
    expect(logs.join('\n')).not.toContain('Limit reached')
    expect(logs.join('\n')).not.toContain('private-audio-bytes')
    expect(logs.join('\n')).not.toContain('secret-prompt')
  })

  it('tries the second Groq model only when the first model is unavailable', async () => {
    const { gateway, provider } = await setup()
    provider.setHandler((_req, res, received) => {
      if (received.body.includes('whisper-large-v3-turbo')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'model_not_found', message: 'Model unavailable' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"text":"fallback"}')
    })
    const response = await transcribe(gateway)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ text: 'fallback' })
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1].body).toContain('whisper-large-v3')
    expect(provider.requests[1].body).not.toContain('whisper-large-v3-turbo')
  })

  it('rejects oversized uploads before provider forwarding', async () => {
    const { gateway, provider } = await setup({ stt: { audio: { maxRequestBytes: 1024 } } })
    const body = upload()
    body.set('file', new Blob([new Uint8Array(2048)], { type: 'audio/wav' }), 'audio.wav')
    const response = await transcribe(gateway, body)

    expect(response.status).toBe(413)
    expect(provider.requests).toHaveLength(0)
  })

  it('times out while the provider response body is pending', async () => {
    const { gateway, provider } = await setup({ stt: { audio: { timeoutMs: 80 } } })
    provider.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"text":')
    })
    const response = await transcribe(gateway)

    expect(response.status).toBe(504)
    const body = await response.json() as { error: { code: string } }

    expect(body.error.code).toBe('audio_timeout')
    await provider.requests[0].closed
  })

  it('stops during a slow upload when the request deadline expires', async () => {
    const { gateway, provider } = await setup({ stt: { audio: { timeoutMs: 80 } } })
    const result = await new Promise<{ status: number, body: string }>((resolve, reject) => {
      const req = request(new URL('audio/transcriptions', gateway.baseURL), {
        method: 'POST',
        headers: { 'authorization': `Bearer ${TEST_INFERENCE_TOKEN}`, 'content-type': 'multipart/form-data; boundary=slow' },
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          req.destroy()
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() })
        })
      })
      req.on('error', reject)
      req.write('--slow\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\n\r\npartial-audio')
    })

    expect(result.status).toBe(504)
    expect(result.body).toContain('audio_timeout')
    expect(provider.requests).toHaveLength(0)
  })

  it('cancels an incomplete client upload without contacting a provider', async () => {
    const { gateway, provider, logs } = await setup()
    const req = request(new URL('audio/transcriptions', gateway.baseURL), {
      method: 'POST',
      headers: { 'authorization': `Bearer ${TEST_INFERENCE_TOKEN}`, 'content-type': 'multipart/form-data; boundary=slow' },
    })
    req.on('error', () => {})
    req.write('--slow\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\n\r\npartial-audio')
    await new Promise(resolve => setTimeout(resolve, 30))
    req.destroy()

    await vi.waitFor(() => expect(logs.some(line => line.includes('audio_client_closed'))).toBe(true))
    expect(provider.requests).toHaveLength(0)
    expect(logs.join('\n')).toContain('"status":499')
  })

  it('cancels the provider while its response body is incomplete', async () => {
    const { gateway, provider, logs } = await setup()
    let received: () => void = () => {}
    const providerReceived = new Promise<void>(resolve => received = resolve)
    provider.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"text":"partial')
      received()
    })
    const controller = new AbortController()
    const pending = fetch(new URL('audio/transcriptions', gateway.baseURL), {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_INFERENCE_TOKEN}` },
      body: upload(),
      signal: controller.signal,
    })
    const rejected = expect(pending).rejects.toThrow()
    await providerReceived
    controller.abort()
    await rejected
    await provider.requests[0].closed

    await vi.waitFor(() => expect(logs.some(line => line.includes('audio_client_closed'))).toBe(true))
    expect(provider.requests).toHaveLength(1)
  })

  it('bounds the provider response without returning partial data', async () => {
    const { gateway, provider } = await setup({ stt: { audio: { maxResponseBytes: 1024 } } })
    provider.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: 'x'.repeat(2048) }))
    })
    const response = await transcribe(gateway)

    expect(response.status).toBe(502)
    expect(await response.text()).toContain('audio_response_too_large')
  })

  it('uses LOCAL only with its explicit loopback target and model', async () => {
    const local = await startFakeProvider()
    cleanup.push(local.close)
    local.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"text":"local"}')
    })
    const { gateway, provider } = await setup({ stt: { profile: 'local', local: { baseURL: local.baseURL, model: 'explicit-local-model' } }, keys: new Map() })
    const response = await transcribe(gateway)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ text: 'local' })
    expect(provider.requests).toHaveLength(0)
    expect(local.requests).toHaveLength(1)
    expect(local.requests[0].body).toContain('explicit-local-model')
    expect(local.requests[0].headers.authorization).toBeUndefined()
  })

  it.each(['cloud', 'cloud-mura-voice', 'hybrid'] as const)('keeps %s cloud-only without an explicit local fallback', async (profile) => {
    const { gateway, provider } = await setup({ stt: { profile } })
    provider.setHandler((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"temporarily unavailable","code":"unavailable"}}')
    })
    const response = await transcribe(gateway)

    expect(response.status).toBe(503)
    expect(provider.requests).toHaveLength(2)
  })

  it('uses an explicit HYBRID local fallback after a cloud rate limit', async () => {
    const local = await startFakeProvider()
    cleanup.push(local.close)
    local.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"text":"hybrid-local"}')
    })
    const { gateway, provider } = await setup({ stt: { profile: 'hybrid', local: { baseURL: local.baseURL, model: 'hybrid-model' } } })
    provider.setHandler((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"rate limit","code":"rate_limit_exceeded"}}')
    })
    const response = await transcribe(gateway)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ text: 'hybrid-local' })
    expect(provider.requests).toHaveLength(1)
    expect(local.requests).toHaveLength(1)
    expect(local.requests[0].body).toContain('hybrid-model')
  })

  it('never forwards the Groq key to an explicit HYBRID local target', async () => {
    const local = await startFakeProvider()
    cleanup.push(local.close)
    local.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"text":"local"}')
    })
    const { gateway, provider } = await setup({ stt: { profile: 'hybrid', local: { baseURL: local.baseURL, model: 'local' } }, keys: new Map() })
    const response = await transcribe(gateway)

    expect(response.status).toBe(200)
    expect(provider.requests).toHaveLength(0)
    expect(local.requests[0].headers.authorization).toBeUndefined()
  })

  it('returns a visible error when the cloud key is missing', async () => {
    const { gateway, provider } = await setup({ keys: new Map() })
    const response = await transcribe(gateway)

    expect(response.status).toBe(503)
    expect(await response.text()).toContain('audio_provider_key_missing')
    expect(provider.requests).toHaveLength(0)
  })

  it('rejects duplicate multipart options', async () => {
    const { gateway, provider } = await setup()
    const body = upload()
    body.append('model', 'whisper-large-v3')
    const response = await transcribe(gateway, body)

    expect(response.status).toBe(400)
    expect(provider.requests).toHaveLength(0)
  })

  it('rejects provider redirects without following them', async () => {
    const { gateway, provider } = await setup()
    provider.setHandler((_req, res) => {
      res.writeHead(307, { location: `${provider.baseURL}capture-key` })
      res.end()
    })
    const response = await transcribe(gateway)

    expect(response.status).toBe(502)
    expect(await response.text()).toContain('audio_provider_unreachable')
    expect(provider.requests).toHaveLength(1)
  })

  it('does not expose credentials that a provider places in error codes or types', async () => {
    const { gateway, provider } = await setup()
    provider.setHandler((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Request rejected', code: TEST_PROVIDER_KEY, type: TEST_PROVIDER_KEY } }))
    })
    const response = await transcribe(gateway)
    const body = await response.text()

    expect(response.status).toBe(429)
    expect(body).not.toContain(TEST_PROVIDER_KEY)
    expect(body).toContain('audio_provider_error')
  })

  it('accepts an audio file that contains an unframed boundary token', async () => {
    const { gateway, provider } = await setup()
    const audio = '--custom'.repeat(12)
    const body = Buffer.from(`--custom\r\nContent-Disposition: form-data; name="model"\r\n\r\ncompanion-stt\r\n--custom\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n${audio}\r\n--custom--\r\n`)
    const response = await fetch(new URL('audio/transcriptions', gateway.baseURL), {
      method: 'POST',
      headers: { 'authorization': `Bearer ${TEST_INFERENCE_TOKEN}`, 'content-type': 'multipart/form-data; boundary=custom' },
      body,
    })

    expect(response.status).toBe(200)
    expect(provider.requests[0].body).toContain(audio)
  })

  it.each(['NOT-A-DELIMITER', '-NOT-A-DELIMITER', '--NOT-A-DELIMITER'])('preserves a boundary prefix with binary suffix %s', async (suffix) => {
    const { gateway, provider } = await setup()
    const audio = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`audio-head\r\n--r3b${suffix}\r\naudio-tail`)])
    const body = Buffer.concat([
      Buffer.from('--r3b\r\nContent-Disposition: form-data; name="model"\r\n\r\ncompanion-stt\r\n--r3b\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n'),
      audio,
      Buffer.from('\r\n--r3b--\r\n'),
    ])
    const response = await fetch(new URL('audio/transcriptions', gateway.baseURL), {
      method: 'POST',
      headers: { 'authorization': `Bearer ${TEST_INFERENCE_TOKEN}`, 'content-type': 'multipart/form-data; boundary=r3b' },
      body,
    })

    expect(response.status).toBe(200)
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0].body).toContain(audio.toString('utf8'))
  })

  it('replaces an unsupported file MIME type before provider forwarding', async () => {
    const { gateway, provider } = await setup()
    const body = upload()
    body.set('file', new Blob(['audio'], { type: 'application/x-private-data' }), 'audio.wav')
    const response = await transcribe(gateway, body)

    expect(response.status).toBe(200)
    expect(provider.requests[0].body).not.toContain('application/x-private-data')
    expect(provider.requests[0].body).toContain('audio/wav')
  })

  it('keeps a successful cloud request usable when an optional local key is absent', async () => {
    const { gateway, provider } = await setup({ stt: { profile: 'hybrid', local: { baseURL: 'http://127.0.0.1:11996/v1/', model: 'local', keyRef: 'local-key' } } })
    const response = await transcribe(gateway)

    expect(response.status).toBe(200)
    expect(provider.requests).toHaveLength(1)
  })

  it('returns a sanitized text provider error with its status', async () => {
    const { gateway, provider } = await setup()
    provider.setHandler((_req, res) => {
      res.writeHead(429, { 'content-type': 'text/plain' })
      res.end(`Rate limit reached ${TEST_PROVIDER_KEY}`)
    })
    const response = await transcribe(gateway)
    const body = await response.text()

    expect(response.status).toBe(429)
    expect(body).toContain('Rate limit reached')
    expect(body).not.toContain(TEST_PROVIDER_KEY)
  })

  it('keeps audio disabled when no alias has the speech-recognition role', async () => {
    const gateway = await startGateway({
      config: parseConfig({ port: 0, store: { path: ':memory:' }, providers: {}, aliases: {} }),
      credentials: { inference: TEST_INFERENCE_TOKEN, ops: TEST_OPS_TOKEN },
      providerKeys: new Map(),
      writeLog: () => {},
    })
    cleanup.push(gateway.close)
    const models = await fetch(new URL('models', gateway.baseURL), { headers: { authorization: `Bearer ${TEST_INFERENCE_TOKEN}` } })
    const list = await models.json() as { data: unknown[] }
    const response = await transcribe(gateway)

    expect(list.data).toEqual([])
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('audio_not_configured')
  })

  it('uses the allowed browser Origin for audio CORS preflight and upload', async () => {
    const { gateway } = await setup()
    const preflight = await fetch(new URL('audio/transcriptions', gateway.baseURL), {
      method: 'OPTIONS',
      headers: { 'origin': ALLOWED_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    })
    const response = await transcribe(gateway, upload(), { origin: ALLOWED_ORIGIN })

    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
    await response.text()
  })

  it('keeps successful transcript bytes, filenames, audio, and keys out of request logs', async () => {
    const { gateway, provider, logs } = await setup()
    provider.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"text":"private-transcript-content"}')
    })
    const response = await transcribe(gateway, upload({ prompt: 'private-prompt' }))
    await response.text()
    const lines = logs.join('\n')

    expect(logs).toHaveLength(1)
    expect(lines).not.toContain('private-transcript-content')
    expect(lines).not.toContain('private-audio-bytes')
    expect(lines).not.toContain('private-diary.webm')
    expect(lines).not.toContain('private-prompt')
    expect(lines).not.toContain(TEST_INFERENCE_TOKEN)
    expect(lines).not.toContain(TEST_OPS_TOKEN)
    expect(lines).not.toContain(TEST_PROVIDER_KEY)
  })

  it('keeps the same deadline across Groq model fallback and skips local after expiry', async () => {
    const local = await startFakeProvider()
    cleanup.push(local.close)
    const { gateway, provider } = await setup({ stt: { profile: 'hybrid', audio: { timeoutMs: 200 }, local: { baseURL: local.baseURL, model: 'local' } } })
    provider.setHandler((_req, res, received) => {
      if (received.body.includes('whisper-large-v3-turbo')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":{"code":"model_not_found","message":"unavailable"}}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"text":')
    })
    const response = await transcribe(gateway)

    expect(response.status).toBe(504)
    expect(await response.text()).toContain('audio_timeout')
    expect(provider.requests).toHaveLength(2)
    expect(local.requests).toHaveLength(0)
    await provider.requests[1].closed
  })

  it('refuses chat completions on a speech-recognition alias without contacting a provider', async () => {
    const { gateway, provider } = await setup()
    const response = await fetch(new URL('chat/completions', gateway.baseURL), {
      method: 'POST',
      headers: { 'authorization': `Bearer ${TEST_INFERENCE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'companion-stt', messages: [{ role: 'user', content: 'hello' }] }),
    })

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('model_not_supported')
    expect(provider.requests).toHaveLength(0)
  })
})
