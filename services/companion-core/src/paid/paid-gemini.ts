import type { WireRequest } from '../budget/wire'
import type { CompanionConfig, ProviderConfig, ResolvedModel } from '../config/config'
import type { GeminiCatalogEntry, ThinkingEffort } from './gemini-catalog'
import type { OpsStateStore, PaidRequestRecord, PaidTotals } from './ops-state'
import type { ReportedUsage } from './usage'

import { errorMessageFrom } from '@moeru/std'

import * as v from 'valibot'

import { servesChatCompletions } from '../config/config'
import { CATALOG_CAPABILITIES, CATALOG_VERIFIED_AT, catalogEntry, GEMINI_CATALOG, isThinkingEffort, priceAt, RECOMMENDED_SELECTIONS, THINKING_EFFORTS } from './gemini-catalog'
import { costNano, normalizeUsage } from './usage'

const SELECTION_KEY = 'model-selection'
const SPENDING_KEY = 'spending-controls'
const DISCOVERY_KEY = 'model-discovery'
/** The Ops ledger answers many questions per minute. Pruning runs at most this often. */
const PRUNE_EVERY_MS = 6 * 60 * 60_000
const DISCOVERY_TIMEOUT_MS = 10_000
const NANO_PER_USD = 1_000_000_000

/** Why a model cannot take a request, before eligibility. Names match the router's skip reasons. */
export type PaidSkipReason = 'THINKING_UNSUPPORTED' | 'THINKING_CONFLICT' | 'SPENDING_LIMIT'

/** The effort that the Gateway sends to one candidate, and who chose it. */
export interface CandidateThinking {
  effort: ThinkingEffort
  source: 'selection' | 'client'
}

export interface ModelSelection {
  model: string
  effort: ThinkingEffort
  /** `default` until the user selects through Ops. */
  source: 'user' | 'default'
  selectedAt?: string
}

const usd = v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100_000)))
const spendingSchema = v.object({ dailyWarningUsd: usd, monthlyWarningUsd: usd, dailyLimitUsd: usd, monthlyLimitUsd: usd })
export const spendingPatchSchema = v.strictObject({
  dailyWarningUsd: v.optional(usd),
  monthlyWarningUsd: v.optional(usd),
  dailyLimitUsd: v.optional(usd),
  monthlyLimitUsd: v.optional(usd),
})
export type SpendingControls = v.InferOutput<typeof spendingSchema>
const NO_SPENDING_CONTROLS: SpendingControls = Object.freeze({ dailyWarningUsd: null, monthlyWarningUsd: null, dailyLimitUsd: null, monthlyLimitUsd: null })

const storedSelectionSchema = v.object({ model: v.string(), effort: v.picklist(THINKING_EFFORTS), selectedAt: v.string() })
const discoverySchema = v.object({ checkedAt: v.string(), ok: v.boolean(), error: v.optional(v.string()), found: v.array(v.string()), missing: v.array(v.string()) })
export type ModelDiscovery = v.InferOutput<typeof discoverySchema>

type Target
  = | { ok: true, alias: string, providerName: string, provider: ProviderConfig }
    | { ok: false, reason: string }

export type SelectResult
  = | { ok: true, selection: ModelSelection }
    | { ok: false, status: 400 | 409, code: string, message: string, supported?: readonly string[] }

/** One request to a Gemini provider. `finish` writes exactly one ledger row. */
export interface PaidRecorder {
  finish: (result: {
    /** `none`: no response arrived. `error`: an HTTP error arrived. `stream`: the answer arrived, whole or not. */
    response: 'none' | 'error' | 'stream'
    usage?: ReportedUsage
    error?: string
    firstByteMs?: number
  }) => void
}

export interface PaidGeminiOptions {
  config: CompanionConfig
  store: OpsStateStore
  /** Whether the Gateway holds the key of a `keyRef`. */
  hasKey: (keyRef: string) => boolean
  now: () => number
  /** Receives one line per ledger write failure. Lines hold reasons, never text or keys. */
  report?: (message: string) => void
}

