import type { CompanionDatabase } from '../store/database'
import type { ObservedLimits, UpstreamFailure } from './rate-limit'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** Usage older than this cannot count in any window, whatever the reset policy. */
const RETENTION_MS = 26 * HOUR_MS
const DEFAULT_MINUTE_COOLDOWN_MS = MINUTE_MS
const DEFAULT_UNKNOWN_COOLDOWN_MS = 30_000
/** A daily limit on a rolling window has no known reset time. Check again after this time. */
const ROLLING_DAY_COOLDOWN_MS = 15 * MINUTE_MS

/** The limits of one model that the ledger enforces. `ModelLimits` from the configuration fits it. */
export interface LedgerLimits {
  rpm?: number
  tpm?: number
  rpd?: number
  tpd?: number
  tpmBasis?: 'input' | 'total'
  dayReset?: 'rolling' | { timeZone: string }
}

/** What a logical turn is expected to spend in the quota windows. */
export interface QuotaNeed {
  /** Provider requests: two for a turn that is expected to call one tool. */
  requests: number
  inputTokens: number
  /** Input and output tokens. Used when the provider meters both. */
  totalTokens: number
}

export type QuotaReason
  = | 'COOLING_DOWN'
    | 'OBSERVED_REQUESTS_EXHAUSTED'
    | 'RPM_EXHAUSTED'
    | 'RPD_EXHAUSTED'
    | 'TPM_WINDOW_FULL'
    | 'TPD_EXHAUSTED'

export type QuotaVerdict
  = | { ok: true }
    | { ok: false, reason: QuotaReason, retryAtMs: number, detail?: string }

interface UsageWindow {
  requests: number
  inputTokens: number
  outputTokens: number
}

export interface LedgerSnapshot {
  /** What the provider publishes, from the configuration. */
  configured: LedgerLimits
  /** What the provider reported in its last response headers. */
  observed?: ObservedLimits
  cooldown?: { untilMs: number, reason: string }
  usage: { minute: UsageWindow, day: UsageWindow, dayResetAtMs?: number }
  storedEvents: number
}

interface UsageRow {
  at_ms: number
  input_tokens: number
  output_tokens: number
}

/**
 * Tracks what each model scope has spent and what the provider has said about its limits.
 *
 * A scope is one key on one model, because providers meter per model and key.
 * The ledger keeps three kinds of state apart:
 * - the limits that the configuration publishes, which it only reads,
 * - the usage that it counted itself, with provider-reported tokens in place of estimates,
 * - the state that the provider reported: rate-limit headers and cool-downs after a 429.
 *
 * A request is counted when it starts, at its estimated size, so that parallel requests see each other.
 * It is corrected when the response reports the real token counts.
 */
