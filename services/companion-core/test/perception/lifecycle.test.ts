import type { PerceptionEventPort, ScreenFrame, VisionObservationPort } from '../../src/perception/ports/contracts'

import { describe, expect, it, vi } from 'vitest'

import { OwnedScreenCapture } from '../../src/perception/capture/owner'
import { PerceptionFailure } from '../../src/perception/ports/failure'
import { PrivacyGate } from '../../src/perception/privacy/gate'
import { PerceptionService } from '../../src/perception/service'
import { VisionChain } from '../../src/perception/vision/chain'
import { OpenAiVisionAdapter } from '../../src/perception/vision/openai-adapter'
import { facts, frame } from './helpers'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(options: { vision?: VisionObservationPort, capture?: (signal: AbortSignal) => Promise<ScreenFrame>, timeout_ms?: number, events?: PerceptionEventPort } = {}) {
  let now = 100
  let calls = 0
  const backend = { capture: options.capture ?? (async () => frame({ captured_at: now, capture_id: `capture-${now}` })), shutdown: async () => {} }
  const capture = new OwnedScreenCapture(backend)
  const privacy = new PrivacyGate()
  const vision: VisionObservationPort = options.vision ?? { id: 'fixture', locality: 'cloud', capabilities: { vision: true, structured_output: true }, observe: async () => {
    calls++
    return facts()
  } }
  const chain = new VisionChain({ profile: 'cloud', adapters: [vision], now: () => now })
  const service = new PerceptionService({ capture, privacy, vision: chain, now: () => now, events: options.events }, { vision_timeout_ms: options.timeout_ms ?? 1000, ttl_ms: 5000, scheduler: { debounce_ms: 0, minimum_interval_ms: 1000 } })
  return { service, capture, privacy, calls: () => calls, time: (value: number) => {
    now = value
  } }
}

describe('owned capture', () => {
  it('rejects cancelled captures even when the backend ignores cancellation', async () => {
    const pending = deferred<ScreenFrame>()
    const owner = new OwnedScreenCapture({ capture: () => pending.promise, shutdown: async () => {} })
    const controller = new AbortController()
    const request = owner.capture(controller.signal)
    controller.abort()
    await expect(request).rejects.toMatchObject({ code: 'cancelled' })
    const late = frame()
    pending.resolve(late)
    await Promise.resolve()
    expect(late.image.bytes.every(byte => byte === 0)).toBe(true)
    await owner.shutdown()
  })

  it('rejects a stale capture after its source disappears', async () => {
    const pending = deferred<ScreenFrame>()
    const owner = new OwnedScreenCapture({ capture: () => pending.promise, shutdown: async () => {} })
    const request = owner.capture(new AbortController().signal)
    owner.sourceChanged(false)
    await expect(request).rejects.toMatchObject({ code: 'cancelled' })
    expect(owner.isAvailable()).toBe(false)
    pending.resolve(frame())
    await owner.shutdown()
  })
})