/**
 * Paid Gemini policy of the Gateway: the Ops model selection, thinking efforts, spending controls, and the usage ledger.
 *
 * - Selection: an exact catalog model and effort lead one chat alias. The rest of the configured chain stays the
 *   authorized fallback. Only an authenticated Ops request changes it, and it survives restarts.
 * - Effort: the selected candidate gets the selected `reasoning_effort`. A client effort that a catalog model does not
 *   support skips that model. The Gateway never converts a level.
 * - Usage: each request to a Gemini provider becomes one row with tokens, thinking, estimated cost, and timings.
 *   Estimates use reported tokens and published prices. They are not invoices and include no credits.
 *
 * Call stack:
 *
 * Router.plan (../routing/router) -> GatewayRuntime admission -> {@link PaidGemini.admit}
 * attemptCandidate (../gateway/chat-completions) -> {@link PaidGemini.outgoing} / {@link PaidGemini.begin}
 */
export class PaidGemini {
  readonly target: Target
  private lastPruneAt = 0

  constructor(private readonly options: PaidGeminiOptions) {
    this.target = resolveTarget(options.config)
    this.prune()
  }

  /** The stored user selection, or the recommended default. */
  selection(): ModelSelection {
    const stored = v.safeParse(storedSelectionSchema, this.options.store.setting(SELECTION_KEY))
    if (stored.success && catalogEntry(stored.output.model)?.efforts.includes(stored.output.effort))
      return { model: stored.output.model, effort: stored.output.effort, source: 'user', selectedAt: stored.output.selectedAt }
    const fallback = RECOMMENDED_SELECTIONS[0]
    return { model: fallback.model, effort: fallback.effort, source: 'default' }
  }

  /** Why the selection does not lead requests right now, or `undefined` when it does. */
  inactiveReason(): string | undefined {
    if (!this.target.ok)
      return this.target.reason
    if (this.options.config.profile === 'local')
      return 'The local profile allows no cloud model.'
    if (this.target.provider.keyRef && !this.options.hasKey(this.target.provider.keyRef))
      return `No API key is stored for provider "${this.target.providerName}".`
    return undefined
  }

  /** The synthesized chain head of the selected model for `alias`, or `undefined`. */
  leader(alias: string): ResolvedModel | undefined {
    if (!this.target.ok || alias !== this.target.alias || this.inactiveReason())
      return undefined
    const { model } = this.selection()
    const { providerName, provider } = this.target
    // A configured entry of the same model gives its style reminder. Its limits stay with it, so historical free-tier
    // fixture caps never limit the paid selection.
    const configured = Object.values(this.options.config.models).find(entry => entry.provider === providerName && entry.model === model)
    return {
      id: `selected:${model}`,
      providerName,
      provider,
      locality: provider.locality,
      model,
      capabilities: CATALOG_CAPABILITIES,
      limits: { tpmBasis: 'input', dayReset: 'rolling' },
      quality: 'ops-selection',
      styleReminder: configured?.styleReminder,
      scope: `${provider.keyRef ?? providerName}|${model}`,
    }
  }

  /** The selected model first, then the configured chain without other entries of the same provider model. */
  chain(alias: string, chain: ResolvedModel[]): ResolvedModel[] {
    const leader = this.leader(alias)
    if (!leader)
      return chain
    return [leader, ...chain.filter(model => model.providerName !== leader.providerName || model.model !== leader.model)]
  }

