import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { QuotaLedger } from '../src/quota/ledger'
import { openDatabase } from '../src/store/database'

const SCOPE = 'provider-groq|qwen/qwen3.8-27b'
const T0 = Date.parse('2026-10-07T12:00:00Z')
const MINUTE = 60_000
const HOUR = 3_600_000

function createLedger(start = T0) {
  const clock = { now: start }
  const ledger = new QuotaLedger(openDatabase(':memory:'), () => clock.now)
  return { ledger, clock }
}

const ONE_REQUEST = { requests: 1, inputTokens: 1000, totalTokens: 1500 }

describe('quotaLedger minute windows', () => {
  it('blocks the request that would exceed the per-minute request limit, until the oldest one leaves the window', () => {
    const { ledger, clock } = createLedger()
    const limits = { rpm: 3, tpmBasis: 'input', dayReset: 'rolling' } as const
    for (let i = 0; i < 3; i++) {
      ledger.finish(ledger.begin(SCOPE, 100), { counted: true })
      clock.now += 5000
    }

    expect(ledger.check(SCOPE, limits, ONE_REQUEST)).toMatchObject({ ok: false, reason: 'RPM_EXHAUSTED', retryAtMs: T0 + MINUTE })

    clock.now = T0 + MINUTE + 1
    expect(ledger.check(SCOPE, limits, ONE_REQUEST)).toEqual({ ok: true })
  })

  it('counts the whole logical turn, so that two rounds need two free request slots', () => {
    const { ledger } = createLedger()
    const limits = { rpm: 3, tpmBasis: 'input', dayReset: 'rolling' } as const
    ledger.finish(ledger.begin(SCOPE, 100), { counted: true })
    ledger.finish(ledger.begin(SCOPE, 100), { counted: true })

    expect(ledger.check(SCOPE, limits, { ...ONE_REQUEST, requests: 2 })).toMatchObject({ ok: false, reason: 'RPM_EXHAUSTED' })
    expect(ledger.check(SCOPE, limits, ONE_REQUEST)).toEqual({ ok: true })
  })

  it('blocks on input tokens per minute and names the time when enough tokens have left the window', () => {
    const { ledger, clock } = createLedger()
    const limits = { tpm: 7000, tpmBasis: 'input', dayReset: 'rolling' } as const
    ledger.finish(ledger.begin(SCOPE, 4400), { counted: true })
    clock.now += 20_000

    expect(ledger.check(SCOPE, limits, { requests: 1, inputTokens: 4400, totalTokens: 4900 })).toMatchObject({ ok: false, reason: 'TPM_WINDOW_FULL', retryAtMs: T0 + MINUTE })
    expect(ledger.check(SCOPE, limits, { requests: 1, inputTokens: 2000, totalTokens: 2500 })).toEqual({ ok: true })
  })

  it('counts output tokens too when the provider meters total tokens', () => {
    const { ledger } = createLedger()
    const limits = { tpm: 6000, tpmBasis: 'total', dayReset: 'rolling' } as const
    ledger.finish(ledger.begin(SCOPE, 3000), { counted: true, inputTokens: 3000, outputTokens: 2000 })

    expect(ledger.check(SCOPE, limits, { requests: 1, inputTokens: 500, totalTokens: 1500 })).toMatchObject({ ok: false, reason: 'TPM_WINDOW_FULL' })
    expect(ledger.check(SCOPE, { ...limits, tpmBasis: 'input' }, { requests: 1, inputTokens: 500, totalTokens: 1500 })).toEqual({ ok: true })
  })

  it('replaces the estimate with the tokens that the provider reported', () => {
    const { ledger } = createLedger()
    const limits = { tpm: 5000, tpmBasis: 'input', dayReset: 'rolling' } as const
    ledger.finish(ledger.begin(SCOPE, 4800), { counted: true, inputTokens: 1200, outputTokens: 80 })

    expect(ledger.usage(SCOPE, limits).minute.inputTokens).toBe(1200)
    expect(ledger.check(SCOPE, limits, { requests: 1, inputTokens: 3000, totalTokens: 3500 })).toEqual({ ok: true })
  })

  it('counts a request that is still in flight at its estimate', () => {
    const { ledger } = createLedger()

    ledger.begin(SCOPE, 4000)

    expect(ledger.usage(SCOPE, {}).minute).toMatchObject({ requests: 1, inputTokens: 4000 })
  })

  it('does not count a request that the provider refused or never processed', () => {
    const { ledger } = createLedger()
    const limits = { rpm: 1, tpmBasis: 'input', dayReset: 'rolling' } as const

    ledger.finish(ledger.begin(SCOPE, 4000), { counted: false })

    expect(ledger.usage(SCOPE, limits).minute.requests).toBe(0)
    expect(ledger.check(SCOPE, limits, ONE_REQUEST)).toEqual({ ok: true })
  })

  it('keeps scopes apart: another key or model has its own counters', () => {
    const { ledger } = createLedger()
    const limits = { rpm: 1, tpmBasis: 'input', dayReset: 'rolling' } as const
    ledger.finish(ledger.begin(SCOPE, 10), { counted: true })

    expect(ledger.check('provider-groq|openai/gpt-oss-20b', limits, ONE_REQUEST)).toEqual({ ok: true })
  })
})

