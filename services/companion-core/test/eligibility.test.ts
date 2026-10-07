import type { WireMessage, WireRequest } from '../src/budget/wire'
import type { EligibilityContext } from '../src/routing/eligibility'

import { describe, expect, it } from 'vitest'

import { promptTokensOf } from '../src/budget/budgeter'
import { QuotaLedger } from '../src/quota/ledger'
import { evaluateModel } from '../src/routing/eligibility'
import { ModelHealth } from '../src/routing/health'
import { analyzeRequest } from '../src/routing/request-analysis'
import { openDatabase } from '../src/store/database'
import { catalogConfig, modelOf } from './support/catalog'
import { AIRI_TOOLS, assistant, assistantCalls, filler, system, toolCall, toolResult, user } from './support/wire'

const T0 = Date.parse('2026-10-07T12:00:00Z')

function setup(configOverrides: Record<string, unknown> = {}, keys: string[] = ['provider-gemini', 'provider-groq']) {
  const config = catalogConfig(configOverrides)
  const clock = { now: T0 }
  const ledger = new QuotaLedger(openDatabase(':memory:'), () => clock.now)
  const health = new ModelHealth({ baseCooldownMs: 10_000, maxCooldownMs: 300_000 }, () => clock.now)
  const context: EligibilityContext = {
    profile: config.profile,
    routing: config.routing,
    alias: config.aliases['companion-chat'],
    ledger,
    health,
    hasKey: model => !model.provider.keyRef || keys.includes(model.provider.keyRef),
  }
  const evaluate = (id: string, body: WireRequest) => evaluateModel(modelOf(config, id), body, analyzeRequest(body), context)
  return { config, clock, ledger, health, context, evaluate }
}

function request(messages: WireMessage[], extra: Record<string, unknown> = {}): WireRequest {
  return { model: 'companion-chat', stream: true, messages, ...extra }
}

/** A conversation of the size that R2A measured: a character card, a few turns, and AIRI's tools. */
function airiRequest(extra: Record<string, unknown> = {}, turns = 6): WireRequest {
  const messages: WireMessage[] = [system(filler(700, 'card'))]
  for (let i = 0; i < turns; i++)
    messages.push(user(filler(60, `u${i}`)), assistant(filler(80, `a${i}`)))
  messages.push(user('what is the weather in Osaka?'))
  return request(messages, { tools: AIRI_TOOLS, ...extra })
}

function expectSkip(result: ReturnType<ReturnType<typeof setup>['evaluate']>) {
  if ('candidate' in result)
    throw new Error(`expected a skip but got a candidate (${result.candidate.tier})`)
  return result.skip
}

function expectCandidate(result: ReturnType<ReturnType<typeof setup>['evaluate']>) {
  if (!('candidate' in result))
    throw new Error(`expected a candidate but got a skip: ${result.skip.reason} ${result.skip.detail ?? ''}`)
  return result.candidate
}

