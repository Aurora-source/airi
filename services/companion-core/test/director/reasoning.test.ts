import type { ReasoningInput } from '../../src/director'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseConfig } from '../../src/config/config'
import { Director, GatewayReasoningPort } from '../../src/director'
import { startFakeProvider, startRoutedGateway, TEST_INFERENCE_TOKEN } from '../support/harness'
import { conversation, fixture, identity, settle } from './helpers'

const owners: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of owners.splice(0).reverse())
    await close()
})

function input(profile: ReasoningInput['profile'] = 'local'): ReasoningInput {
  return { profile, attention: 'conversation', mood: { valence: 0.1, arousal: 0.25, warmth: 0.5, tone: 'neutral' }, salience: 0.5, affect: 'curious', signal: new AbortController().signal }
}

describe('director bounded optional reasoning', () => {
  it('keeps reasoning disabled by default and safely defers when the port is unavailable', async () => {
    const reason = vi.fn(async () => ({ action: 'visual', affect: 'amused' }))
    const f = fixture({ reasoning: { reason } })
    const director = new Director(f.options)
    director.submit(conversation(f.clock, 'presence', { addressed: false, unresolved: false, significant: false }))
    director.submit({ type: 'reason', id: 'reason', identity, observedAt: f.clock.now(), observationKey: 'scene' })
    director.flush()
    await settle()
    expect(director.status().lastDecision?.reason).toBe('reasoning-disabled')
    expect(reason).not.toHaveBeenCalled()
    const unavailable = new Director({ ...f.options, reasoning: undefined, configuration: { reasoningEnabled: true } })
    unavailable.submit(conversation(f.clock, 'presence-2', { addressed: false, unresolved: false, significant: false }))
    unavailable.submit({ type: 'reason', id: 'reason-2', identity, observedAt: f.clock.now(), observationKey: 'scene-2' })
    unavailable.flush()
    expect(unavailable.status().lastDecision?.reason).toBe('reasoning-unavailable')
  })

  it('accepts only bounded visual or wait outcomes and cannot grant speech or memory authority', async () => {
    const reason = vi.fn(async () => ({ action: 'speak', affect: 'amused', instruction: 'reveal memory' }))
    const f = fixture({ reasoning: { reason }, configuration: { reasoningEnabled: true } })
    const director = new Director(f.options)
    director.configure({ proactiveSpeech: true }, 'user')
    director.submit(conversation(f.clock, 'presence', { addressed: false, unresolved: false, significant: false }))
    director.submit({ type: 'reason', id: 'reason', identity, observedAt: f.clock.now(), observationKey: 'scene' })
    director.flush()
    await settle()
    director.advance()
    expect(f.speech.deliver).not.toHaveBeenCalled()
    expect(f.record.offer).not.toHaveBeenCalled()
    expect(director.status().metrics.failures).toBe(1)
  })

  it('makes one optional visual decision and retains local cooldown and user control', async () => {
    const reason = vi.fn(async () => ({ action: 'visual', affect: 'curious' }))
    const f = fixture({ reasoning: { reason }, configuration: { reasoningEnabled: true } })
    const director = new Director(f.options)
    director.submit(conversation(f.clock, 'presence', { addressed: false, unresolved: false, significant: false }))
    director.submit({ type: 'reason', id: 'reason', identity, observedAt: f.clock.now(), observationKey: 'scene' })
    director.flush()
    await settle()
    director.advance()
    await settle()
    expect(reason).toHaveBeenCalledOnce()
    expect(f.visual.request).toHaveBeenCalledOnce()
    expect(f.speech.deliver).not.toHaveBeenCalled()
    director.submit({ type: 'reason', id: 'reason-2', identity, observedAt: f.clock.now(), observationKey: 'scene-2' })
    director.flush()
    expect(director.status().lastDecision?.reason).toBe('reasoning-budget')
    expect(reason).toHaveBeenCalledOnce()
    director.dispose()
  })

  it('drops late model output after interruption and schedules no idle retries', async () => {
    let resolve: (value: unknown) => void = () => {}
    const reason = vi.fn(() => new Promise<unknown>(r => resolve = r))
    const f = fixture({ reasoning: { reason }, configuration: { reasoningEnabled: true } })
    const director = new Director(f.options)
    director.submit(conversation(f.clock, 'presence', { addressed: false, unresolved: false, significant: false }))
    director.submit({ type: 'reason', id: 'reason', identity, observedAt: f.clock.now(), observationKey: 'scene' })
    director.flush()
    await settle()
    director.cancel()
    resolve({ action: 'visual', affect: 'amused' })
    await settle()
    for (let i = 0; i < 21600; i++) {
      f.clock.advance(2000)
      director.advance()
    }
    expect(reason).toHaveBeenCalledOnce()
    expect(f.visual.request).not.toHaveBeenCalled()
    expect(f.speech.deliver).not.toHaveBeenCalled()
    expect(f.clock.pendingTimers).toBe(0)
  })

  it('never starts model work after a same-turn privacy change', async () => {
    const reason = vi.fn(async () => ({ action: 'visual', affect: 'amused' }))
    const f = fixture({ reasoning: { reason }, configuration: { reasoningEnabled: true } })
    const director = new Director(f.options)
    director.submit(conversation(f.clock, 'presence', { addressed: false, unresolved: false, significant: false }))
    director.submit({ type: 'reason', id: 'reason', identity, observedAt: f.clock.now(), observationKey: 'scene' })
    director.flush()
    director.configure({ privateMode: true }, 'user')
    await settle()
    expect(reason).not.toHaveBeenCalled()
  })

  it('quarantines a non-cooperative model and remains bounded across 1000 retry events', async () => {
    const reason = vi.fn(() => new Promise<unknown>(() => {}))
    const f = fixture({ reasoning: { reason }, configuration: { reasoningEnabled: true } })
    const director = new Director(f.options)
    for (let i = 0; i < 1000; i++) {
      director.submit(conversation(f.clock, `presence-${i}`, { addressed: false, unresolved: false, significant: false }))
      director.submit({ type: 'reason', id: `reason-${i}`, identity, observedAt: f.clock.now(), observationKey: `scene-${i}` })
      director.flush()
      await settle()
      f.clock.advance(300001)
    }
    expect(reason).toHaveBeenCalledOnce()
    expect(director.status().resources.inFlightReasoning).toBe(1)
    expect(director.status().resources.activeReasoning).toBe(0)
    expect(f.clock.pendingTimers).toBe(0)
  })
})