describe('quotaLedger daily windows', () => {
  it('resets a rolling day count 24 hours after the request that frees a slot', () => {
    const { ledger, clock } = createLedger()
    const limits = { rpd: 2, tpmBasis: 'input', dayReset: 'rolling' } as const
    ledger.finish(ledger.begin(SCOPE, 10), { counted: true })
    clock.now += HOUR
    ledger.finish(ledger.begin(SCOPE, 10), { counted: true })
    clock.now += HOUR

    expect(ledger.check(SCOPE, limits, ONE_REQUEST)).toMatchObject({ ok: false, reason: 'RPD_EXHAUSTED', retryAtMs: T0 + 24 * HOUR })
  })

  it('resets a time-zone day at local midnight', () => {
    // 23:00 in Los Angeles on 7 October 2026 (PDT, UTC-7). Midnight follows at 07:00 UTC on 8 October.
    const evening = Date.parse('2026-10-07T23:00:00-07:00')
    const { ledger, clock } = createLedger(evening)
    const limits = { rpd: 2, tpmBasis: 'input', dayReset: { timeZone: 'America/Los_Angeles' } } as const
    ledger.finish(ledger.begin(SCOPE, 10), { counted: true })
    clock.now += 10 * MINUTE
    ledger.finish(ledger.begin(SCOPE, 10), { counted: true })

    expect(ledger.check(SCOPE, limits, ONE_REQUEST)).toMatchObject({ ok: false, reason: 'RPD_EXHAUSTED', retryAtMs: Date.parse('2026-10-08T00:00:00-07:00') })

    clock.now = Date.parse('2026-10-08T00:00:01-07:00')
    expect(ledger.check(SCOPE, limits, ONE_REQUEST)).toEqual({ ok: true })
    expect(ledger.usage(SCOPE, limits).day.requests).toBe(0)
  })

  it('blocks on tokens per day', () => {
    const { ledger } = createLedger()
    const limits = { tpd: 10_000, tpmBasis: 'input', dayReset: 'rolling' } as const
    ledger.finish(ledger.begin(SCOPE, 9000), { counted: true })

    expect(ledger.check(SCOPE, limits, { requests: 1, inputTokens: 2000, totalTokens: 2500 })).toMatchObject({ ok: false, reason: 'TPD_EXHAUSTED' })
  })
})

describe('quotaLedger cool-downs', () => {
  it('honors Retry-After from a rate-limit response and clears when the time passes', () => {
    const { ledger, clock } = createLedger()
    ledger.noteRateLimit(SCOPE, {}, { kind: 'rate-limited', window: 'minute', unit: 'tokens', retryAfterMs: 12_900 })

    expect(ledger.check(SCOPE, {}, ONE_REQUEST)).toMatchObject({ ok: false, reason: 'COOLING_DOWN', retryAtMs: T0 + 12_900 })

    clock.now += 13_000
    expect(ledger.check(SCOPE, {}, ONE_REQUEST)).toEqual({ ok: true })
    expect(ledger.cooldown(SCOPE)).toBeUndefined()
  })

  it('waits for the next daily reset after a daily limit without a retry time', () => {
    const evening = Date.parse('2026-10-07T23:00:00-07:00')
    const { ledger } = createLedger(evening)
    const limits = { dayReset: { timeZone: 'America/Los_Angeles' } } as const
    ledger.noteRateLimit(SCOPE, limits, { kind: 'rate-limited', window: 'day', unit: 'requests' })

    expect(ledger.cooldown(SCOPE)?.untilMs).toBe(Date.parse('2026-10-08T00:00:00-07:00'))
  })

  it('uses a full minute for a per-minute limit without a retry time, and 30 seconds when the window is unknown', () => {
    const { ledger } = createLedger()
    ledger.noteRateLimit('a', {}, { kind: 'rate-limited', window: 'minute', unit: 'requests' })
    ledger.noteRateLimit('b', {}, { kind: 'rate-limited', window: 'unknown', unit: 'unknown' })

    expect(ledger.cooldown('a')?.untilMs).toBe(T0 + MINUTE)
    expect(ledger.cooldown('b')?.untilMs).toBe(T0 + 30_000)
  })

  it('only extends a cool-down and never shortens it', () => {
    const { ledger } = createLedger()
    ledger.noteRateLimit(SCOPE, {}, { kind: 'rate-limited', window: 'minute', unit: 'requests', retryAfterMs: 50_000 })
    ledger.noteRateLimit(SCOPE, {}, { kind: 'rate-limited', window: 'minute', unit: 'requests', retryAfterMs: 5000 })

    expect(ledger.cooldown(SCOPE)?.untilMs).toBe(T0 + 50_000)
  })

  it('records the reason of a cool-down for diagnostics', () => {
    const { ledger } = createLedger()
    ledger.noteRateLimit(SCOPE, {}, { kind: 'rate-limited', window: 'day', unit: 'tokens', retryAfterMs: 1000 })

    expect(ledger.cooldown(SCOPE)?.reason).toBe('rate-limited:day:tokens')
  })
})

