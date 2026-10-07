import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { parseConfig } from '../src/config/config'
import { runProbes } from '../src/probe/run-probes'
import { ProbeStore } from '../src/probe/store'
import { openDatabase } from '../src/store/database'
import { authHeaders, sse, startFakeProvider, startRoutedGateway, writeEvents } from './support/harness'
import { AIRI_TOOLS, filler, system, user } from './support/wire'

type Provider = Awaited<ReturnType<typeof startFakeProvider>>

let remote: Provider
let local: Provider

beforeAll(async () => {
  ;[remote, local] = await Promise.all([startFakeProvider(), startFakeProvider()])
})

afterEach(() => {
  remote.requests.length = 0
  local.requests.length = 0
})

afterAll(async () => {
  await Promise.all([remote.close(), local.close()])
})

/** A provider that supports everything except tools. */
function noTools(provider: Provider) {
  provider.setHandler((req, res, received) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"data":[{"id":"remote-1"},{"id":"local-1"}]}')
      return
    }
    const body = JSON.parse(received.body) as { stream?: boolean, tools?: unknown, response_format?: unknown }
    if (body.tools) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"tools unsupported"}}')
      return
    }
    const content = body.response_format ? '{"ok":true}' : 'pong'
    if (body.stream) {
      res.setHeader('content-type', 'text/event-stream')
      void writeEvents(res, [sse({ choices: [{ index: 0, delta: { content } }] }), sse('[DONE]')])
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
  })
}

function config(profile: string) {
  return parseConfig({
    profile,
    store: { path: ':memory:' },
    providers: {
      remote: { baseURL: remote.baseURL, keyRef: 'key-remote' },
      local: { baseURL: local.baseURL, locality: 'local' },
    },
    models: {
      'remote-model': { provider: 'remote', model: 'remote-1', capabilities: { contextWindow: 32_000, tools: true, images: true } },
      'local-model': { provider: 'local', model: 'local-1', capabilities: { contextWindow: 8000 } },
    },
    aliases: { 'companion-chat': { chain: profile === 'hybrid' ? ['remote-model', 'local-model'] : ['remote-model'] } },
  })
}

describe('runProbes', () => {
  it('probes the models of the alias chains and stores each result', async () => {
    noTools(remote)
    const store = new ProbeStore(openDatabase(':memory:'), Date.now)

    const results = await runProbes(config('cloud-mura-voice'), new Map([['key-remote', 'k'.repeat(12)]]), store, { gapMs: 0 })

    expect(results.map(result => result.modelId)).toEqual(['remote-model'])
    expect(store.get('remote-model')).toMatchObject({ working: true, tools: false, streaming: true })
  })

  it('never calls a local model in a cloud profile, because that would start local inference', async () => {
    noTools(remote)
    noTools(local)
    const store = new ProbeStore(openDatabase(':memory:'), Date.now)

    await runProbes(config('cloud'), new Map([['key-remote', 'k'.repeat(12)]]), store, { gapMs: 0, modelIds: ['remote-model', 'local-model'] })

    expect(local.requests).toHaveLength(0)
  })

  it('probes the local model of a hybrid profile', async () => {
    noTools(remote)
    noTools(local)
    const store = new ProbeStore(openDatabase(':memory:'), Date.now)

    const results = await runProbes(config('hybrid'), new Map([['key-remote', 'k'.repeat(12)]]), store, { gapMs: 0 })

    expect(results.map(result => result.modelId)).toEqual(['remote-model', 'local-model'])
    expect(local.requests.length).toBeGreaterThan(0)
  })

  it('skips the models of a speech-recognition alias, because a chat probe cannot test them', async () => {
    noTools(remote)
    const store = new ProbeStore(openDatabase(':memory:'), Date.now)
    const withSpeech = parseConfig({
      profile: 'cloud',
      store: { path: ':memory:' },
      providers: { remote: { baseURL: remote.baseURL, keyRef: 'key-remote' } },
      models: {
        'remote-model': { provider: 'remote', model: 'remote-1', capabilities: { contextWindow: 32_000 } },
        'remote-whisper': { provider: 'remote', model: 'whisper-large-v3-turbo', capabilities: { contextWindow: 448, streaming: false, tools: false } },
      },
      aliases: {
        'companion-chat': { chain: ['remote-model'] },
        'companion-stt': { role: 'speech-recognition', chain: ['remote-whisper'] },
      },
    })

    const results = await runProbes(withSpeech, new Map([['key-remote', 'k'.repeat(12)]]), store, { gapMs: 0 })

    expect(results.map(result => result.modelId)).toEqual(['remote-model'])
  })

  it('reports a model whose key is missing without sending a request', async () => {
    const store = new ProbeStore(openDatabase(':memory:'), Date.now)

    const results = await runProbes(config('cloud'), new Map(), store, { gapMs: 0 })

    expect(results[0]).toMatchObject({ modelId: 'remote-model', working: false })
    expect(results[0].failures.key).toBeDefined()
    expect(remote.requests).toHaveLength(0)
  })
})

describe('probe results at routing time', () => {
  it('make the router skip a model that the probe found unable, whatever the configuration says', async () => {
    remote.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"choices":[{"message":{"role":"assistant","content":"hi"}}]}')
    })
    const { gateway } = await startRoutedGateway({
      providers: { remote: { baseURL: remote.baseURL, keyRef: 'key-remote' } },
      models: { 'remote-model': { provider: 'remote', model: 'remote-1', capabilities: { contextWindow: 32_000, tools: true } } },
      aliases: { 'companion-chat': { chain: ['remote-model'] } },
    }, {
      probes: [{ modelId: 'remote-model', probedAtMs: Date.now(), reachable: true, working: true, streaming: true, tools: false, toolCallIndexMissing: false, images: false, structuredOutput: false, failures: {} }],
    })

    const response = await fetch(new URL('chat/completions', gateway.baseURL), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'companion-chat', messages: [system(filler(100, 'card')), user('hi')], tools: AIRI_TOOLS }),
    })
    await gateway.close()

    expect(response.status).toBe(400)
    expect(response.headers.get('x-companion-skipped')).toBe('remote-model=CAPABILITY_TOOLS')
    expect(remote.requests).toHaveLength(0)
  })
})
