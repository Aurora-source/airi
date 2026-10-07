import type { CompanionConfig, ResolvedModel } from '../../src/config/config'

import { parseConfig, resolveModel } from '../../src/config/config'

/**
 * Provider and model entries with the limits that the providers published and that R2A measured:
 * Gemini free tier with a 1M context, and Groq free tier with 7,000 input tokens per minute on qwen3.8 and 8,000 on gpt-oss.
 * The names are test data. The architecture reads them from configuration.
 */
export const PROVIDERS = {
  gemini: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', keyRef: 'provider-gemini', compat: 'gemini' },
  groq: { baseURL: 'https://api.groq.com/openai/v1/', keyRef: 'provider-groq' },
  ollama: { baseURL: 'http://127.0.0.1:11434/v1/', locality: 'local' },
}

export const MODELS = {
  'gemini-flash-lite': {
    provider: 'gemini',
    model: 'gemini-3.5-flash-lite',
    capabilities: { contextWindow: 1_000_000, maxOutput: 8192, tools: true, images: true, structuredOutput: true, imageTokens: 1100 },
    limits: { rpm: 15, rpd: 500, tpm: 250_000, dayReset: { timeZone: 'America/Los_Angeles' } },
  },
  'groq-qwen': {
    provider: 'groq',
    model: 'qwen/qwen3.8-27b',
    capabilities: { contextWindow: 131_072, maxOutput: 8192, tools: true, images: true, imageTokens: 2048 },
    limits: { rpm: 30, rpd: 1000, tpm: 7000, tpd: 200_000 },
  },
  'groq-oss': {
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    capabilities: { contextWindow: 131_072, maxOutput: 8192, tools: true, images: false, structuredOutput: true },
    limits: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200_000 },
  },
  'local-gemma': {
    provider: 'ollama',
    model: 'gemma4',
    capabilities: { contextWindow: 4096, maxOutput: 512, tools: false },
  },
}

export function catalogConfig(overrides: Record<string, unknown> = {}): CompanionConfig {
  return parseConfig({
    port: 0,
    store: { path: ':memory:' },
    providers: PROVIDERS,
    models: MODELS,
    aliases: { 'companion-chat': { chain: ['gemini-flash-lite', 'groq-qwen', 'groq-oss'] } },
    ...overrides,
  })
}

export function modelOf(config: CompanionConfig, id: string): ResolvedModel {
  const model = resolveModel(config, id)
  if (!model)
    throw new Error(`unknown test model ${id}`)
  return model
}