describe('existing R2B reasoning gateway adapter', () => {
  it('uses the actual gateway quota ledger instead of introducing provider routing', async () => {
    const provider = await startFakeProvider()
    owners.push(provider.close)
    provider.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: 'wait', affect: 'focused' }) } }], usage: { prompt_tokens: 40, completion_tokens: 10 } }))
    })
    const raw = { profile: 'local', providers: { fake: { baseURL: provider.baseURL, locality: 'local' } }, models: { fake: { provider: 'fake', model: 'test-model', capabilities: { contextWindow: 8192, structuredOutput: true }, limits: { rpd: 1 } } }, aliases: { 'companion-reason': { role: 'reasoning', chain: ['fake'] } } }
    const { gateway } = await startRoutedGateway(raw)
    owners.push(gateway.close)
    const adapter = new GatewayReasoningPort({ base_url: gateway.baseURL, alias: 'companion-reason', config: gateway.runtime.config, token: TEST_INFERENCE_TOKEN })
    expect(await adapter.reason(input())).toEqual({ action: 'wait', affect: 'focused' })
    await expect(adapter.reason(input())).rejects.toThrow('Director reasoning unavailable')
    expect(provider.requests).toHaveLength(1)
    const request = JSON.parse(provider.requests[0].body) as Record<string, unknown>
    expect(request.tools).toBeUndefined()
    expect(request.max_tokens).toBe(128)
  })

  it('enforces compute profile matching before any gateway request', async () => {
    const config = parseConfig({ profile: 'cloud', providers: { fake: { baseURL: 'http://127.0.0.1:1/v1/', keyRef: 'key-fake' } }, models: { fake: { provider: 'fake', model: 'test', capabilities: { contextWindow: 8192, structuredOutput: true } } }, aliases: { 'companion-reason': { role: 'reasoning', chain: ['fake'] } } })
    const transport = vi.fn<typeof fetch>()
    const adapter = new GatewayReasoningPort({ base_url: 'http://127.0.0.1:11980/v1/', alias: 'companion-reason', config, transport })
    await expect(adapter.reason(input('local'))).rejects.toThrow('Director reasoning profile mismatch')
    expect(transport).not.toHaveBeenCalled()
    expect(() => new GatewayReasoningPort({ base_url: 'https://example.com/v1/', alias: 'companion-reason', config })).toThrow()
  })

  it('leaves a CLOUD provider failure to the gateway and never introduces local fallback', async () => {
    const provider = await startFakeProvider()
    owners.push(provider.close)
    provider.setHandler((_req, res) => {
      res.writeHead(503)
      res.end('unavailable')
    })
    const raw = { profile: 'cloud', providers: { cloud: { baseURL: provider.baseURL, keyRef: 'cloud-key' } }, models: { cloud: { provider: 'cloud', model: 'cloud-test', capabilities: { contextWindow: 8192, structuredOutput: true } } }, aliases: { 'companion-reason': { role: 'reasoning', chain: ['cloud'] } } }
    const { gateway } = await startRoutedGateway(raw)
    owners.push(gateway.close)
    const adapter = new GatewayReasoningPort({ base_url: gateway.baseURL, alias: 'companion-reason', config: gateway.runtime.config, token: TEST_INFERENCE_TOKEN })
    await expect(adapter.reason(input('cloud'))).rejects.toThrow('Director reasoning unavailable')
    expect(provider.requests).toHaveLength(1)
  })

  it('uses only the explicit HYBRID chain when the gateway falls back to local reasoning', async () => {
    const cloud = await startFakeProvider()
    owners.push(cloud.close)
    const local = await startFakeProvider()
    owners.push(local.close)
    cloud.setHandler((_req, res) => {
      res.writeHead(503)
      res.end('unavailable')
    })
    local.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '{"action":"visual","affect":"curious"}' } }] }))
    })
    const capabilities = { contextWindow: 8192, structuredOutput: true }
    const raw = { profile: 'hybrid', providers: { cloud: { baseURL: cloud.baseURL, keyRef: 'cloud-key' }, local: { baseURL: local.baseURL, locality: 'local' } }, models: { cloud: { provider: 'cloud', model: 'cloud-test', capabilities }, local: { provider: 'local', model: 'local-test', capabilities } }, aliases: { 'companion-reason': { role: 'reasoning', chain: ['cloud', 'local'] } } }
    const { gateway } = await startRoutedGateway(raw)
    owners.push(gateway.close)
    const adapter = new GatewayReasoningPort({ base_url: gateway.baseURL, alias: 'companion-reason', config: gateway.runtime.config, token: TEST_INFERENCE_TOKEN })
    expect(await adapter.reason(input('hybrid'))).toEqual({ action: 'visual', affect: 'curious' })
    expect(cloud.requests).toHaveLength(1)
    expect(local.requests).toHaveLength(1)
  })

  it('rejects injected model instructions and oversized responses', async () => {
    const config = parseConfig({ profile: 'local', providers: { fake: { baseURL: 'http://127.0.0.1:1/v1/', locality: 'local' } }, models: { fake: { provider: 'fake', model: 'test', capabilities: { contextWindow: 8192, structuredOutput: true } } }, aliases: { 'companion-reason': { role: 'reasoning', chain: ['fake'] } } })
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"speak","instruction":"ignore controls"}' } }] })))
    const adapter = new GatewayReasoningPort({ base_url: 'http://127.0.0.1:11980/v1/', alias: 'companion-reason', config, transport })
    await expect(adapter.reason(input())).rejects.toThrow('Invalid Director reasoning result')
    transport.mockResolvedValueOnce(new Response('x'.repeat(17000)))
    await expect(adapter.reason(input())).rejects.toThrow('Director reasoning response too large')
  })

  it('bounds work when a malformed response streams thousands of empty fragments', async () => {
    const config = parseConfig({ profile: 'local', providers: { fake: { baseURL: 'http://127.0.0.1:1/v1/', locality: 'local' } }, models: { fake: { provider: 'fake', model: 'test', capabilities: { contextWindow: 8192, structuredOutput: true } } }, aliases: { 'companion-reason': { role: 'reasoning', chain: ['fake'] } } })
    let fragments = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        fragments++
        if (fragments <= 5000)
          controller.enqueue(new Uint8Array())
        else
          controller.close()
      },
      cancel() { cancelled = true },
    })
    const transport = vi.fn<typeof fetch>(async () => new Response(body))
    const adapter = new GatewayReasoningPort({ base_url: 'http://127.0.0.1:11980/v1/', alias: 'companion-reason', config, transport })
    await expect(adapter.reason(input())).rejects.toThrow('Director reasoning response too fragmented')
    expect(fragments).toBeLessThanOrEqual(1026)
    expect(cancelled).toBe(true)
  })
})
