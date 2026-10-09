import process from 'node:process'

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

import * as v from 'valibot'

/** Standard text and image-input prices in USD per million tokens. Audio and paid server tools are excluded. */
export interface Price {
  input: number
  cached: number
  output: number
  threshold?: number
  above?: { input: number, cached: number, output: number }
}

/** Output includes reasoning. Thinking is a reported subset and is never added twice. */
export interface Usage {
  input: number
  cached: number
  output: number
  thinking: number
}

const token = v.pipe(v.number(), v.safeInteger(), v.minValue(0))
const rate = v.pipe(v.number(), v.finite(), v.minValue(0))
const rates = v.object({ input: rate, cached: rate, output: rate })
const priceSchema = v.object({ ...rates.entries, threshold: v.optional(token), above: v.optional(rates) })
const usageSchema = v.object({ input: token, cached: token, output: token, thinking: token })
const entrySchema = v.object({
  id: v.string(),
  model: v.string(),
  price: priceSchema,
  reservedNano: token,
  status: v.picklist(['reserved', 'settled', 'unknown']),
  costNano: v.optional(token),
  usage: v.optional(usageSchema),
})
const ledgerSchema = v.object({ version: v.literal(1), ceilingNano: token, halted: v.boolean(), entries: v.array(entrySchema), authorizations: v.optional(v.array(v.object({ previousCeilingNano: token, ceilingNano: token, reason: v.string(), at: v.string() }))) })
type LedgerState = v.InferOutput<typeof ledgerSchema>

/** Calculates nanodollars, rounding up once. Tier selection uses the entire prompt, including cached input. */
export function costNano(price: Price, usage: Usage): number {
  v.parse(priceSchema, price)
  v.parse(usageSchema, usage)
  if (usage.cached > usage.input || usage.thinking > usage.output)
    throw new Error('Inconsistent usage categories')
  const selected = price.threshold !== undefined && usage.input > price.threshold ? price.above : price
  if (!selected)
    throw new Error('Unknown price tier')
  // One dollar per million tokens equals 1,000 nanodollars per token.
  const amount = Math.ceil(((usage.input - usage.cached) * selected.input + usage.cached * selected.cached + usage.output * selected.output) * 1000)
  if (!Number.isSafeInteger(amount))
    throw new Error('Monetary accounting overflow')
  return amount
}

/**
 * Validates Gemini compatibility totals. Gemini can report thinking outside completion_tokens.
 * The normalized output always includes thinking. Unknown billable fields stop the campaign.
 *
 * @example
 * parseUsage({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 })
 * // => { input: 2, cached: 0, output: 3, thinking: 0 }
 */
export function parseUsage(value: unknown): Usage {
  const reported = v.parse(v.looseObject({
    prompt_tokens: token,
    completion_tokens: token,
    total_tokens: token,
    prompt_tokens_details: v.optional(v.nullable(v.record(v.string(), token))),
    completion_tokens_details: v.optional(v.nullable(v.record(v.string(), token))),
  }), value)
  const extraThinking = reported.total_tokens - reported.prompt_tokens - reported.completion_tokens
  if (extraThinking < 0)
    throw new Error('Inconsistent usage total')
  for (const [name, amount] of Object.entries(reported)) {
    if (!['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details'].includes(name) && amount !== 0)
      throw new Error(`Unknown usage category: ${name}`)
  }
  for (const [name, amount] of Object.entries(reported.prompt_tokens_details ?? Object.freeze({}))) {
    if (name !== 'cached_tokens' && amount !== 0)
      throw new Error(`Unpriced input category: ${name}`)
  }
  for (const [name, amount] of Object.entries(reported.completion_tokens_details ?? Object.freeze({}))) {
    if (name !== 'reasoning_tokens' && amount !== 0)
      throw new Error(`Unpriced output category: ${name}`)
  }
  const detailedThinking = reported.completion_tokens_details?.reasoning_tokens
  if (extraThinking > 0 && detailedThinking !== undefined && detailedThinking !== extraThinking)
    throw new Error('Inconsistent thinking total')
  // Gemini's compatibility endpoint reports thinking in total_tokens even when reasoning_tokens is omitted.
  // Source: https://discuss.ai.google.dev/t/gemini-3-6-flash-openai-compatible-token-limits-response-fields-and-auth-keys/183372/2
  const usage = {
    input: reported.prompt_tokens,
    cached: reported.prompt_tokens_details?.cached_tokens ?? 0,
    output: reported.completion_tokens + extraThinking,
    thinking: extraThinking || detailedThinking || 0,
  }
  if (usage.cached > usage.input || usage.thinking > usage.output)
    throw new Error('Inconsistent usage categories')
  return usage
}

/**
 * Owns a durable campaign ledger and an exclusive process lock.
 * Reservations survive interrupted requests. Reopening unresolved state halts further paid dispatch.
 * Closing releases ownership, without releasing reservations or clearing uncertainty.
 */
export class SpendLedger {
  private readonly state: LedgerState
  private closed = false