  /** Checks that run before eligibility: thinking support and spending limits. */
  admit(model: ResolvedModel, body: WireRequest, isLeader: boolean): { skip: { reason: PaidSkipReason, detail?: string } } | { thinking?: CandidateThinking } {
    if (model.provider.compat !== 'gemini')
      return {}
    const entry = catalogEntry(model.model)
    const limit = entry && this.limitReached()
    if (limit)
      return { skip: { reason: 'SPENDING_LIMIT', detail: `the ${limit} spending limit is reached` } }
    if (isLeader) {
      if (hasNumericThinking(body))
        return { skip: { reason: 'THINKING_CONFLICT', detail: 'the request sets a numeric thinking budget next to the selected effort' } }
      return { thinking: { effort: this.selection().effort, source: 'selection' } }
    }
    const requested = body.reasoning_effort
    if (requested === undefined || !entry)
      return {}
    if (!isThinkingEffort(requested) || !entry.efforts.includes(requested))
      return { skip: { reason: 'THINKING_UNSUPPORTED', detail: `${model.model} supports ${entry.efforts.join(', ')}` } }
    return { thinking: { effort: requested, source: 'client' } }
  }

  /**
   * The body that a Gemini provider receives: the selected `reasoning_effort`, and `stream_options.include_usage` so that
   * the ledger gets final usage. AIRI's client ignores usage-only chunks. Other providers get the body unchanged.
   */
  outgoing(model: ResolvedModel, body: WireRequest, thinking: CandidateThinking | undefined): WireRequest {
    if (model.provider.compat !== 'gemini')
      return body
    let next = body
    if (thinking?.source === 'selection')
      next = { ...next, reasoning_effort: thinking.effort }
    const options = body.stream_options as { include_usage?: unknown } | undefined
    if (body.stream === true && options?.include_usage !== true)
      next = { ...next, stream_options: { ...options, include_usage: true } }
    return next
  }

  /** Starts the ledger row of one request to a Gemini provider. Other providers return `undefined`. */
  begin(model: ResolvedModel, alias: string, thinking: CandidateThinking | undefined, estimate: { inputTokens: number, outputTokens: number }): PaidRecorder | undefined {
    if (model.provider.compat !== 'gemini')
      return undefined
    const startedAt = this.options.now()
    const entry = catalogEntry(model.model)
    const price = priceAt(model.model, startedAt)
    const effort = thinking?.effort ?? entry?.providerDefault
    const effortSource = thinking?.source ?? (entry ? 'provider-default' : undefined)
    let finished = false
    return {
      finish: (result) => {
        if (finished)
          return
        finished = true
        const atMs = this.options.now()
        const { day, month } = windowKeys(atMs, this.options.config.paidGemini.timeZone)
        const record: PaidRequestRecord = { atMs, day, month, alias, modelId: model.id, providerModel: model.model, effort, effortSource, status: 'failed', priced: price !== undefined, durationMs: Math.max(0, atMs - startedAt), firstByteMs: result.firstByteMs, error: result.error }
        if (result.response === 'error') {
          // Google does not bill a request that ends in an HTTP error. No tokens and no cost are recorded.
          record.status = 'failed'
          record.costNano = price ? 0 : undefined
        }
        else {
          const normalized = result.response === 'stream' ? normalizeUsage(result.usage) : { ok: false as const, reason: 'missing' as const }
          if (normalized.ok) {
            record.status = 'settled'
            record.inputTokens = normalized.usage.input
            record.cachedTokens = normalized.usage.cached
            record.outputTokens = normalized.usage.output
            record.thinkingTokens = normalized.usage.thinking
            record.costNano = price ? costNano(price, normalized.usage) : undefined
          }
          else {
            record.status = 'unknown'
            record.error = result.error ?? `usage-${normalized.reason}`
            record.estimateNano = price ? costNano(price, { input: estimate.inputTokens, cached: 0, output: estimate.outputTokens }) : undefined
          }
        }
        try {
          this.options.store.insertPaidRequest(record)
          this.prune()
        }
        catch (error) {
          this.options.report?.(`paid usage record failed: ${errorMessageFrom(error) ?? 'unknown'}`)
        }
      },
    }
  }

