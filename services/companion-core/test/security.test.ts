import type { RunningGateway } from '../src'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DpapiSecretStore, loadOrCreateCredentials, MemorySecretStore, parseConfig } from '../src'
import { createBearerCheck } from '../src/auth/credentials'
import { createRedactor } from '../src/logging/redact'
import { ALLOWED_ORIGIN, authHeaders, readChunks, sse, startFakeProvider, startTestGateway, TEST_INFERENCE_TOKEN, TEST_OPS_TOKEN, TEST_PROVIDER_KEY, writeEvents } from './support/harness'

let provider: Awaited<ReturnType<typeof startFakeProvider>>
let gateway: RunningGateway
let logs: string[]

beforeAll(async () => {
  provider = await startFakeProvider()
  ;({ gateway, logs } = await startTestGateway(provider.baseURL))
  provider.setHandler((_req, res) => writeEvents(res, [sse({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }), sse('[DONE]')]))
})

afterAll(async () => {
  await gateway.close()
  await provider.close()
})

const chatBody = JSON.stringify({ model: 'companion-chat', stream: true, messages: [{ role: 'user', content: 'Hi' }] })

/** Sends a request with full control of `Host`, which `fetch` does not allow. */
function rawRequest(options: { path: string, method?: string, headers?: Record<string, string>, body?: string }): Promise<{ status: number, headers: Record<string, string | string[] | undefined>, body: string }> {
  const url = new URL(gateway.baseURL)
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: url.port, path: options.path, method: options.method ?? 'GET', headers: options.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

describe('o: inference authentication', () => {
  it.each([
    { name: 'no Authorization header', headers: { 'content-type': 'application/json' } },
    { name: 'a wrong token', headers: authHeaders('cc_inf_wrong-token-000000000000000000000000') },
    { name: 'the ops token', headers: authHeaders(TEST_OPS_TOKEN) },
    { name: 'a token without the Bearer scheme', headers: { 'authorization': TEST_INFERENCE_TOKEN, 'content-type': 'application/json' } },
  ])('rejects $name with 401 and never calls the provider', async ({ headers }) => {
    const before = provider.requests.length

    const chat = await fetch(new URL('chat/completions', gateway.baseURL), { method: 'POST', headers, body: chatBody })
    const models = await fetch(new URL('models', gateway.baseURL), { headers })

    expect(chat.status).toBe(401)
    expect(chat.headers.get('www-authenticate')).toBe('Bearer')
    expect(models.status).toBe(401)
    expect(provider.requests.length).toBe(before)
  })

  it('accepts the inference token', async () => {
    const response = await fetch(new URL('chat/completions', gateway.baseURL), { method: 'POST', headers: authHeaders(), body: chatBody })

    expect(response.status).toBe(200)
    await readChunks(response)
  })

  it('compares tokens exactly', () => {
    const check = createBearerCheck('cc_inf_abc')

    expect(check('Bearer cc_inf_abc')).toBe(true)
    expect(check('Bearer cc_inf_ab')).toBe(false)
    expect(check('Bearer cc_inf_abcd')).toBe(false)
    expect(check(undefined)).toBe(false)
  })

  it('serves /livez without a token and reveals nothing else', async () => {
    const response = await fetch(new URL('/livez', gateway.baseURL))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"ok":true}')
  })

  it('returns 404 for paths outside /v1 even with a valid token', async () => {
    const response = await fetch(new URL('/ops/config', gateway.baseURL), { headers: authHeaders(TEST_OPS_TOKEN) })

    expect(response.status).toBe(404)
  })
})