  /** @default ceilingNano 4,500,000,000. @default concurrency 2. */
  constructor(private readonly path: string, ceilingNano = 4_500_000_000, private readonly concurrency = 2) {
    if (!Number.isSafeInteger(ceilingNano) || ceilingNano <= 0 || ceilingNano > 5_000_000_000)
      throw new Error('Unsafe budget ceiling')
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 2)
      throw new Error('Unsafe concurrency limit')
    try {
      const lock = openSync(`${path}.lock`, 'wx')
      writeFileSync(lock, String(process.pid))
      fsyncSync(lock)
      closeSync(lock)
    }
    catch {
      throw new Error('Ledger lock prevents another owner')
    }
    try {
      this.state = existsSync(path)
        ? v.parse(ledgerSchema, JSON.parse(readFileSync(path, 'utf8')))
        : { version: 1, ceilingNano, halted: false, entries: [] }
      const ids = new Set<string>()
      for (const entry of this.state.entries) {
        if (ids.has(entry.id))
          throw new Error('Invalid ledger: duplicate request')
        ids.add(entry.id)
        if (entry.status === 'settled') {
          if (!entry.usage || entry.costNano === undefined || costNano(entry.price, entry.usage) !== entry.costNano)
            throw new Error('Invalid ledger: incomplete or inconsistent settlement')
          if (entry.costNano > entry.reservedNano)
            this.state.halted = true
        }
        else if (entry.usage !== undefined || entry.costNano !== undefined) {
          throw new Error('Invalid ledger: unresolved settlement data')
        }
      }
      this.state.ceilingNano = Math.min(ceilingNano, this.state.ceilingNano)
      if (this.state.entries.some(entry => entry.status !== 'settled'))
        this.state.halted = true
      if (this.snapshot().exposureNano >= this.state.ceilingNano)
        this.state.halted = true
      this.persist()
    }
    catch (error) {
      unlinkSync(`${path}.lock`)
      throw error
    }
  }

  reserve(id: string, model: string, price: Price, input: number, output: number): void {
    this.assertOpen()
    if (this.state.halted)
      throw new Error('Paid dispatch halted: unknown usage or unresolved reservation')
    if (this.state.entries.some(entry => entry.id === id))
      throw new Error('Duplicate request reservation')
    if (this.state.entries.filter(entry => entry.status === 'reserved').length >= this.concurrency)
      throw new Error('Concurrency limit reached')
    const reservedNano = costNano(price, { input, cached: 0, output, thinking: 0 })
    if (this.snapshot().exposureNano + reservedNano >= this.state.ceilingNano)
      throw new Error('Budget ceiling rejects this request')
    this.state.entries.push({ id, model, price: v.parse(priceSchema, price), reservedNano, status: 'reserved' })
    this.persist()
  }

  /** Records explicit user authorization. Existing charges, reservations, and halted state remain intact. Constructor restarts never increase ceilings. */
  authorizeCeiling(ceilingNano: number, reason: string): void {
    this.assertOpen()
    if (!Number.isSafeInteger(ceilingNano) || ceilingNano <= this.state.ceilingNano || ceilingNano > 5_000_000_000 || !reason.trim())
      throw new Error('Unsafe or unrecorded budget authorization')
    this.state.authorizations ??= []
    this.state.authorizations.push({ previousCeilingNano: this.state.ceilingNano, ceilingNano, reason, at: new Date().toISOString() })
    this.state.ceilingNano = ceilingNano
    this.persist()
  }

  settle(id: string, usage: Usage | undefined): void {
    this.assertOpen()
    const entry = this.state.entries.find(entry => entry.id === id)
    if (!entry || entry.status !== 'reserved')
      throw new Error('Unknown or completed reservation')
    if (!usage) {
      entry.status = 'unknown'
      this.state.halted = true
      this.persist()
      return
    }
    let amount: number
    try {
      amount = costNano(entry.price, usage)
    }
    catch (error) {
      entry.status = 'unknown'
      this.state.halted = true
      this.persist()
      throw error
    }
    entry.usage = v.parse(usageSchema, usage)
    entry.costNano = amount
    entry.status = 'settled'
    if (amount > entry.reservedNano) {
      this.state.halted = true
      this.persist()
      throw new Error('Reported usage exceeded the reservation')
    }
    this.persist()
  }

  snapshot(): { spentNano: number, exposureNano: number, halted: boolean } {
    const spentNano = this.state.entries.reduce((sum, entry) => sum + (entry.costNano ?? 0), 0)
    const exposureNano = this.state.entries.reduce((sum, entry) => sum + (entry.status === 'settled' ? entry.costNano ?? 0 : Math.max(entry.reservedNano, entry.costNano ?? 0)), 0)
    return { spentNano, exposureNano, halted: this.state.halted }
  }

  close(): void {
    if (this.closed)
      return
    this.closed = true
    unlinkSync(`${this.path}.lock`)
  }

  private assertOpen(): void {
    if (this.closed)
      throw new Error('Ledger owner is closed')
  }

  private persist(): void {
    try {
      const temporary = `${this.path}.pending`
      const file = openSync(temporary, 'w')
      try {
        writeFileSync(file, `${JSON.stringify(this.state, null, 2)}\n`)
        fsyncSync(file)
      }
      finally {
        closeSync(file)
      }
      renameSync(temporary, this.path)
    }
    catch (error) {
      this.state.halted = true
      throw error
    }
  }
}