describe('perception lifecycle', () => {
  it('look_now returns a fresh observation and retains no image bytes', async () => {
    const image = frame()
    const f = fixture({ capture: async () => image })
    const result = await f.service.look_now()
    expect(result.status).toBe('fresh')
    expect(f.calls()).toBe(1)
    expect(image.image.bytes.every(byte => byte === 0)).toBe(true)
    expect('image' in result).toBe(false)
    await f.service.shutdown()
  })

  it('a mostly static screen makes one vision call and expires without claiming current facts', async () => {
    const f = fixture()
    await f.service.tick()
    for (let i = 1; i <= 100; i++) {
      f.time(100 + i * 1000)
      await f.service.tick()
    }
    expect(f.calls()).toBe(1)
    expect(f.service.current().status).toBe('stale')
    await f.service.shutdown()
  })

  it('publishes bounded transitions instead of repeating identical awareness events', async () => {
    const publish = vi.fn()
    const f = fixture({ events: { publish } })
    await f.service.tick()
    f.time(200)
    await f.service.tick()
    expect(publish).toHaveBeenCalledTimes(1)
    f.time(6000)
    await f.service.tick()
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish.mock.calls[1][0].world.status).toBe('stale')
    await f.service.shutdown()
  })

  it('supports optional idle maximum refresh', async () => {
    let now = 100
    let calls = 0
    const capture = new OwnedScreenCapture({ capture: async () => frame({ captured_at: now }), shutdown: async () => {} })
    const adapter: VisionObservationPort = { id: 'v', locality: 'cloud', capabilities: { vision: true, structured_output: false }, observe: async () => {
      calls++
      return facts()
    } }
    const service = new PerceptionService({ capture, privacy: new PrivacyGate(), vision: new VisionChain({ profile: 'cloud', adapters: [adapter] }), now: () => now }, { scheduler: { maximum_idle_refresh_ms: 60000 } })
    await service.tick()
    now = 60100
    await service.tick()
    expect(calls).toBe(2)
    await service.shutdown()
  })

  it('privacy-blocked frames never reach vision', async () => {
    const f = fixture()
    f.privacy.update({ excluded_apps: ['editor'] })
    expect((await f.service.look_now()).status).toBe('blocked-by-privacy')
    expect(f.calls()).toBe(0)
    await f.service.shutdown()
  })

  it('pause prevents capture and invalidates current state immediately', async () => {
    const capture = vi.fn(async () => frame())
    const f = fixture({ capture })
    await f.service.look_now()
    f.privacy.update({ paused: true })
    expect(f.service.current().status).toBe('blocked-by-privacy')
    await f.service.look_now({ authorize_unknown: true })
    expect(capture).toHaveBeenCalledTimes(1)
    await f.service.shutdown()
  })

  it('privacy pause and resume refresh the same screen instead of retaining a blocked state', async () => {
    const f = fixture()
    await f.service.tick()
    f.privacy.update({ paused: true })
    f.privacy.update({ paused: false })
    f.time(1100)
    expect((await f.service.tick()).status).toBe('fresh')
    expect(f.calls()).toBe(2)
    await f.service.shutdown()
  })

  it('recovers the same screen after a frame-derived privacy block', async () => {
    let now = 100
    let sensitive = false
    const f = fixture({ capture: async () => frame({ captured_at: now, safety: { private_context: false, locked: false, sensitive } }) })
    await f.service.tick()
    now = 200
    f.time(now)
    sensitive = true
    expect((await f.service.tick()).status).toBe('blocked-by-privacy')
    now = 1100
    f.time(now)
    sensitive = false
    expect((await f.service.tick()).status).toBe('fresh')
    expect(f.calls()).toBe(2)
    await f.service.shutdown()
  })

  it('restores still-valid facts when a cooldown-suppressed change reverts', async () => {
    let now = 100
    let value = 100
    const f = fixture({ capture: async () => frame({ captured_at: now, samples: new Uint8Array(2304).fill(value) }) })
    await f.service.tick()
    now = 200
    f.time(now)
    value = 125
    expect((await f.service.tick()).status).toBe('unavailable')
    now = 300
    f.time(now)
    value = 100
    expect((await f.service.tick()).status).toBe('fresh')
    expect(f.calls()).toBe(1)
    await f.service.shutdown()
  })

  it('privacy changes during capture cancel the request before upload', async () => {
    const pending = deferred<ScreenFrame>()
    const f = fixture({ capture: () => pending.promise })
    const result = f.service.look_now()
    f.privacy.update({ excluded_apps: ['editor'] })
    pending.resolve(frame())
    expect((await result).status).toBe('blocked-by-privacy')
    expect(f.calls()).toBe(0)
    await f.service.shutdown()
  })

  it('throwing subscribers cannot prevent privacy or source revocation', async () => {
    const capture = new OwnedScreenCapture({ capture: async () => frame(), shutdown: async () => {} })
    const privacy = new PrivacyGate()
    privacy.subscribe(() => {
      throw new Error('consumer failure')
    })
    capture.subscribe(() => {
      throw new Error('consumer failure')
    })
    const adapter: VisionObservationPort = { id: 'v', locality: 'cloud', capabilities: { vision: true, structured_output: false }, observe: async () => facts() }
    const service = new PerceptionService({ capture, privacy, vision: new VisionChain({ profile: 'cloud', adapters: [adapter] }), now: () => 100 })
    await service.look_now()
    expect(() => privacy.update({ paused: true })).not.toThrow()
    expect(service.current().status).toBe('blocked-by-privacy')
    expect(() => capture.sourceChanged(false)).not.toThrow()
    expect(service.current().status).toBe('unavailable')
    await service.shutdown()
  })

  it('privacy changes during vision discard the late result', async () => {
    const pending = deferred<unknown>()
    const started = deferred<boolean>()
    const vision: VisionObservationPort = { id: 'slow', locality: 'cloud', capabilities: { vision: true, structured_output: true }, observe: () => {
      started.resolve(true)
      return pending.promise
    } }
    const f = fixture({ vision })
    const result = f.service.look_now()
    await started.promise
    f.privacy.update({ paused: true })
    expect((await result).status).toBe('blocked-by-privacy')
    pending.resolve(facts())
    await Promise.resolve()
    expect(f.service.current().status).toBe('blocked-by-privacy')
    await f.service.shutdown()
  })

  it('unknown automatic contexts fail closed while manual authorization is scoped to one call', async () => {
    let now = 100
    const f = fixture({ capture: async () => frame({ captured_at: now, safety: {} }) })
    expect((await f.service.tick()).status).toBe('blocked-by-privacy')
    expect((await f.service.look_now({ authorize_unknown: true })).status).toBe('fresh')
    now = 200
    f.time(now)
    expect((await f.service.tick()).status).toBe('blocked-by-privacy')
    expect(f.calls()).toBe(1)
    await f.service.shutdown()
  })

  it('rejects a frame older than the request and future timestamps', async () => {
    for (const captured_at of [50, 101]) {
      const f = fixture({ capture: async () => frame({ captured_at }) })
      expect((await f.service.look_now()).status).toBe('capture-failed')
      expect(f.calls()).toBe(0)
      await f.service.shutdown()
    }
  })

  it('source loss clears state and prevents capture', async () => {
    const f = fixture()
    await f.service.look_now()
    f.capture.sourceChanged(false)
    expect(f.service.current().status).toBe('unavailable')
    expect((await f.service.look_now()).status).toBe('unavailable')
    await f.service.shutdown()
  })

  it('fuses a disappearing object across meaningful changes without exposing the old scene during inference', async () => {
    let calls = 0
    let value = 100
    let now = 100
    const f = fixture({ capture: async () => frame({ captured_at: now, samples: new Uint8Array(2304).fill(value) }), vision: { id: 'fuse', locality: 'cloud', capabilities: { vision: true, structured_output: true }, observe: async () => facts({ notable_objects: calls++ === 0 ? ['dialog'] : [] }) } })
    await f.service.look_now()
    value = 125
    now = 1100
    f.time(now)
    const result = await f.service.look_now()
    expect(result.status === 'fresh' && result.uncertain_objects).toEqual(['dialog'])
    await f.service.shutdown()
  })

  it('rejects unbounded capture metadata before invoking vision', async () => {
    const f = fixture({ capture: async () => frame({ source: { ...frame().source, window_title: 'x'.repeat(257) } }) })
    expect((await f.service.look_now()).status).toBe('capture-failed')
    expect(f.calls()).toBe(0)
    await f.service.shutdown()
  })

  it('malformed output never reaches world state', async () => {
    const f = fixture({ vision: { id: 'bad', locality: 'cloud', capabilities: { vision: true, structured_output: true }, observe: async () => ({ prose: 'untrusted' }) } })
    expect((await f.service.look_now()).status).toBe('vlm-failed')
    await f.service.shutdown()
  })

  it('bounds a VLM timeout even if the adapter ignores AbortSignal', async () => {
    const f = fixture({ timeout_ms: 10, vision: { id: 'stuck', locality: 'cloud', capabilities: { vision: true, structured_output: true }, observe: () => new Promise(() => {}) } })
    expect((await f.service.look_now()).status).toBe('vlm-failed')
    await f.service.shutdown()
  })

  it('honors a provider rate-limit backoff across manual requests', async () => {
    let calls = 0
    const f = fixture({ vision: { id: 'limited', locality: 'cloud', capabilities: { vision: true, structured_output: true }, observe: async () => {
      calls++
      throw new PerceptionFailure('rate-limited', 60000)
    } } })
    expect((await f.service.look_now()).status).toBe('vlm-failed')
    f.time(10100)
    expect((await f.service.look_now()).status).toBe('vlm-failed')
    expect(calls).toBe(1)
    f.time(60100)
    await f.service.look_now()
    expect(calls).toBe(2)
    await f.service.shutdown()
  })

  it('manual cancellation returns promptly without publishing an observation', async () => {
    const pending = deferred<ScreenFrame>()
    const f = fixture({ capture: () => pending.promise })
    const controller = new AbortController()
    const result = f.service.look_now({}, controller.signal)
    controller.abort()
    expect((await result).status).toBe('unavailable')
    pending.resolve(frame())
    await f.service.shutdown()
  })

  it('shutdown cancels in-flight vision and rejects later requests', async () => {
    const started = deferred<boolean>()
    const f = fixture({ vision: { id: 'stuck', locality: 'cloud', capabilities: { vision: true, structured_output: true }, observe: () => {
      started.resolve(true)
      return new Promise(() => {})
    } } })
    const result = f.service.look_now()
    await started.promise
    await f.service.shutdown()
    expect((await result).status).toBe('unavailable')
    expect((await f.service.look_now()).status).toBe('unavailable')
  })

  it('older slower completion cannot overwrite a newer manual observation', async () => {
    const pending = deferred<unknown>()
    const started = deferred<boolean>()
    let calls = 0
    const f = fixture({ vision: { id: 'race', locality: 'cloud', capabilities: { vision: true, structured_output: true }, observe: () => {
      calls++
      if (calls === 1) {
        started.resolve(true)
        return pending.promise
      }
      return Promise.resolve(facts({ concise_summary: 'NEW' }))
    } } })
    const old = f.service.look_now()
    await started.promise
    f.time(200)
    const fresh = await f.service.look_now()
    expect(fresh.status === 'fresh' && fresh.observation.concise_summary).toBe('NEW')
    await old
    pending.resolve(facts({ concise_summary: 'OLD' }))
    await Promise.resolve()
    const current = f.service.current()
    expect(current.status === 'fresh' && current.observation.concise_summary).toBe('NEW')
    await f.service.shutdown()
  })
})

