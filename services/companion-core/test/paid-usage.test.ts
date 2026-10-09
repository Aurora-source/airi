import { describe, expect, it } from 'vitest'

import { catalogEntry, GEMINI_CATALOG, priceAt } from '../src/paid/gemini-catalog'
import { costNano, normalizeUsage } from '../src/paid/usage'

describe('gemini catalog', () => {
  it('lists the exact paid model ids with the levels that Google documents', () => {
    expect(GEMINI_CATALOG.map(entry => entry.id)).toEqual(['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash'])
    expect(catalogEntry('gemini-3.8-flash')?.efforts).toEqual(['low', 'medium', 'high'])
    expect(catalogEntry('gemini-3.7-flash')?.efforts).toEqual(['low', 'medium', 'high'])
    expect(catalogEntry('gemini-3.6-flash')?.efforts).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(catalogEntry('gemini-3-flash-preview')).toBeUndefined()
  })

  it('doubles the 3.6 to 3.8 Flash prices from 2027-01-01', () => {
    expect(priceAt('gemini-3.8-flash', Date.parse('2026-12-31T23:59:59Z'))).toMatchObject({ input: 0.75, cached: 0.075, output: 3.75 })
    expect(priceAt('gemini-3.8-flash', Date.parse('2027-01-01T00:00:00Z'))).toMatchObject({ input: 1.5, cached: 0.15, output: 7.5 })
    expect(priceAt('gemini-3.5-flash-lite', Date.parse('2027-06-01T00:00:00Z'))).toMatchObject({ input: 0.3, output: 2.5 })
    expect(priceAt('unknown-model', Date.now())).toBeUndefined()
  })
})

describe('normalizeUsage', () => {
  it('adds Gemini thinking that only total_tokens reports to output once', () => {
    expect(normalizeUsage({ promptTokens: 585, completionTokens: 32, totalTokens: 1198 })).toEqual({ ok: true, usage: { input: 585, cached: 0, output: 613, thinking: 581 } })
  })

  it('accepts reasoning_tokens that equal the residual without counting them twice', () => {
    expect(normalizeUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 25, reasoningTokens: 10 })).toEqual({ ok: true, usage: { input: 10, cached: 0, output: 15, thinking: 10 } })
  })

  it('treats reasoning_tokens inside completion_tokens as a label when the total has no residual', () => {
    expect(normalizeUsage({ promptTokens: 10, completionTokens: 50, totalTokens: 60, reasoningTokens: 40 })).toEqual({ ok: true, usage: { input: 10, cached: 0, output: 50, thinking: 40 } })
  })

  it('keeps cached input as part of input', () => {
    expect(normalizeUsage({ promptTokens: 1000, completionTokens: 10, totalTokens: 1010, cachedTokens: 600 })).toEqual({ ok: true, usage: { input: 1000, cached: 600, output: 10, thinking: 0 } })
  })

  it('reports missing and inconsistent usage instead of guessing', () => {
    expect(normalizeUsage(undefined)).toEqual({ ok: false, reason: 'missing' })
    expect(normalizeUsage({ completionTokens: 3 })).toEqual({ ok: false, reason: 'missing' })
    expect(normalizeUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 12 })).toEqual({ ok: false, reason: 'inconsistent' })
    expect(normalizeUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 25, reasoningTokens: 7 })).toEqual({ ok: false, reason: 'inconsistent' })
    expect(normalizeUsage({ promptTokens: 10, completionTokens: 5, cachedTokens: 11 })).toEqual({ ok: false, reason: 'inconsistent' })
  })
})

describe('costNano', () => {
  it('prices uncached input, cached input, and output with thinking', () => {
    const price = { input: 0.75, cached: 0.075, output: 3.75 }
    // 585 input and 613 output tokens of 3.8 Flash: the medium-thinking example of the V2 report.
    expect(costNano(price, { input: 585, cached: 0, output: 613 })).toBe(2_737_500)
    expect(costNano(price, { input: 1000, cached: 600, output: 0 })).toBe(345_000)
  })
})