describe('evaluateModel capabilities', () => {
  it('admits a request that the model supports', () => {
    const candidate = expectCandidate(setup().evaluate('gemini-flash-lite', airiRequest()))

    expect(candidate.tier).toBe('full')
    expect(candidate.need).toMatchObject({ requests: 2 })
  })

  it('skips a model without tool support when the request offers tools', () => {
    const { evaluate } = setup({ profile: 'hybrid', aliases: { 'companion-chat': { chain: ['gemini-flash-lite', 'local-gemma'] } } })

    expect(expectSkip(evaluate('local-gemma', airiRequest()))).toMatchObject({ reason: 'CAPABILITY_TOOLS', category: 'ineligible' })
    expect('candidate' in evaluate('local-gemma', request([user('hi')]))).toBe(true)
  })

  it('skips a model without image input when a message holds an image', () => {
    const picture = { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }

    expect(expectSkip(setup().evaluate('groq-oss', request([system('c'), picture])))).toMatchObject({ reason: 'CAPABILITY_IMAGES' })
    expect('candidate' in setup().evaluate('groq-qwen', request([system('c'), picture]))).toBe(true)
  })

  it('skips a model without structured output when the request needs it', () => {
    const body = request([user('json please')], { response_format: { type: 'json_schema', json_schema: { name: 'x', schema: {} } } })

    expect(expectSkip(setup().evaluate('groq-qwen', body))).toMatchObject({ reason: 'CAPABILITY_STRUCTURED_OUTPUT' })
    expect('candidate' in setup().evaluate('groq-oss', body)).toBe(true)
  })

  it('skips a model that cannot stream when the client streams', () => {
    const { evaluate } = setup({ models: { 'groq-qwen': { ...catalogConfig().models['groq-qwen'], capabilities: { contextWindow: 131_072, streaming: false } } }, aliases: { 'companion-chat': { chain: ['groq-qwen'] } } })

    expect(expectSkip(evaluate('groq-qwen', request([user('hi')])))).toMatchObject({ reason: 'CAPABILITY_STREAMING' })
  })

  it('lets live probe results override the configuration', () => {
    const { config, context } = setup()
    const body = airiRequest()
    const probed = { ...context, capabilitiesOf: () => ({ ...modelOf(config, 'gemini-flash-lite').capabilities, tools: false }) }

    expect(expectSkip(evaluateModel(modelOf(config, 'gemini-flash-lite'), body, analyzeRequest(body), probed))).toMatchObject({ reason: 'CAPABILITY_TOOLS' })
  })
})

describe('evaluateModel profile and key', () => {
  it('skips a local model in a cloud profile, even when it sits in a chain that bypassed validation', () => {
    const { config, context } = setup({ profile: 'hybrid', aliases: { 'companion-chat': { chain: ['gemini-flash-lite', 'local-gemma'] } } })
    const body = request([user('hi')])
    const cloudOnly = { ...context, profile: 'cloud-mura-voice' as const }

    expect(expectSkip(evaluateModel(modelOf(config, 'local-gemma'), body, analyzeRequest(body), cloudOnly))).toMatchObject({ reason: 'PROFILE_FORBIDS_LOCAL', category: 'ineligible' })
  })

  it('skips a cloud model in the local profile and admits a local model in the hybrid profile', () => {
    const local = setup({ profile: 'local', aliases: { 'companion-chat': { chain: ['local-gemma'] } } })
    const hybrid = setup({ profile: 'hybrid', aliases: { 'companion-chat': { chain: ['gemini-flash-lite', 'local-gemma'] } } })
    const body = request([user('hi')])

    expect(expectSkip(local.evaluate('gemini-flash-lite', body))).toMatchObject({ reason: 'PROFILE_FORBIDS_CLOUD' })
    expect('candidate' in hybrid.evaluate('local-gemma', body)).toBe(true)
  })

  it('skips a cloud model whose key is missing', () => {
    expect(expectSkip(setup({}, ['provider-gemini']).evaluate('groq-qwen', request([user('hi')])))).toMatchObject({ reason: 'KEY_MISSING', category: 'ineligible' })
  })
})

