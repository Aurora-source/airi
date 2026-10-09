import type { ModelCapabilities } from '../config/config'

/** Thinking efforts that the Gemini OpenAI-compatible endpoint accepts in `reasoning_effort`. Gemini 3 has no true off. */
export const THINKING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const
export type ThinkingEffort = typeof THINKING_EFFORTS[number]

/** USD per million tokens. Output includes thinking tokens. */
export interface TokenPrice {
  input: number
  cached: number
  output: number
}

/** One price that holds from `from` (inclusive, UTC) until the next entry starts. */
export interface DatedPrice extends TokenPrice {
  from: string
}

export interface GeminiCatalogEntry {
  /** Exact API model id, for example `gemini-3.8-flash`. */
  id: string
  label: string
  /** Levels that Google documents for this model. The Gateway sends no other level. */
  efforts: readonly ThinkingEffort[]
  /** The level that the provider uses when a request names none. */
  providerDefault: ThinkingEffort
  /** Standard paid text, image, and video prices, oldest first. */
  prices: readonly DatedPrice[]
}

/**
 * Paid Gemini models that Ops can select, verified on 2026-10-09 against Google's thinking table and pricing page.
 * Sources: https://ai.google.dev/gemini-api/docs/thinking and https://ai.google.dev/gemini-api/docs/pricing
 * Model discovery (`POST /ops/models/discover`) checks which ids the configured key can see.
 */
export const GEMINI_CATALOG: readonly GeminiCatalogEntry[] = Object.freeze([
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', efforts: ['minimal', 'low', 'medium', 'high'], providerDefault: 'minimal', prices: [{ from: '2026-01-01T00:00:00Z', input: 0.25, cached: 0.025, output: 1.5 }] },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', efforts: ['minimal', 'low', 'medium', 'high'], providerDefault: 'minimal', prices: [{ from: '2026-01-01T00:00:00Z', input: 0.3, cached: 0.03, output: 2.5 }] },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', efforts: ['minimal', 'low', 'medium', 'high'], providerDefault: 'medium', prices: [{ from: '2026-01-01T00:00:00Z', input: 1.5, cached: 0.15, output: 9 }] },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', efforts: ['minimal', 'low', 'medium', 'high'], providerDefault: 'medium', prices: flashPrices() },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', efforts: ['low', 'medium', 'high'], providerDefault: 'medium', prices: flashPrices() },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'], providerDefault: 'medium', prices: flashPrices() },
])

/** The day that the catalog was checked against Google's documentation. */
export const CATALOG_VERIFIED_AT = '2026-10-09'

/**
 * Provisional starting points from the paid benchmarks. They are not a personality ranking. Human review decides later.
 * No preset logic uses them: Ops shows them, and the user selects an exact model and effort.
 */
export const RECOMMENDED_SELECTIONS = Object.freeze([
  { role: 'default', model: 'gemini-3.8-flash', effort: 'low' },
  { role: 'faster', model: 'gemini-3.6-flash', effort: 'minimal' },
  { role: 'deliberate', model: 'gemini-3.8-flash', effort: 'medium' },
] as const)

/** What the router assumes about every catalog model: 1,048,576 input and 65,536 output tokens, tools, images, JSON. */
export const CATALOG_CAPABILITIES: ModelCapabilities = Object.freeze({
  contextWindow: 1_048_576,
  maxOutput: 65_536,
  streaming: true,
  tools: true,
  images: true,
  structuredOutput: true,
  imageTokens: 1120,
})

/** 3.6, 3.7, and 3.8 Flash cost twice as much from 2027-01-01, by Google's pricing page. */
function flashPrices(): DatedPrice[] {
  return [
    { from: '2026-01-01T00:00:00Z', input: 0.75, cached: 0.075, output: 3.75 },
    { from: '2027-01-01T00:00:00Z', input: 1.5, cached: 0.15, output: 7.5 },
  ]
}

export function catalogEntry(model: string): GeminiCatalogEntry | undefined {
  return GEMINI_CATALOG.find(entry => entry.id === model)
}

export function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return typeof value === 'string' && (THINKING_EFFORTS as readonly string[]).includes(value)
}

/**
 * The price of a catalog model at a time. Returns `undefined` for a model outside the catalog.
 *
 * @example
 * priceAt('gemini-3.8-flash', Date.parse('2027-02-01T00:00:00Z'))
 * // => { from: '2027-01-01T00:00:00Z', input: 1.5, cached: 0.15, output: 7.5 }
 */
export function priceAt(model: string, atMs: number): DatedPrice | undefined {
  const entry = catalogEntry(model)
  if (!entry)
    return undefined
  let current: DatedPrice | undefined
  for (const price of entry.prices) {
    if (Date.parse(price.from) <= atMs)
      current = price
  }
  return current
}