  /** Validates and stores an Ops selection. It never converts an unsupported effort. */
  select(model: unknown, effort: unknown): SelectResult {
    const entry = typeof model === 'string' ? catalogEntry(model) : undefined
    if (!entry)
      return { ok: false, status: 400, code: 'unknown_model', message: 'The model is not a selectable Gemini model.', supported: GEMINI_CATALOG.map(item => item.id) }
    if (!isThinkingEffort(effort) || !entry.efforts.includes(effort))
      return { ok: false, status: 400, code: 'unsupported_effort', message: `${entry.id} does not support thinking effort "${String(effort)}".`, supported: entry.efforts }
    const inactive = this.inactiveReason()
    if (inactive)
      return { ok: false, status: 409, code: 'selection_unavailable', message: inactive }
    const discovery = this.discovery()
    if (discovery?.ok && discovery.missing.includes(entry.id))
      return { ok: false, status: 409, code: 'model_not_available', message: `Model discovery did not list ${entry.id} for this key.` }
    const selectedAt = new Date(this.options.now()).toISOString()
    this.options.store.setSetting(SELECTION_KEY, { model: entry.id, effort, selectedAt }, this.options.now())
    return { ok: true, selection: { model: entry.id, effort, source: 'user', selectedAt } }
  }

  spending(): SpendingControls {
    const stored = v.safeParse(spendingSchema, this.options.store.setting(SPENDING_KEY))
    return stored.success ? stored.output : { ...NO_SPENDING_CONTROLS }
  }

  setSpending(patch: v.InferOutput<typeof spendingPatchSchema>): SpendingControls {
    const next = { ...this.spending(), ...patch }
    this.options.store.setSetting(SPENDING_KEY, next, this.options.now())
    return next
  }

  discovery(): ModelDiscovery | undefined {
    const stored = v.safeParse(discoverySchema, this.options.store.setting(DISCOVERY_KEY))
    return stored.success ? stored.output : undefined
  }