describe('evaluateModel context and rate budget', () => {
  it('skips a model whose context window is too small, as ineligible and never unhealthy', () => {
    const { evaluate } = setup({ profile: 'hybrid', models: { ...catalogConfig().models, 'local-gemma': { provider: 'ollama', model: 'gemma4', capabilities: { contextWindow: 4096, maxOutput: 512, tools: true } } }, aliases: { 'companion-chat': { chain: ['gemini-flash-lite', 'local-gemma'] } } })

    // The character card and the tool schemas alone take about 3,800 tokens. The model leaves 3,300 after its output reserve.
    const skip = expectSkip(evaluate('local-gemma', request([system(filler(1500, 'card')), user('hi')], { tools: AIRI_TOOLS })))

    expect(skip).toMatchObject({ reason: 'CONTEXT_TOO_SMALL', category: 'ineligible' })
  })

  it('trims history to the model maxPrompt and never sends more than it', () => {
    const { evaluate } = setup({ models: { ...catalogConfig().models, 'gemini-flash-lite': { ...catalogConfig().models['gemini-flash-lite'], capabilities: { ...catalogConfig().models['gemini-flash-lite'].capabilities, maxPrompt: 5000 } } } })

    const candidate = expectCandidate(evaluate('gemini-flash-lite', airiRequest({}, 40)))

    expect(candidate.maxPromptTokens).toBe(5000)
    expect(promptTokensOf(candidate.diagnostics)).toBeLessThanOrEqual(5000)
    expect(candidate.budget.status).toBe('trimmed')
  })

  it('trims history to the soft prompt target of the alias', () => {
    // The card and tools take about 3,000 tokens, so 4,000 leaves room for a few turns.
    const { evaluate } = setup({ aliases: { 'companion-chat': { chain: ['gemini-flash-lite'], prompt: { softTarget: 4000, mode: 'soft' } } } })

    const candidate = expectCandidate(evaluate('gemini-flash-lite', airiRequest({}, 80)))

    expect(promptTokensOf(candidate.diagnostics)).toBeLessThanOrEqual(4000)
    expect(candidate.budget.status).toBe('trimmed')
  })

  it('sends a request larger than the soft target when the fixed part alone is larger, as long as the model fits it', () => {
    const { evaluate } = setup({ aliases: { 'companion-chat': { chain: ['gemini-flash-lite'], prompt: { softTarget: 1000, mode: 'soft' } } } })

    const candidate = expectCandidate(evaluate('gemini-flash-lite', airiRequest({}, 2)))

    expect(promptTokensOf(candidate.diagnostics)).toBeGreaterThan(1000)
    expect(candidate.budget.status).not.toBe('impossible')
  })

  it('picks the expanded target when tools were busy in recent turns', () => {
    const busy: WireMessage[] = [system('card')]
    for (let i = 0; i < 3; i++)
      busy.push(user(`q${i}`), assistantCalls([toolCall(`c${i}`, 'f')]), toolResult(`c${i}`, filler(100, 'r')), assistant('done'))
    busy.push(user('next'))
    const { evaluate } = setup({ aliases: { 'companion-chat': { chain: ['gemini-flash-lite'], prompt: { softTarget: 600, expandedTarget: 100_000, mode: 'auto' } } } })

    const candidate = expectCandidate(evaluate('gemini-flash-lite', request(busy)))

    // Soft target 600 would trim the three tool turns. The expanded target keeps them.
    expect(candidate.budget.status).toBe('fits')
  })

  it('skips a model whose per-minute token limit cannot carry the whole tool turn, before anything is sent', () => {
    const { evaluate } = setup()

    // A request that must call a tool: both rounds have to fit in one minute. Groq qwen allows 7,000 input tokens per minute.
    const skip = expectSkip(evaluate('groq-qwen', airiRequest({ tool_choice: 'required' })))

    expect(skip).toMatchObject({ reason: 'TPM_INELIGIBLE', category: 'ineligible' })
    expect(skip.detail).toContain('7000')
  })

  it('still admits a small conversation without tools on the same model', () => {
    const candidate = expectCandidate(setup().evaluate('groq-qwen', request([system(filler(300, 's')), user('hello there')])))

    expect(candidate.tier).toBe('full')
    expect(candidate.need).toMatchObject({ requests: 1 })
  })

  it('admits a tool-offering turn on a tight model for its first round only, as a last resort tier', () => {
    const candidate = expectCandidate(setup().evaluate('groq-qwen', airiRequest()))

    expect(candidate.tier).toBe('first-round-only')
    expect(candidate.need.requests).toBe(1)
  })

  it('never uses the first-round-only tier when the configuration forbids it', () => {
    const { evaluate } = setup({ routing: { allowFirstRoundOnly: false } })

    expect(expectSkip(evaluate('groq-qwen', airiRequest()))).toMatchObject({ reason: 'TPM_INELIGIBLE' })
  })

  it('skips the second round of a tool turn on Groq when the first round used the minute budget', () => {
    const { evaluate, ledger, clock } = setup()
    const first = airiRequest()
    const firstCandidate = expectCandidate(evaluate('groq-qwen', first))
    ledger.finish(ledger.begin('provider-groq|qwen/qwen3.8-27b', promptTokensOf(firstCandidate.diagnostics)), { counted: true })
    clock.now += 4000

    const second = request([...first.messages!, assistantCalls([toolCall('w', 'get_weather', { location: 'Osaka' })]), toolResult('w', '21C')], { tools: AIRI_TOOLS })
    const skip = expectSkip(evaluate('groq-qwen', second))

    expect(skip).toMatchObject({ reason: 'TPM_WINDOW_FULL', category: 'unavailable' })
    expect(skip.retryAtMs).toBe(T0 + 60_000)
  })

  it('sizes the prompt with the learned calibration of the model', () => {
    const { evaluate, health } = setup()
    const body = airiRequest()
    const before = promptTokensOf(expectCandidate(evaluate('gemini-flash-lite', body)).diagnostics)
    for (let i = 0; i < 60; i++)
      health.recordUsage('gemini-flash-lite', 10_000 * health.calibration('gemini-flash-lite'), 8000)

    const after = promptTokensOf(expectCandidate(evaluate('gemini-flash-lite', body)).diagnostics)

    expect(after).toBeLessThan(before)
  })
})