describe('host and origin policy', () => {
  it('rejects a foreign Host header with 421, which blocks DNS-rebinding pages', async () => {
    const response = await rawRequest({ path: '/v1/models', headers: { ...authHeaders(), host: 'evil.example:11980' } })

    expect(response.status).toBe(421)
  })

  it('accepts localhost as the Host name', async () => {
    const port = new URL(gateway.baseURL).port
    const response = await rawRequest({ path: '/v1/models', headers: { ...authHeaders(), host: `localhost:${port}` } })

    expect(response.status).toBe(200)
  })

  it('rejects a foreign Origin with 403 even when the token is valid', async () => {
    const before = provider.requests.length

    const response = await fetch(new URL('chat/completions', gateway.baseURL), { method: 'POST', headers: { ...authHeaders(), origin: 'https://evil.example' }, body: chatBody })

    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(provider.requests.length).toBe(before)
  })

  it('allows the configured origin and answers its CORS preflight', async () => {
    const preflight = await fetch(new URL('chat/completions', gateway.baseURL), {
      method: 'OPTIONS',
      headers: { 'origin': ALLOWED_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    })
    const response = await fetch(new URL('chat/completions', gateway.baseURL), { method: 'POST', headers: { ...authHeaders(), origin: ALLOWED_ORIGIN }, body: chatBody })

    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
    await readChunks(response)
  })

  it('rejects a preflight from a foreign origin', async () => {
    const preflight = await fetch(new URL('chat/completions', gateway.baseURL), {
      method: 'OPTIONS',
      headers: { 'origin': 'https://evil.example', 'access-control-request-method': 'POST' },
    })

    expect(preflight.status).toBe(403)
  })
})

describe('ops routes', () => {
  const opsHeaders = { authorization: `Bearer ${TEST_OPS_TOKEN}` }

  it.each<{ name: string, headers: Record<string, string> }>([
    { name: 'no Authorization header', headers: {} },
    { name: 'the inference token', headers: { authorization: `Bearer ${TEST_INFERENCE_TOKEN}` } },
    { name: 'a wrong token', headers: { authorization: 'Bearer cc_ops_wrong-token-000000000000000000000000' } },
  ])('rejects $name on /ops/status with 401', async ({ headers }) => {
    const response = await rawRequest({ path: '/ops/status', headers })

    expect(response.status).toBe(401)
    expect(response.headers['www-authenticate']).toBe('Bearer')
    expect(response.body).not.toContain('companion-chat')
  })

  it('serves the routing state to the ops token, without keys, tokens, or message text', async () => {
    await fetch(new URL('chat/completions', gateway.baseURL), { method: 'POST', headers: authHeaders(), body: JSON.stringify({ model: 'companion-chat', messages: [{ role: 'user', content: 'a private sentence about my day' }] }) }).then(response => response.arrayBuffer())

    const response = await rawRequest({ path: '/ops/status', headers: opsHeaders })

    expect(response.status).toBe(200)
    expect(response.body).toContain('companion-chat')
    expect(response.body).not.toContain(TEST_PROVIDER_KEY)
    expect(response.body).not.toContain(TEST_INFERENCE_TOKEN)
    expect(response.body).not.toContain(TEST_OPS_TOKEN)
    expect(response.body).not.toContain('private sentence')
  })

  it('rejects a foreign Host and a foreign Origin even with the ops token', async () => {
    const forgedHost = await rawRequest({ path: '/ops/status', headers: { ...opsHeaders, host: 'evil.example:11980' } })
    const foreignOrigin = await rawRequest({ path: '/ops/status', headers: { ...opsHeaders, origin: 'https://evil.example' } })

    expect(forgedHost.status).toBe(421)
    expect(foreignOrigin.status).toBe(403)
  })

  it('answers 404 for an unknown ops path and for an ops method that does not exist', async () => {
    const unknown = await rawRequest({ path: '/ops/nothing', headers: opsHeaders })
    const post = await rawRequest({ path: '/ops/status', method: 'POST', headers: opsHeaders, body: '{}' })

    expect(unknown.status).toBe(404)
    expect(post.status).toBe(404)
  })

  it('does not accept the ops token on /v1 routes', async () => {
    const response = await rawRequest({ path: '/v1/models', headers: opsHeaders })

    expect(response.status).toBe(401)
  })
})

describe('p: secret redaction', () => {
  it('keeps tokens, provider keys, and message content out of every log line', async () => {
    const secretPrompt = 'my private diary entry 4f7c'
    await fetch(new URL('chat/completions', gateway.baseURL), { method: 'POST', headers: authHeaders('cc_inf_wrong-token-000000000000000000000000'), body: chatBody })
    const response = await fetch(new URL('chat/completions', gateway.baseURL), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'companion-chat', stream: true, messages: [{ role: 'user', content: secretPrompt }] }),
    })
    await readChunks(response)
    const joined = logs.join('\n')

    expect(logs.length).toBeGreaterThan(0)
    expect(joined).not.toContain(TEST_INFERENCE_TOKEN)
    expect(joined).not.toContain(TEST_OPS_TOKEN)
    expect(joined).not.toContain(TEST_PROVIDER_KEY)
    expect(joined).not.toContain('cc_inf_wrong-token')
    expect(joined).not.toContain(secretPrompt)
  })

  it('redacts known secrets and credential-shaped strings', () => {
    const redact = createRedactor(['super-secret-value'])

    expect(redact('a super-secret-value b')).toBe('a [REDACTED] b')
    expect(redact('Authorization: Bearer abc.def-ghi')).toBe('Authorization: [REDACTED]')
    expect(redact(`key=${TEST_PROVIDER_KEY}`)).toBe('key=[REDACTED]')
    expect(redact('gsk_abcdefghijklmnopqrstuvwxyz0123')).toBe('[REDACTED]')
    expect(redact('sk-or-v1-abcdefghijklmnopqrstuvwxyz')).toBe('[REDACTED]')
  })
})

