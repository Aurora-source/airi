import type { WireMessage, WireRequest } from '../src/budget/wire'
import type { CompanionConfig } from '../src/config/config'
import type { RoutePlan } from '../src/routing/router'

import { describe, expect, it } from 'vitest'

import { QuotaLedger } from '../src/quota/ledger'
import { ModelHealth } from '../src/routing/health'
import { Router } from '../src/routing/router'
import { StickyStore } from '../src/routing/sticky'
import { openDatabase } from '../src/store/database'
import { catalogConfig } from './support/catalog'
import { AIRI_TOOLS, assistant, filler, system, user } from './support/wire'

const T0 = new Date(2026, 9, 7, 12, 0, 0).getTime()
const HOUR = 3_600_000
const GEMINI_SCOPE = 'provider-gemini|gemini-3.5-flash-lite'
const QWEN_SCOPE = 'provider-groq|qwen/qwen3.8-27b'
const OSS_SCOPE = 'provider-groq|openai/gpt-oss-120b'

function setup(config: CompanionConfig = catalogConfig(), keys: string[] = ['provider-gemini', 'provider-groq']) {
  const clock = { now: T0 }
  const db = openDatabase(':memory:')
  const ledger = new QuotaLedger(db, () => clock.now)
  const health = new ModelHealth({ baseCooldownMs: 10_000, maxCooldownMs: 300_000 }, () => clock.now)
  const sticky = new StickyStore(db, () => clock.now, { idleMs: config.routing.stickyIdleMinutes * 60_000, resetHour: config.routing.stickyResetHour })
  const router = new Router({ config, ledger, health, sticky, hasKey: model => !model.provider.keyRef || keys.includes(model.provider.keyRef), now: () => clock.now })
  return { config, clock, ledger, health, sticky, router }
}

/** A casual chat with the 700-token character card of R2A. Add tools and its fixed part no longer fits a 7k-per-minute model twice. */
function chat(extra: Record<string, unknown> = {}, model = 'companion-chat'): WireRequest {
  const messages: WireMessage[] = [system(filler(700, 'card')), user('Hello Mura, it is me'), assistant('Hi!'), user('how are you?')]
  return { model, stream: true, messages, ...extra }
}

function toolChat(extra: Record<string, unknown> = {}, model = 'companion-chat'): WireRequest {
  return chat({ tools: AIRI_TOOLS, ...extra }, model)
}

function planOf(result: ReturnType<Router['plan']>): Extract<RoutePlan, { ok: true }> {
  if (!result.ok)
    throw new Error(`expected a plan but got ${result.error.status} ${result.error.code}: ${result.error.message}`)
  return result
}

function ids(plan: Extract<RoutePlan, { ok: true }>) {
  return plan.candidates.map(candidate => candidate.model.id)
}

describe('router chain order', () => {
  it('offers the chain in order when every model can take the request', () => {
    const plan = planOf(setup().router.plan(chat()))

    expect(ids(plan)).toEqual(['gemini-flash-lite', 'groq-qwen', 'groq-oss'])
    expect(plan.skipped).toEqual([])
    expect(plan.alias).toBe('companion-chat')
  })

  it('puts a model that fits only the first round of a tool turn behind every model that fits the whole turn', () => {
    const { router } = setup(catalogConfig({ aliases: { 'companion-chat': { chain: ['groq-qwen', 'gemini-flash-lite', 'groq-oss'] } } }))

    const plan = planOf(router.plan(toolChat()))

    // Groq qwen allows 7,000 tokens per minute and fits only the first round. Groq gpt-oss allows 8,000 and fits both rounds.
    expect(ids(plan)).toEqual(['gemini-flash-lite', 'groq-oss', 'groq-qwen'])
    expect(plan.candidates.map(candidate => candidate.tier)).toEqual(['full', 'full', 'first-round-only'])
  })

  it('moves past a resting head to the next model and names the head in the skipped list', () => {
    const { router, ledger } = setup()
    ledger.noteRateLimit(GEMINI_SCOPE, {}, { kind: 'rate-limited', window: 'minute', unit: 'requests', retryAfterMs: 20_000 })

    const plan = planOf(router.plan(chat()))

    expect(ids(plan)).toEqual(['groq-qwen', 'groq-oss'])
    expect(plan.skipped).toEqual([expect.objectContaining({ modelId: 'gemini-flash-lite', reason: 'COOLING_DOWN', category: 'unavailable' })])
  })
})