describe('quotaLedger observed limits', () => {
  it('blocks while the provider reports zero remaining requests, until its reset time', () => {
    const { ledger, clock } = createLedger()
    ledger.noteObserved(SCOPE, { remainingRequests: 0, resetRequestsAtMs: T0 + 3 * MINUTE, observedAtMs: T0 })

    expect(ledger.check(SCOPE, {}, ONE_REQUEST)).toMatchObject({ ok: false, reason: 'OBSERVED_REQUESTS_EXHAUSTED', retryAtMs: T0 + 3 * MINUTE })

    clock.now = T0 + 3 * MINUTE + 1
    expect(ledger.check(SCOPE, {}, ONE_REQUEST)).toEqual({ ok: true })
  })

  it('blocks a request that needs more tokens than the provider says remain, until the token window resets', () => {
    const { ledger } = createLedger()
    ledger.noteObserved(SCOPE, { remainingTokens: 1500, resetTokensAtMs: T0 + 7660, observedAtMs: T0 })

    expect(ledger.check(SCOPE, {}, { requests: 1, inputTokens: 4400, totalTokens: 4900 })).toMatchObject({ ok: false, reason: 'TPM_WINDOW_FULL', retryAtMs: T0 + 7660 })
    expect(ledger.check(SCOPE, {}, { requests: 1, inputTokens: 1000, totalTokens: 1200 })).toEqual({ ok: true })
  })

  it('keeps the configured limits apart from what it observed', () => {
    const { ledger } = createLedger()
    const limits = { rpd: 1000, tpm: 8000, tpmBasis: 'input', dayReset: 'rolling' } as const
    ledger.noteObserved(SCOPE, { limitTokens: 7000, remainingTokens: 6000, resetTokensAtMs: T0 + 5000, observedAtMs: T0 })

    const snapshot = ledger.snapshot(SCOPE, limits)

    expect(snapshot.configured).toEqual(limits)
    expect(snapshot.observed).toMatchObject({ limitTokens: 7000, remainingTokens: 6000 })
    expect(snapshot.cooldown).toBeUndefined()
  })
})

describe('quotaLedger storage', () => {
  const directories: string[] = []
  const databases: { close: () => void }[] = []
  afterEach(() => {
    // Windows keeps a SQLite file locked until every handle is closed.
    for (const db of databases.splice(0))
      db.close()
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  it('survives a restart: usage and cool-downs are still there after the database reopens', () => {
    const directory = mkdtempSync(join(tmpdir(), 'companion-ledger-'))
    directories.push(directory)
    const file = join(directory, 'state.sqlite')

    const first = openDatabase(file)
    const before = new QuotaLedger(first, () => T0)
    before.finish(before.begin(SCOPE, 4000), { counted: true })
    before.noteRateLimit(SCOPE, {}, { kind: 'rate-limited', window: 'minute', unit: 'requests', retryAfterMs: 20_000 })
    first.close()

    const reopened = openDatabase(file)
    databases.push(reopened)
    const after = new QuotaLedger(reopened, () => T0 + 5000)

    expect(after.usage(SCOPE, {}).minute).toMatchObject({ requests: 1, inputTokens: 4000 })
    expect(after.cooldown(SCOPE)?.untilMs).toBe(T0 + 20_000)
  })

  it('prunes usage that no window can still count', () => {
    const { ledger, clock } = createLedger()
    ledger.finish(ledger.begin(SCOPE, 10), { counted: true })
    clock.now += 30 * HOUR

    ledger.begin(SCOPE, 10)

    expect(ledger.usage(SCOPE, {}).day.requests).toBe(1)
    expect(ledger.snapshot(SCOPE, {}).storedEvents).toBe(1)
  })
})