export class QuotaLedger {
  constructor(
    private readonly db: CompanionDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts counting a request. Returns the ticket that {@link finish} needs. */
  begin(scope: string, estimatedInputTokens: number): number {
    const now = this.now()
    this.db.prepare('DELETE FROM usage_event WHERE at_ms < ?').run(now - RETENTION_MS)
    const result = this.db.prepare('INSERT INTO usage_event (scope, at_ms, input_tokens) VALUES (?, ?, ?)').run(scope, now, Math.max(0, Math.round(estimatedInputTokens)))
    return Number(result.lastInsertRowid)
  }

  /**
   * Settles a request. `counted: false` removes it from every window, for a request that the provider refused or never processed.
   * Token counts that the provider reported replace the estimate.
   */
  finish(ticket: number, result: { counted: boolean, inputTokens?: number, outputTokens?: number }): void {
    this.db.prepare('UPDATE usage_event SET counted = ?, input_tokens = COALESCE(?, input_tokens), output_tokens = COALESCE(?, output_tokens) WHERE id = ?')
      .run(result.counted ? 1 : 0, result.inputTokens ?? null, result.outputTokens ?? null, ticket)
  }

  /**
   * Decides whether a scope can take a logical turn now. The verdict names the reason and the time of the next chance.
   * When several limits block, the one that frees up last decides, so that the retry time is honest.
   */
  check(scope: string, limits: LedgerLimits, need: QuotaNeed): QuotaVerdict {
    const now = this.now()
    const blocks: Extract<QuotaVerdict, { ok: false }>[] = []
    const tokensNeeded = limits.tpmBasis === 'total' ? need.totalTokens : need.inputTokens
    const countsOutput = limits.tpmBasis === 'total'

    const cooldown = this.cooldown(scope)
    if (cooldown)
      blocks.push({ ok: false, reason: 'COOLING_DOWN', retryAtMs: cooldown.untilMs, detail: cooldown.reason })

    const observed = this.observed(scope)
    if (observed?.remainingRequests !== undefined && observed.remainingRequests < need.requests && (observed.resetRequestsAtMs ?? 0) > now)
      blocks.push({ ok: false, reason: 'OBSERVED_REQUESTS_EXHAUSTED', retryAtMs: observed.resetRequestsAtMs! })
    if (observed?.remainingTokens !== undefined && observed.remainingTokens < tokensNeeded && (observed.resetTokensAtMs ?? 0) > now)
      blocks.push({ ok: false, reason: 'TPM_WINDOW_FULL', retryAtMs: observed.resetTokensAtMs!, detail: 'reported by the provider' })

    const minuteStart = now - MINUTE_MS
    const minute = this.usageSince(scope, minuteStart)
    if (limits.rpm !== undefined && minute.requests + need.requests > limits.rpm)
      blocks.push({ ok: false, reason: 'RPM_EXHAUSTED', retryAtMs: this.freeAt(scope, minuteStart, minute.requests + need.requests - limits.rpm, () => 1, MINUTE_MS) })
    const minuteTokens = minute.inputTokens + (countsOutput ? minute.outputTokens : 0)
    if (limits.tpm !== undefined && minuteTokens + tokensNeeded > limits.tpm)
      blocks.push({ ok: false, reason: 'TPM_WINDOW_FULL', retryAtMs: this.freeAt(scope, minuteStart, minuteTokens + tokensNeeded - limits.tpm, row => row.input_tokens + (countsOutput ? row.output_tokens : 0), MINUTE_MS) })

    const dayReset = limits.dayReset ?? 'rolling'
    const dayStart = dayWindowStart(now, dayReset)
    const day = this.usageSince(scope, dayStart)
    const dayTokens = day.inputTokens + (countsOutput ? day.outputTokens : 0)
    if (limits.rpd !== undefined && day.requests + need.requests > limits.rpd)
      blocks.push({ ok: false, reason: 'RPD_EXHAUSTED', retryAtMs: this.dayFreeAt(scope, now, dayReset, day.requests + need.requests - limits.rpd, () => 1) })
    if (limits.tpd !== undefined && dayTokens + tokensNeeded > limits.tpd)
      blocks.push({ ok: false, reason: 'TPD_EXHAUSTED', retryAtMs: this.dayFreeAt(scope, now, dayReset, dayTokens + tokensNeeded - limits.tpd, row => row.input_tokens + (countsOutput ? row.output_tokens : 0)) })

    if (blocks.length === 0)
      return { ok: true }
    return blocks.reduce((latest, block) => block.retryAtMs > latest.retryAtMs ? block : latest)
  }

  /** Puts a scope to rest after a provider rate-limit response. The retry time of the provider wins. */
  noteRateLimit(scope: string, limits: LedgerLimits, failure: Extract<UpstreamFailure, { kind: 'rate-limited' }>): void {
    const now = this.now()
    let untilMs: number
    if (failure.retryAfterMs !== undefined)
      untilMs = now + failure.retryAfterMs
    else if (failure.window === 'day')
      untilMs = limits.dayReset && limits.dayReset !== 'rolling' ? nextDayReset(now, limits.dayReset) : now + ROLLING_DAY_COOLDOWN_MS
    else if (failure.window === 'minute')
      untilMs = now + DEFAULT_MINUTE_COOLDOWN_MS
    else
      untilMs = now + DEFAULT_UNKNOWN_COOLDOWN_MS
    this.rest(scope, untilMs, `rate-limited:${failure.window}:${failure.unit}`)
  }

  /** Puts a scope to rest. A later call can only extend the rest. */
  rest(scope: string, untilMs: number, reason: string): void {
    this.db.prepare(`
      INSERT INTO cooldown (scope, until_ms, reason) VALUES (?, ?, ?)
      ON CONFLICT (scope) DO UPDATE SET
        reason = CASE WHEN excluded.until_ms > cooldown.until_ms THEN excluded.reason ELSE cooldown.reason END,
        until_ms = MAX(cooldown.until_ms, excluded.until_ms)
    `).run(scope, Math.round(untilMs), reason)
  }

  /** The current rest of a scope, or `undefined` when it has none. */
  cooldown(scope: string): { untilMs: number, reason: string } | undefined {
    const row = this.db.prepare('SELECT until_ms, reason FROM cooldown WHERE scope = ?').get(scope) as { until_ms: number, reason: string } | undefined
    if (!row)
      return undefined
    if (row.until_ms <= this.now()) {
      this.db.prepare('DELETE FROM cooldown WHERE scope = ? AND until_ms <= ?').run(scope, this.now())
      return undefined
    }
    return { untilMs: row.until_ms, reason: row.reason }
  }

  /** Stores the rate-limit headers of a response. They stand next to the configured limits and never replace them. */
  noteObserved(scope: string, observed: ObservedLimits): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO observed_limit
        (scope, limit_requests, remaining_requests, reset_requests_at_ms, limit_tokens, remaining_tokens, reset_tokens_at_ms, observed_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scope,
      observed.limitRequests ?? null,
      observed.remainingRequests ?? null,
      observed.resetRequestsAtMs ?? null,
      observed.limitTokens ?? null,
      observed.remainingTokens ?? null,
      observed.resetTokensAtMs ?? null,
      observed.observedAtMs,
    )
  }

