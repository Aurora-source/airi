import { describe, expect, it } from 'vitest'

import { parseConfig, resolveAlias } from '../src/config/config'

const GEMINI = { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', keyRef: 'provider-gemini', compat: 'gemini' }
const GROQ = { baseURL: 'https://api.groq.com/openai/v1/', keyRef: 'provider-groq' }
const OLLAMA = { baseURL: 'http://127.0.0.1:11434/v1/', locality: 'local' }

const GEMINI_MODEL = {
  provider: 'gemini',
  model: 'gemini-3.5-flash-lite',
  capabilities: { contextWindow: 1_000_000, maxOutput: 8192, tools: true, images: true, structuredOutput: true },
  limits: { rpm: 15, rpd: 500, tpm: 250_000, dayReset: { timeZone: 'America/Los_Angeles' } },
}
const GROQ_MODEL = {
  provider: 'groq',
  model: 'qwen/qwen3.8-27b',
  capabilities: { contextWindow: 131_072, maxOutput: 8192, tools: true, images: true },
  limits: { rpm: 30, rpd: 1000, tpm: 7000, tpd: 200_000 },
}
const OLLAMA_MODEL = {
  provider: 'ollama',
  model: 'gemma4',
  capabilities: { contextWindow: 4096, maxOutput: 512, tools: false },
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    port: 0,
    providers: { gemini: GEMINI, groq: GROQ, ollama: OLLAMA },
    models: { 'gemini-flash-lite': GEMINI_MODEL, 'groq-qwen': GROQ_MODEL, 'local-gemma': OLLAMA_MODEL },
    aliases: { 'companion-chat': { chain: ['gemini-flash-lite', 'groq-qwen'] } },
    ...overrides,
  }
}

describe('parseConfig catalog', () => {
  it('applies capability and limit defaults', () => {
    const parsed = parseConfig(config())

    expect(parsed.profile).toBe('cloud-mura-voice')
    expect(parsed.models['groq-qwen'].capabilities).toMatchObject({ streaming: true, tools: true, images: true, structuredOutput: false })
    expect(parsed.models['groq-qwen'].limits.tpmBasis).toBe('input')
    expect(parsed.models['groq-qwen'].limits.dayReset).toBe('rolling')
    expect(parsed.aliases['companion-chat'].role).toBe('conversation')
    expect(parsed.aliases['companion-chat'].prompt).toMatchObject({ softTarget: 20_000, expandedTarget: 30_000, maxTarget: 50_000, mode: 'auto' })
  })

  it('resolves an alias into ordered model entries with their provider and locality', () => {
    const parsed = parseConfig(config())

    const chain = resolveAlias(parsed, 'companion-chat')!

    expect(chain.map(entry => entry.id)).toEqual(['gemini-flash-lite', 'groq-qwen'])
    expect(chain[0]).toMatchObject({ providerName: 'gemini', locality: 'cloud', model: 'gemini-3.5-flash-lite', scope: 'provider-gemini|gemini-3.5-flash-lite' })
    expect(chain[0].provider.compat).toBe('gemini')
    expect(resolveAlias(parsed, 'nope')).toBeUndefined()
  })

  it('derives the hard prompt limit from the context window, output reserve, and an explicit maxPrompt', () => {
    const parsed = parseConfig(config({
      models: { 'groq-qwen': { ...GROQ_MODEL, capabilities: { ...GROQ_MODEL.capabilities, contextWindow: 10_000, maxOutput: 2000, maxPrompt: 7000 } } },
      aliases: { a: { chain: ['groq-qwen'] } },
    }))

    expect(parsed.models['groq-qwen'].capabilities.maxPrompt).toBe(7000)
  })

  it.each([
    ['an alias that names an unknown model', { aliases: { a: { chain: ['missing'] } } }, /unknown model "missing"/],
    ['a model that names an unknown provider', { models: { m: { ...GROQ_MODEL, provider: 'nope' } }, aliases: { a: { chain: ['m'] } } }, /unknown provider "nope"/],
    ['an empty chain', { aliases: { a: { chain: [] } } }, /chain/],
    ['a cloud provider without a key reference', { providers: { groq: { baseURL: GROQ.baseURL } }, models: { 'groq-qwen': GROQ_MODEL }, aliases: { a: { chain: ['groq-qwen'] } } }, /needs a keyRef/],
    ['a base URL without a trailing slash', { providers: { groq: { ...GROQ, baseURL: 'https://api.groq.com/openai/v1' } } }, /baseURL/],
    ['a non-loopback host', { host: '0.0.0.0' }, /host/],
  ])('rejects %s', (_name, overrides, message) => {
    expect(() => parseConfig(config(overrides))).toThrow(message)
  })
})

describe('parseConfig profiles', () => {
  it.each(['cloud', 'cloud-mura-voice'])('rejects a local inference model in a %s chain', (profile) => {
    expect(() => parseConfig(config({ profile, aliases: { 'companion-chat': { chain: ['gemini-flash-lite', 'local-gemma'] } } })))
      .toThrow(/profile "[a-z-]+" does not allow the local model "local-gemma"/)
  })

  it('allows a local fallback in a hybrid chain only after every cloud model', () => {
    expect(() => parseConfig(config({ profile: 'hybrid', aliases: { a: { chain: ['gemini-flash-lite', 'groq-qwen', 'local-gemma'] } } }))).not.toThrow()
    expect(() => parseConfig(config({ profile: 'hybrid', aliases: { a: { chain: ['local-gemma', 'gemini-flash-lite'] } } })))
      .toThrow(/local model "local-gemma" must come after every cloud model/)
  })

  it('allows only local models in a local profile', () => {
    expect(() => parseConfig(config({ profile: 'local', aliases: { a: { chain: ['local-gemma'] } } }))).not.toThrow()
    expect(() => parseConfig(config({ profile: 'local', aliases: { a: { chain: ['gemini-flash-lite'] } } })))
      .toThrow(/profile "local" does not allow the cloud model "gemini-flash-lite"/)
  })

  it('keeps an unused local provider valid in a cloud profile, because only chains decide', () => {
    expect(() => parseConfig(config({ profile: 'cloud' }))).not.toThrow()
  })
})