  /**
   * Lists the provider's models with the key, which costs no inference, and stores which catalog ids it can see.
   * The key stays in this process. The result holds model ids and an error category only.
   */
  async discover(key: string | undefined, transport: typeof fetch = fetch): Promise<ModelDiscovery> {
    const checkedAt = new Date(this.options.now()).toISOString()
    const fail = (error: string): ModelDiscovery => this.storeDiscovery({ checkedAt, ok: false, error, found: [], missing: [] })
    if (!this.target.ok)
      return fail('not-configured')
    if (!key)
      return fail('key-missing')
    let response: Response
    try {
      response = await transport(new URL('models', this.target.provider.baseURL), { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) })
    }
    catch (error) {
      return fail((error as Error).name === 'TimeoutError' ? 'timeout' : 'network')
    }
    if (response.status === 401 || response.status === 403)
      return fail('auth')
    if (!response.ok)
      return fail(response.status === 429 ? 'rate-limited' : 'unavailable')
    let ids: string[]
    try {
      const parsed = await response.json() as { data?: Array<{ id?: unknown }> }
      ids = (parsed.data ?? []).map(item => typeof item.id === 'string' ? item.id.replace(/^models\//, '') : '').filter(Boolean)
    }
    catch {
      return fail('malformed')
    }
    const found = GEMINI_CATALOG.filter(entry => ids.includes(entry.id)).map(entry => entry.id)
    return this.storeDiscovery({ checkedAt, ok: true, found, missing: GEMINI_CATALOG.map(entry => entry.id).filter(id => !found.includes(id)) })
  }

  /** The Ops models view: target, selection, catalog with prices and discovery, and recommendations. No keys. */
  modelsView(): Record<string, unknown> {
    const now = this.options.now()
    const discovery = this.discovery()
    const selection = this.selection()
    const inactive = this.inactiveReason()
    const target = this.target
    const aliasChain = target.ok ? this.options.config.aliases[target.alias]?.chain ?? [] : []
    return {
      available: inactive === undefined,
      reason: inactive ?? null,
      alias: target.ok ? target.alias : null,
      provider: target.ok ? target.providerName : null,
      keyPresent: target.ok ? !target.provider.keyRef || this.options.hasKey(target.provider.keyRef) : false,
      profile: this.options.config.profile,
      selection: { ...selection, selectedAt: selection.selectedAt ?? null, active: inactive === undefined },
      fallback: target.ok ? aliasChain.filter(id => this.options.config.models[id]?.model !== selection.model || this.options.config.models[id]?.provider !== target.providerName) : [],
      catalog: GEMINI_CATALOG.map(entry => catalogView(entry, now, discovery)),
      recommendations: RECOMMENDED_SELECTIONS,
      discovery: discovery ?? null,
      verifiedAt: CATALOG_VERIFIED_AT,
    }
  }

  /** The Ops usage view. Counts, tokens, estimated USD, timings, and error categories. No text. */
  usageView(): Record<string, unknown> {
    const now = this.options.now()
    const { day, month } = windowKeys(now, this.options.config.paidGemini.timeZone)
    const { store } = this.options
    const today = store.totals({ day })
    const thisMonth = store.totals({ month })
    const controls = this.spending()
    const recent = store.recent(200)
    const firstBytes = recent.filter(record => record.status === 'settled' && record.firstByteMs !== undefined).map(record => record.firstByteMs!).slice(0, 100)
    const durations = recent.filter(record => record.status === 'settled').map(record => record.durationMs).slice(0, 100)
    const exposure = (totals: PaidTotals) => (totals.costNano + totals.estimateNano) / NANO_PER_USD
    const reached = (limit: number | null, totals: PaidTotals) => limit !== null && exposure(totals) >= limit
    return {
      currency: 'USD',
      basis: 'Estimated metered API cost from reported tokens and Google\'s published standard prices. It is not an invoice. Credits, promotions, and taxes are not applied.',
      timeZone: this.options.config.paidGemini.timeZone,
      pricesVerifiedAt: CATALOG_VERIFIED_AT,
      day,
      month,
      today: totalsView(today),
      thisMonth: totalsView(thisMonth),
      byModel: store.breakdown(month).map(row => ({ ...totalsView(row), model: row.model, effort: row.effort })),
      latency: { samples: firstBytes.length, firstByteP50Ms: quantile(firstBytes, 0.5), firstByteP95Ms: firstBytes.length >= 20 ? quantile(firstBytes, 0.95) : null, durationP50Ms: quantile(durations, 0.5) },
      errors: store.errors(month),
      recent: recent.slice(0, 20).map(record => recordView(record)),
      controls,
      alerts: {
        dailyWarning: reached(controls.dailyWarningUsd, today),
        monthlyWarning: reached(controls.monthlyWarningUsd, thisMonth),
        dailyLimit: reached(controls.dailyLimitUsd, today),
        monthlyLimit: reached(controls.monthlyLimitUsd, thisMonth),
      },
    }
  }

  /** `daily` or `monthly` when a user limit is reached. Unknown usage counts at its conservative estimate. */
  private limitReached(): 'daily' | 'monthly' | undefined {
    const controls = this.spending()
    if (controls.dailyLimitUsd === null && controls.monthlyLimitUsd === null)
      return undefined
    const { day, month } = windowKeys(this.options.now(), this.options.config.paidGemini.timeZone)
    const spent = (totals: PaidTotals) => (totals.costNano + totals.estimateNano) / NANO_PER_USD
    if (controls.dailyLimitUsd !== null && spent(this.options.store.totals({ day })) >= controls.dailyLimitUsd)
      return 'daily'
    if (controls.monthlyLimitUsd !== null && spent(this.options.store.totals({ month })) >= controls.monthlyLimitUsd)
      return 'monthly'
    return undefined
  }

  private storeDiscovery(result: ModelDiscovery): ModelDiscovery {
    this.options.store.setSetting(DISCOVERY_KEY, result, this.options.now())
    return result
  }

  private prune(): void {
    const now = this.options.now()
    if (now - this.lastPruneAt < PRUNE_EVERY_MS)
      return
    this.lastPruneAt = now
    this.options.store.prune(now - this.options.config.paidGemini.retentionDays * 86_400_000)
  }
}

/** The alias and provider of the selection. Configuration names them, or exactly one candidate exists. */
function resolveTarget(config: CompanionConfig): Target {
  const providers = Object.entries(config.providers).filter(([, provider]) => provider.compat === 'gemini' && provider.locality === 'cloud')
  const providerName = config.paidGemini.provider ?? (providers.length === 1 ? providers[0][0] : undefined)
  if (!providerName)
    return { ok: false, reason: providers.length === 0 ? 'No cloud provider with compat "gemini" is configured.' : 'Several Gemini providers exist. Set paidGemini.provider.' }
  const alias = config.paidGemini.alias ?? 'companion-chat'
  if (!config.aliases[alias] || !servesChatCompletions(config.aliases[alias]))
    return { ok: false, reason: `Alias "${alias}" does not serve chat completions. Set paidGemini.alias.` }
  return { ok: true, alias, providerName, provider: config.providers[providerName] }
}

/** A numeric thinking budget conflicts with a thinking level. Google rejects both together. */
function hasNumericThinking(body: WireRequest): boolean {
  const extra = body.extra_body as { google?: { thinking_config?: unknown } } | undefined
  return body.thinking_config !== undefined || extra?.google?.thinking_config !== undefined
}

/**
 * Day and month keys in a time zone.
 *
 * @example
 * windowKeys(Date.parse('2026-10-09T05:00:00Z'), 'America/Los_Angeles')
 * // => { day: '2026-10-08', month: '2026-10' }
 */
export function windowKeys(atMs: number, timeZone: string): { day: string, month: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(atMs)
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? '00'
  const month = `${part('year')}-${part('month')}`
  return { day: `${month}-${part('day')}`, month }
}

function catalogView(entry: GeminiCatalogEntry, now: number, discovery: ModelDiscovery | undefined) {
  const price = priceAt(entry.id, now)
  const next = entry.prices.find(item => Date.parse(item.from) > now)
  return {
    id: entry.id,
    label: entry.label,
    efforts: entry.efforts,
    providerDefault: entry.providerDefault,
    price: price ?? null,
    nextPrice: next ?? null,
    discovered: discovery?.ok ? discovery.found.includes(entry.id) : null,
  }
}

function totalsView(totals: PaidTotals) {
  return {
    requests: totals.requests,
    settled: totals.settled,
    unknown: totals.unknown,
    failed: totals.failed,
    unpriced: totals.unpriced,
    inputTokens: totals.inputTokens,
    cachedTokens: totals.cachedTokens,
    outputTokens: totals.outputTokens,
    thinkingTokens: totals.thinkingTokens,
    costUsd: totals.costNano / NANO_PER_USD,
    unknownEstimateUsd: totals.estimateNano / NANO_PER_USD,
  }
}

function recordView(record: PaidRequestRecord) {
  return {
    at: new Date(record.atMs).toISOString(),
    model: record.providerModel,
    effort: record.effort ?? null,
    effortSource: record.effortSource ?? null,
    status: record.status,
    inputTokens: record.inputTokens ?? null,
    cachedTokens: record.cachedTokens ?? null,
    outputTokens: record.outputTokens ?? null,
    thinkingTokens: record.thinkingTokens ?? null,
    costUsd: record.costNano === undefined ? null : record.costNano / NANO_PER_USD,
    estimateUsd: record.estimateNano === undefined ? null : record.estimateNano / NANO_PER_USD,
    firstByteMs: record.firstByteMs ?? null,
    durationMs: record.durationMs,
    error: record.error ?? null,
  }
}

function quantile(values: number[], q: number): number | null {
  if (values.length === 0)
    return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]
}
