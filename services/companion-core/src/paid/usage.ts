import type { TokenPrice } from './gemini-catalog'

/** What a chat-completions response reported in `usage`. Every field is optional because providers differ. */
export interface ReportedUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
  reasoningTokens?: number
}

/** Billable token categories of one request. `output` includes `thinking`. `cached` is part of `input`. */
export interface BilledUsage {
  input: number
  cached: number
  output: number
  thinking: number
}

export type UsageNormalization
  = | { ok: true, usage: BilledUsage }
    | { ok: false, reason: 'missing' | 'inconsistent' }

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * Turns reported usage into billable categories without counting thinking twice.
 *
 * Gemini's OpenAI-compatible endpoint can report thinking only in `total_tokens`, outside `completion_tokens`. Other
 * providers count `reasoning_tokens` inside `completion_tokens`. So the residual `total - prompt - completion` is added
 * to output, and `reasoning_tokens` is only a label when the residual is zero.
 * Ported from the paid benchmark's `parseUsage` (codex/gemini-thinking-benchmark-v2, eval/gemini/accounting.ts).
 * Source: https://discuss.ai.google.dev/t/gemini-3-6-flash-openai-compatible-token-limits-response-fields-and-auth-keys/183372/2
 *
 * @example
 * normalizeUsage({ promptTokens: 585, completionTokens: 32, totalTokens: 1198 })
 * // => { ok: true, usage: { input: 585, cached: 0, output: 613, thinking: 581 } }
 */
export function normalizeUsage(reported: ReportedUsage | undefined): UsageNormalization {
  if (!reported || !isCount(reported.promptTokens) || !isCount(reported.completionTokens))
    return { ok: false, reason: 'missing' }
  const { promptTokens, completionTokens } = reported
  if ([reported.totalTokens, reported.cachedTokens, reported.reasoningTokens].some(value => value !== undefined && !isCount(value)))
    return { ok: false, reason: 'inconsistent' }
  const residual = reported.totalTokens === undefined ? 0 : reported.totalTokens - promptTokens - completionTokens
  if (residual < 0)
    return { ok: false, reason: 'inconsistent' }
  const detailed = reported.reasoningTokens
  if (residual > 0 && detailed !== undefined && detailed !== 0 && detailed !== residual)
    return { ok: false, reason: 'inconsistent' }
  const usage: BilledUsage = {
    input: promptTokens,
    cached: reported.cachedTokens ?? 0,
    output: completionTokens + residual,
    thinking: residual > 0 ? residual : detailed ?? 0,
  }
  if (usage.cached > usage.input || usage.thinking > usage.output)
    return { ok: false, reason: 'inconsistent' }
  return { ok: true, usage }
}

/**
 * Estimated cost in nanodollars (1e-9 USD), rounded up once.
 * One dollar per million tokens equals 1,000 nanodollars per token.
 *
 * @example
 * costNano({ input: 0.75, cached: 0.075, output: 3.75 }, { input: 1000, cached: 0, output: 100, thinking: 0 })
 * // => 1125000
 */
export function costNano(price: TokenPrice, usage: Pick<BilledUsage, 'input' | 'cached' | 'output'>): number {
  return Math.ceil(((usage.input - usage.cached) * price.input + usage.cached * price.cached + usage.output * price.output) * 1000)
}