describe('vision profile and transport', () => {
  function adapter(locality: 'cloud' | 'local', observe = async () => facts()): VisionObservationPort {
    return { id: locality, locality, capabilities: { vision: true, structured_output: true }, observe }
  }

  it.each(['cloud', 'cloud-mura-voice'] as const)('%s never calls local vision', async (profile) => {
    const local = vi.fn(async () => facts())
    const chain = new VisionChain({ profile, adapters: [adapter('cloud', async () => {
      throw new PerceptionFailure('provider-error')
    }), adapter('local', local)], allow_local_fallback: true })
    await expect(chain.observe(frame(), new AbortController().signal, () => {})).rejects.toBeInstanceOf(PerceptionFailure)
    expect(local).not.toHaveBeenCalled()
  })

  it('hybrid permits only explicitly enabled local fallback, after cloud', async () => {
    const order: string[] = []
    const cloud = adapter('cloud', async () => {
      order.push('cloud')
      throw new PerceptionFailure('provider-error')
    })
    const local = adapter('local', async () => {
      order.push('local')
      return facts()
    })
    const chain = new VisionChain({ profile: 'hybrid', adapters: [local, cloud], allow_local_fallback: true })
    await chain.observe(frame(), new AbortController().signal, () => {})
    expect(order).toEqual(['cloud', 'local'])
    const disabled = new VisionChain({ profile: 'hybrid', adapters: [cloud, local] })
    await expect(disabled.observe(frame(), new AbortController().signal, () => {})).rejects.toBeInstanceOf(PerceptionFailure)
  })

  it('local needs an explicitly configured vision-capable local adapter', async () => {
    const cloud = vi.fn(async () => facts())
    await expect(new VisionChain({ profile: 'local', adapters: [adapter('cloud', cloud)] }).observe(frame(), new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'unconfigured' })
    expect(cloud).not.toHaveBeenCalled()
  })

  it('rechecks privacy between fallback attempts', async () => {
    let allowed = true
    const local = vi.fn(async () => facts())
    const chain = new VisionChain({ profile: 'hybrid', allow_local_fallback: true, adapters: [adapter('cloud', async () => {
      allowed = false
      throw new PerceptionFailure('provider-error')
    }), adapter('local', local)] })
    await expect(chain.observe(frame(), new AbortController().signal, () => {
      if (!allowed)
        throw new PerceptionFailure('privacy')
    })).rejects.toMatchObject({ code: 'privacy' })
    expect(local).not.toHaveBeenCalled()
  })

  it.each([429, 500])('bounds HTTP %s failures and excludes response contents from errors', async (status) => {
    const adapter = new OpenAiVisionAdapter({ id: 'configured', locality: 'cloud', base_url: 'https://example.com/v1/', model: 'configured-model', fetch: async () => new Response('SECRET', { status, headers: { 'retry-after': '5' } }) })
    await expect(adapter.observe({ frame: frame(), signal: new AbortController().signal })).rejects.toMatchObject({ code: status === 429 ? 'rate-limited' : 'provider-error' })
    try {
      await adapter.observe({ frame: frame(), signal: new AbortController().signal })
    }
    catch (error) { expect(String(error)).not.toContain('SECRET') }
  })

  it('sends a tool-free structured request with an untrusted-screen prompt', async () => {
    let body = ''
    const adapter = new OpenAiVisionAdapter({ id: 'configured', locality: 'cloud', base_url: 'https://example.com/v1/', model: 'configured-model', structured_output: true, fetch: async (_url, input) => {
      body = String(input?.body)
      return Response.json({ choices: [{ message: { content: JSON.stringify(facts()) } }] })
    } })
    await adapter.observe({ frame: frame(), signal: new AbortController().signal })
    const parsed = JSON.parse(body)
    expect(parsed.tools).toBeUndefined()
    expect(parsed.response_format.type).toBe('json_schema')
    expect(parsed.messages[0].content).toContain('untrusted')
    expect(parsed.messages[0].content).toContain('hidden intentions')
    const schema = parsed.response_format.json_schema.schema
    expect(schema.required).toEqual(expect.arrayContaining(Object.keys(schema.properties)))
    expect(schema.properties.people_count.type).toContain('null')
  })

  it('bounds retained requests when vision ignores cancellation', async () => {
    let calls = 0
    const stuck = adapter('cloud', () => {
      calls++
      return new Promise(() => {})
    })
    const chain = new VisionChain({ profile: 'cloud', adapters: [stuck] })
    for (let i = 0; i < 5; i++) {
      const controller = new AbortController()
      const result = chain.observe(frame(), controller.signal, () => {}).catch(() => {})
      await Promise.resolve()
      controller.abort()
      await result
    }
    expect(calls).toBe(2)
  })

  it('retains a cloud adapter rate-limit after a successful hybrid fallback', async () => {
    let calls = 0
    let now = 100
    const cloud = adapter('cloud', async () => {
      calls++
      throw new PerceptionFailure('rate-limited', 60000)
    })
    const chain = new VisionChain({ profile: 'hybrid', adapters: [cloud, adapter('local')], allow_local_fallback: true, now: () => now })
    await chain.observe(frame(), new AbortController().signal, () => {})
    now++
    await chain.observe(frame(), new AbortController().signal, () => {})
    expect(calls).toBe(1)
  })

  it('uses a healthy explicitly configured fallback after a primary attempt times out', async () => {
    const local = vi.fn(async () => facts())
    const chain = new VisionChain({ profile: 'hybrid', adapters: [adapter('cloud', () => new Promise(() => {})), adapter('local', local)], allow_local_fallback: true, attempt_timeout_ms: 5 })
    await expect(chain.observe(frame(), new AbortController().signal, () => {})).resolves.toMatchObject({ confidence: 0.9 })
    expect(local).toHaveBeenCalledTimes(1)
  })

  it('respects an HTTP-date retry-after value', async () => {
    const adapter = new OpenAiVisionAdapter({ id: 'limited', locality: 'cloud', base_url: 'https://example.com/v1/', model: 'configured', fetch: async () => new Response('', { status: 429, headers: { 'retry-after': new Date(Date.now() + 60000).toUTCString() } }) })
    try {
      await adapter.observe({ frame: frame(), signal: new AbortController().signal })
      expect.fail('Expected a rate limit')
    }
    catch (error) {
      expect(error).toBeInstanceOf(PerceptionFailure)
      if (error instanceof PerceptionFailure)
        expect(error.retry_after_ms).toBeGreaterThan(58000)
    }
  })
})