describe('router health', () => {
  it('tries a model that failed recently after every healthy model, and does not refuse it', () => {
    const { router, health } = setup()
    health.recordFailure('gemini-flash-lite', 'network')

    const plan = planOf(router.plan(chat()))

    expect(ids(plan)).toEqual(['groq-qwen', 'groq-oss', 'gemini-flash-lite'])
    expect(plan.skipped).toEqual([])
  })

  it('still tries the only model of a chain after it failed, so that one dropped stream does not stop the service', () => {
    const { router, health } = setup(catalogConfig({ aliases: { 'companion-chat': { chain: ['gemini-flash-lite'] } } }))
    health.recordFailure('gemini-flash-lite', 'network')

    expect(ids(planOf(router.plan(chat())))).toEqual(['gemini-flash-lite'])
  })

  it('moves a sticky model that is resting behind the healthy ones, because the conversation leaves a failing model', () => {
    const { router, health, sticky } = setup()
    sticky.set('companion-chat', planOf(router.plan(chat())).conversationKey, 'groq-qwen', 'served')
    health.recordFailure('groq-qwen', 'server')

    expect(ids(planOf(router.plan(chat())))).toEqual(['gemini-flash-lite', 'groq-oss', 'groq-qwen'])
  })
})

describe('router stickiness', () => {
  it('keeps the model that served the conversation, even when the head is free again', () => {
    const { router, sticky } = setup()
    const first = planOf(router.plan(chat()))
    sticky.set('companion-chat', first.conversationKey, 'groq-qwen', 'failover')

    const plan = planOf(router.plan(chat()))

    expect(ids(plan)).toEqual(['groq-qwen', 'gemini-flash-lite', 'groq-oss'])
    expect(plan.stickyModelId).toBe('groq-qwen')
  })

  it('applies to the conversation only: another conversation starts at the head', () => {
    const { router, sticky } = setup()
    sticky.set('companion-chat', planOf(router.plan(chat())).conversationKey, 'groq-qwen', 'failover')
    const other: WireRequest = { model: 'companion-chat', messages: [system('card'), user('a completely different opening')] }

    expect(ids(planOf(router.plan(other)))[0]).toBe('gemini-flash-lite')
  })

  it('moves on when the sticky model cannot take the request, and says so', () => {
    const { router, sticky, ledger } = setup()
    const key = planOf(router.plan(chat())).conversationKey
    sticky.set('companion-chat', key, 'groq-qwen', 'served')
    ledger.noteRateLimit(QWEN_SCOPE, {}, { kind: 'rate-limited', window: 'day', unit: 'tokens', retryAfterMs: HOUR })

    const plan = planOf(router.plan(chat()))

    expect(ids(plan)).toEqual(['gemini-flash-lite', 'groq-oss'])
    expect(plan.skipped[0]).toMatchObject({ modelId: 'groq-qwen', reason: 'COOLING_DOWN' })
  })

  it('does not let stickiness outrank the tier: a whole-turn model comes before a sticky first-round-only model', () => {
    const { router, sticky } = setup()
    const key = planOf(router.plan(toolChat())).conversationKey
    sticky.set('companion-chat', key, 'groq-qwen', 'served')

    const plan = planOf(router.plan(toolChat()))

    expect(ids(plan)).toEqual(['gemini-flash-lite', 'groq-oss', 'groq-qwen'])
  })

  it('forgets a choice after the idle time', () => {
    const { router, sticky, clock } = setup()
    sticky.set('companion-chat', planOf(router.plan(chat())).conversationKey, 'groq-qwen', 'served')

    clock.now += 7 * HOUR

    expect(ids(planOf(router.plan(chat())))[0]).toBe('gemini-flash-lite')
  })

  it('forgets a choice at the configured daily reset hour', () => {
    const config = catalogConfig({ routing: { stickyResetHour: 4, stickyIdleMinutes: 5000 } })
    const { router, sticky, clock } = setup(config)
    // Chosen at 22:00 the evening before, reset at 04:00, asked at 12:00 the next day.
    clock.now = new Date(2026, 9, 6, 22, 0, 0).getTime()
    sticky.set('companion-chat', planOf(router.plan(chat())).conversationKey, 'groq-qwen', 'served')
    clock.now = new Date(2026, 9, 7, 3, 59, 0).getTime()
    expect(ids(planOf(router.plan(chat())))[0]).toBe('groq-qwen')

    clock.now = new Date(2026, 9, 7, 4, 1, 0).getTime()
    expect(ids(planOf(router.plan(chat())))[0]).toBe('gemini-flash-lite')
  })

  it('keeps the sticky model when a failover moved it, until a reset', () => {
    const { router, sticky } = setup()
    const key = planOf(router.plan(chat())).conversationKey

    sticky.set('companion-chat', key, 'groq-qwen', 'failover:rate-limited')

    expect(sticky.get('companion-chat', key)).toMatchObject({ modelId: 'groq-qwen', reason: 'failover:rate-limited' })
  })
})