describe('q: loopback-only binding', () => {
  it('listens on 127.0.0.1 only', () => {
    const address = gateway.server.address()

    expect(typeof address === 'object' && address?.address).toBe('127.0.0.1')
  })

  it('refuses connections on a non-loopback interface', async () => {
    const external = Object.values(networkInterfaces()).flat().find(entry => entry && entry.family === 'IPv4' && !entry.internal)
    if (!external) {
      console.warn('No non-loopback IPv4 interface exists. The interface check is limited to the bound address.')
      return
    }
    const port = Number(new URL(gateway.baseURL).port)

    const outcome = await new Promise<string>((resolve) => {
      const socket = connect({ host: external.address, port, timeout: 1500 })
      socket.on('connect', () => {
        socket.destroy()
        resolve('connected')
      })
      socket.on('timeout', () => {
        socket.destroy()
        resolve('timeout')
      })
      socket.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'))
    })

    expect(outcome).not.toBe('connected')
  })

  it.each(['0.0.0.0', '192.168.1.10', '::'])('rejects host %s in the configuration', (host) => {
    expect(() => parseConfig({ host, providers: {}, aliases: {} })).toThrow(/Invalid companion-core configuration/)
  })
})

describe('credentials', () => {
  it('creates two different tokens once and reuses them', async () => {
    const store = new MemorySecretStore()

    const first = await loadOrCreateCredentials(store)
    const second = await loadOrCreateCredentials(store)

    expect(first.inference).toMatch(/^cc_inf_[\w-]{43}$/)
    expect(first.ops).toMatch(/^cc_ops_[\w-]{43}$/)
    expect(first.inference).not.toBe(first.ops)
    expect(second).toEqual(first)
  })

  it.runIf(process.platform === 'win32')('round-trips a secret through Windows DPAPI without storing plaintext', async () => {
    const { readFile } = await import('node:fs/promises')
    const directory = join(tmpdir(), `companion-core-dpapi-${process.pid}`)
    const store = new DpapiSecretStore(directory)
    const value = 'AIzaDPAPI-roundtrip-0000000000000000000'

    await store.write('provider-test', value)
    const blob = await readFile(join(directory, 'provider-test.dpapi'), 'utf8')

    expect(await store.read('provider-test')).toBe(value)
    expect(await store.read('missing-secret')).toBeUndefined()
    expect(blob).not.toContain(value)
    expect(Buffer.from(blob, 'base64').toString('utf8')).not.toContain(value)
  }, 30_000)
})