  observed(scope: string): ObservedLimits | undefined {
    const row = this.db.prepare('SELECT * FROM observed_limit WHERE scope = ?').get(scope) as Record<string, number | null> | undefined
    if (!row)
      return undefined
    const value = (key: string) => row[key] ?? undefined
    return {
      limitRequests: value('limit_requests'),
      remainingRequests: value('remaining_requests'),
      resetRequestsAtMs: value('reset_requests_at_ms'),
      limitTokens: value('limit_tokens'),
      remainingTokens: value('remaining_tokens'),
      resetTokensAtMs: value('reset_tokens_at_ms'),
      observedAtMs: row.observed_at_ms as number,
    }
  }

  /** What a scope has spent in the current minute and day. */
  usage(scope: string, limits: LedgerLimits): { minute: UsageWindow, day: UsageWindow } {
    const now = this.now()
    return {
      minute: this.usageSince(scope, now - MINUTE_MS),
      day: this.usageSince(scope, dayWindowStart(now, limits.dayReset ?? 'rolling')),
    }
  }

  /** Everything the ledger knows about a scope, for diagnostics. */
  snapshot(scope: string, limits: LedgerLimits): LedgerSnapshot {
    const dayReset = limits.dayReset ?? 'rolling'
    const stored = this.db.prepare('SELECT COUNT(*) AS n FROM usage_event WHERE scope = ?').get(scope) as { n: number }
    return {
      configured: limits,
      observed: this.observed(scope),
      cooldown: this.cooldown(scope),
      usage: { ...this.usage(scope, limits), dayResetAtMs: dayReset === 'rolling' ? undefined : nextDayReset(this.now(), dayReset) },
      storedEvents: stored.n,
    }
  }

  private usageSince(scope: string, sinceMs: number): UsageWindow {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM usage_event WHERE scope = ? AND counted = 1 AND at_ms > ?
    `).get(scope, sinceMs) as { requests: number, input_tokens: number, output_tokens: number }
    return { requests: row.requests, inputTokens: row.input_tokens, outputTokens: row.output_tokens }
  }

  /**
   * The time at which enough usage has left a sliding window to free `excess` units.
   * It walks the window from its oldest request, and stops when the freed weight covers the excess.
   */
  private freeAt(scope: string, sinceMs: number, excess: number, weight: (row: UsageRow) => number, windowMs: number): number {
    const rows: UsageRow[] = this.db
      .prepare('SELECT at_ms, input_tokens, output_tokens FROM usage_event WHERE scope = ? AND counted = 1 AND at_ms > ? ORDER BY at_ms ASC')
      .all(scope, sinceMs)
      .map(row => ({ at_ms: Number(row.at_ms), input_tokens: Number(row.input_tokens), output_tokens: Number(row.output_tokens) }))
    let freed = 0
    for (const row of rows) {
      freed += weight(row)
      if (freed >= excess)
        return row.at_ms + windowMs
    }
    // The need alone exceeds the limit. The window never frees enough, so report the end of the newest request.
    return (rows.at(-1)?.at_ms ?? this.now()) + windowMs
  }

  private dayFreeAt(scope: string, now: number, dayReset: NonNullable<LedgerLimits['dayReset']>, excess: number, weight: (row: UsageRow) => number): number {
    if (dayReset !== 'rolling')
      return nextDayReset(now, dayReset)
    return this.freeAt(scope, now - DAY_MS, excess, weight, DAY_MS)
  }
}

/** Start of the current counting day: 24 hours ago for a rolling day, or local midnight of the time zone. */
function dayWindowStart(nowMs: number, dayReset: NonNullable<LedgerLimits['dayReset']>): number {
  return dayReset === 'rolling' ? nowMs - DAY_MS : startOfZonedDay(nowMs, dayReset.timeZone)
}

function nextDayReset(nowMs: number, dayReset: { timeZone: string }): number {
  // 36 hours after local midnight is always inside the next local day, even on a 23 or 25 hour day.
  return startOfZonedDay(startOfZonedDay(nowMs, dayReset.timeZone) + 36 * HOUR_MS, dayReset.timeZone)
}

/**
 * Local midnight of the day that contains `nowMs` in `timeZone`.
 *
 * @example
 * startOfZonedDay(Date.parse('2026-10-07T23:00:00-07:00'), 'America/Los_Angeles')
 * // => Date.parse('2026-10-07T00:00:00-07:00')
 */
function startOfZonedDay(nowMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(nowMs))
  const part = (type: string) => Number(parts.find(candidate => candidate.type === type)?.value)
  const localAsUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'))
  // The difference between the local wall clock, read as UTC, and the true instant is the zone offset at this moment.
  const offsetMs = localAsUtc - Math.floor(nowMs / 1000) * 1000
  return Date.UTC(part('year'), part('month') - 1, part('day')) - offsetMs
}