describe('router explicit override', () => {
  it('serves only the pinned model when the model name is alias:model', () => {
    const { router } = setup()

    const plan = planOf(router.plan(chat({}, 'companion-chat:groq-oss')))

    expect(ids(plan)).toEqual(['groq-oss'])
    expect(plan.pinned).toBe('groq-oss')
    expect(plan.alias).toBe('companion-chat')
  })

  it('ignores stickiness for a pinned request', () => {
    const { router, sticky } = setup()
    sticky.set('companion-chat', planOf(router.plan(chat())).conversationKey, 'groq-qwen', 'served')

    expect(ids(planOf(router.plan(chat({}, 'companion-chat:gemini-flash-lite'))))).toEqual(['gemini-flash-lite'])
  })

  it('reports an unknown pin as model not found', () => {
    const result = setup().router.plan(chat({}, 'companion-chat:nope'))

    expect(result).toMatchObject({ ok: false, error: { status: 404, code: 'model_not_found' } })
  })

  it('reports an unknown alias as model not found', () => {
    expect(setup().router.plan(chat({}, 'nothing'))).toMatchObject({ ok: false, error: { status: 404, code: 'model_not_found' } })
  })

  it('does not fall back from a pinned model that cannot take the request, and names the reason', () => {
    const { router } = setup()

    const result = router.plan(toolChat({ tool_choice: 'required' }, 'companion-chat:groq-qwen'))

    expect(result).toMatchObject({ ok: false, error: { status: 413, code: 'request_too_large' } })
    if (!result.ok)
      expect(result.error.message).toContain('TPM_INELIGIBLE')
  })
})

describe('router errors', () => {
  it('answers 429 with the earliest retry time when every model is only resting', () => {
    const { router, ledger } = setup()
    ledger.noteRateLimit(GEMINI_SCOPE, {}, { kind: 'rate-limited', window: 'minute', unit: 'requests', retryAfterMs: 30_000 })
    ledger.noteRateLimit(QWEN_SCOPE, {}, { kind: 'rate-limited', window: 'minute', unit: 'requests', retryAfterMs: 12_000 })
    ledger.noteRateLimit(OSS_SCOPE, {}, { kind: 'rate-limited', window: 'minute', unit: 'requests', retryAfterMs: 45_000 })

    const result = router.plan(chat())

    expect(result).toMatchObject({ ok: false, error: { status: 429, code: 'rate_limit_exceeded', retryAfterMs: 12_000 } })
    if (!result.ok)
      expect(result.error.skipped.map(skip => skip.modelId)).toEqual(['gemini-flash-lite', 'groq-qwen', 'groq-oss'])
  })

  it('answers 413 when the request is too large for every model, and never blames provider health', () => {
    const { router } = setup(catalogConfig({ aliases: { 'companion-chat': { chain: ['groq-qwen', 'groq-oss'] } } }))

    // A 1,200-token card and the tool schemas leave neither Groq model room for both rounds of a forced tool call.
    const result = router.plan(toolChat({ tool_choice: 'required', messages: [system(filler(1200, 'card')), user('hi')] }))

    expect(result).toMatchObject({ ok: false, error: { status: 413, code: 'request_too_large' } })
  })

  it('answers 400 when no model supports what the request needs', () => {
    const { router } = setup(catalogConfig({ aliases: { 'companion-chat': { chain: ['groq-oss'] } } }))
    const picture = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }

    const result = router.plan({ model: 'companion-chat', messages: [system('c'), picture] })

    expect(result).toMatchObject({ ok: false, error: { status: 400, code: 'unsupported_request' } })
  })

  it('answers 503 when no provider key is stored', () => {
    const { router } = setup(catalogConfig(), [])

    expect(router.plan(chat())).toMatchObject({ ok: false, error: { status: 503, code: 'no_provider_available' } })
  })
})

describe('router compute profiles', () => {
  const hybrid = catalogConfig({ profile: 'hybrid', aliases: { 'companion-chat': { chain: ['gemini-flash-lite', 'groq-qwen', 'local-gemma'] } } })

  it('never offers a local model in a cloud profile, even when a chain holds one', () => {
    // Configuration validation rejects this chain. The router checks again, so that a bad state cannot start local inference.
    const { router, ledger } = setup({ ...hybrid, profile: 'cloud-mura-voice' })
    ledger.noteRateLimit(GEMINI_SCOPE, {}, { kind: 'rate-limited', window: 'day', unit: 'requests', retryAfterMs: HOUR })
    ledger.noteRateLimit(QWEN_SCOPE, {}, { kind: 'rate-limited', window: 'day', unit: 'requests', retryAfterMs: HOUR })

    const result = router.plan(chat())

    expect(result).toMatchObject({ ok: false, error: { status: 429 } })
    if (!result.ok)
      expect(result.error.skipped.find(skip => skip.modelId === 'local-gemma')).toMatchObject({ reason: 'PROFILE_FORBIDS_LOCAL' })
  })

  it('falls back to the local model in a hybrid profile when the cloud models are out', () => {
    const { router, ledger } = setup(hybrid)
    ledger.noteRateLimit(GEMINI_SCOPE, {}, { kind: 'rate-limited', window: 'day', unit: 'requests', retryAfterMs: HOUR })
    ledger.noteRateLimit(QWEN_SCOPE, {}, { kind: 'rate-limited', window: 'day', unit: 'requests', retryAfterMs: HOUR })

    expect(ids(planOf(router.plan(chat())))).toEqual(['local-gemma'])
  })

  it('keeps the local model behind the cloud models while they work', () => {
    expect(ids(planOf(setup(hybrid).router.plan(chat())))).toEqual(['gemini-flash-lite', 'groq-qwen', 'local-gemma'])
  })
})