describe('evaluateModel quota and health', () => {
  it('skips a model whose daily quota is spent, as unavailable until the reset', () => {
    const { evaluate, ledger } = setup()
    for (let i = 0; i < 500; i++)
      ledger.finish(ledger.begin('provider-gemini|gemini-3.5-flash-lite', 100), { counted: true })

    const skip = expectSkip(evaluate('gemini-flash-lite', airiRequest()))

    expect(skip).toMatchObject({ reason: 'RPD_EXHAUSTED', category: 'unavailable' })
    expect(skip.retryAtMs).toBe(Date.parse('2026-10-08T00:00:00-07:00'))
  })

  it('counts both rounds of a tool turn against the per-minute request limit', () => {
    const { evaluate, ledger } = setup()
    for (let i = 0; i < 14; i++)
      ledger.finish(ledger.begin('provider-gemini|gemini-3.5-flash-lite', 100), { counted: true })

    // One request slot is free. The full tier needs two, so the first-round-only tier takes the turn.
    expect(expectCandidate(evaluate('gemini-flash-lite', airiRequest())).tier).toBe('first-round-only')
  })

  it('skips a model that is cooling down after a rate limit', () => {
    const { evaluate, ledger } = setup()
    ledger.noteRateLimit('provider-gemini|gemini-3.5-flash-lite', {}, { kind: 'rate-limited', window: 'minute', unit: 'requests', retryAfterMs: 30_000 })

    expect(expectSkip(evaluate('gemini-flash-lite', airiRequest()))).toMatchObject({ reason: 'COOLING_DOWN', category: 'unavailable', retryAtMs: T0 + 30_000 })
  })

  it('skips a model that failed recently, as unhealthy', () => {
    const { evaluate, health } = setup()
    health.recordFailure('gemini-flash-lite', 'network')

    expect(expectSkip(evaluate('gemini-flash-lite', airiRequest()))).toMatchObject({ reason: 'UNHEALTHY', category: 'unavailable', retryAtMs: T0 + 10_000 })
  })

  it('reports ineligible for a request that no wait can fix, before it reports a cool-down', () => {
    const { evaluate, health } = setup()
    health.recordFailure('groq-qwen', 'network')

    expect(expectSkip(evaluate('groq-qwen', airiRequest({ tool_choice: 'required' })))).toMatchObject({ reason: 'TPM_INELIGIBLE' })
  })
})

describe('evaluateModel with a history that is not valid', () => {
  it('passes it through untrimmed and admits it only when it fits the model as it is', () => {
    const broken = request([system('c'), user(filler(500, 'a')), toolResult('x', 'orphan'), user(filler(500, 'b'))])

    const candidate = expectCandidate(setup().evaluate('gemini-flash-lite', broken))

    expect(candidate.budget.status).toBe('untrimmed')
    expect(candidate.body).toBe(broken)
  })
})
