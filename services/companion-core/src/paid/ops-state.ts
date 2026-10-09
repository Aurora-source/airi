import type { CompanionDatabase } from '../store/database'

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Tables of `companion-ops.sqlite`. `PRAGMA user_version` is the schema version of this file only.
 *
 * - `setting`: one JSON value per key, written only by authenticated Ops requests. Each consumer validates its value.
 * - `paid_request`: one row per request to a paid Gemini provider. It holds model ids, efforts, token counts, estimated
 *   cost in nanodollars, timings, and an error category. It never holds message text, keys, or provider bodies.
 *
 * It is a separate file, so `companion-core.sqlite` keeps schema version 1 and older builds that share the Core home
 * still start.
 */
const SCHEMA_V1 = `
CREATE TABLE setting (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE paid_request (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  day TEXT NOT NULL,
  month TEXT NOT NULL,
  alias TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider_model TEXT NOT NULL,
  effort TEXT,
  effort_source TEXT,
  status TEXT NOT NULL,
  priced INTEGER NOT NULL,
  input_tokens INTEGER,
  cached_tokens INTEGER,
  output_tokens INTEGER,
  thinking_tokens INTEGER,
  cost_nano INTEGER,
  estimate_nano INTEGER,
  first_byte_ms INTEGER,
  duration_ms INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX paid_request_day ON paid_request (day);
CREATE INDEX paid_request_month ON paid_request (month);
CREATE INDEX paid_request_at ON paid_request (at_ms);
`

/** `settled` has provider usage. `unknown` was sent but has no usable usage. `failed` got an HTTP error. */
export type PaidStatus = 'settled' | 'unknown' | 'failed'

export interface PaidRequestRecord {
  atMs: number
  day: string
  month: string
  alias: string
  modelId: string
  providerModel: string
  effort?: string
  effortSource?: string
  status: PaidStatus
  priced: boolean
  inputTokens?: number
  cachedTokens?: number
  outputTokens?: number
  thinkingTokens?: number
  costNano?: number
  /** For `unknown`: a conservative estimate from the Gateway's token estimates. */
  estimateNano?: number
  firstByteMs?: number
  durationMs: number
  error?: string
}

export interface PaidTotals {
  requests: number
  settled: number
  unknown: number
  failed: number
  unpriced: number
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  thinkingTokens: number
  costNano: number
  estimateNano: number
}

export interface PaidBreakdown extends PaidTotals {
  model: string
  effort: string | null
}

const TOTALS_SQL = `COUNT(*) AS requests,
  SUM(status = 'settled') AS settled, SUM(status = 'unknown') AS unknown, SUM(status = 'failed') AS failed,
  SUM(priced = 0) AS unpriced,
  SUM(COALESCE(input_tokens, 0)) AS inputTokens, SUM(COALESCE(cached_tokens, 0)) AS cachedTokens,
  SUM(COALESCE(output_tokens, 0)) AS outputTokens, SUM(COALESCE(thinking_tokens, 0)) AS thinkingTokens,
  SUM(COALESCE(cost_nano, 0)) AS costNano, SUM(CASE WHEN status = 'unknown' THEN COALESCE(estimate_nano, 0) ELSE 0 END) AS estimateNano`

/**
 * Durable Ops state of the Core: user settings and the paid request ledger.
 * `:memory:` keeps everything in memory. Tests use it.
 */
export class OpsStateStore {
  private readonly db: CompanionDatabase

  constructor(path: string) {
    if (path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA busy_timeout = 2000')
    if (path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA synchronous = NORMAL')
    }
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (version === 0) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(SCHEMA_V1)
        this.db.exec('PRAGMA user_version = 1')
        this.db.exec('COMMIT')
      }
      catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    else if (version !== 1) {
      this.db.close()
      throw new Error(`The Ops state database has schema version ${version}, and this build reads version 1.`)
    }
  }

  /** The raw stored value, or `undefined`. The caller validates it. */
  setting(key: string): unknown {
    const row = this.db.prepare('SELECT value_json FROM setting WHERE key = ?').get(key) as { value_json: string } | undefined
    if (!row)
      return undefined
    try {
      return JSON.parse(row.value_json)
    }
    catch {
      return undefined
    }
  }

  setSetting(key: string, value: unknown, nowMs: number): void {
    this.db.prepare(`INSERT INTO setting (key, value_json, updated_at_ms) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms`).run(key, JSON.stringify(value), nowMs)
  }

  insertPaidRequest(record: PaidRequestRecord): void {
    this.db.prepare(`INSERT INTO paid_request (at_ms, day, month, alias, model_id, provider_model, effort, effort_source, status, priced,
      input_tokens, cached_tokens, output_tokens, thinking_tokens, cost_nano, estimate_nano, first_byte_ms, duration_ms, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.atMs,
      record.day,
      record.month,
      record.alias,
      record.modelId,
      record.providerModel,
      record.effort ?? null,
      record.effortSource ?? null,
      record.status,
      record.priced ? 1 : 0,
      record.inputTokens ?? null,
      record.cachedTokens ?? null,
      record.outputTokens ?? null,
      record.thinkingTokens ?? null,
      record.costNano ?? null,
      record.estimateNano ?? null,
      record.firstByteMs ?? null,
      record.durationMs,
      record.error ?? null,
    )
  }

  totals(window: { day: string } | { month: string }): PaidTotals {
    const [column, value] = 'day' in window ? ['day', window.day] : ['month', window.month]
    const row = this.db.prepare(`SELECT ${TOTALS_SQL} FROM paid_request WHERE ${column} = ?`).get(value) as Record<string, number | null>
    return totalsOf(row)
  }

  breakdown(month: string): PaidBreakdown[] {
    const rows = this.db.prepare(`SELECT provider_model AS model, effort, ${TOTALS_SQL} FROM paid_request WHERE month = ?
      GROUP BY provider_model, effort ORDER BY provider_model, effort LIMIT 64`).all(month) as Array<Record<string, number | string | null>>
    return rows.map(row => ({ model: String(row.model), effort: row.effort === null ? null : String(row.effort), ...totalsOf(row as Record<string, number | null>) }))
  }

  /** Newest first. */
  recent(limit: number): PaidRequestRecord[] {
    const rows = this.db.prepare('SELECT * FROM paid_request ORDER BY at_ms DESC, id DESC LIMIT ?').all(limit) as Array<Record<string, number | string | null>>
    return rows.map(row => ({
      atMs: Number(row.at_ms),
      day: String(row.day),
      month: String(row.month),
      alias: String(row.alias),
      modelId: String(row.model_id),
      providerModel: String(row.provider_model),
      effort: optionalText(row.effort),
      effortSource: optionalText(row.effort_source),
      status: String(row.status) as PaidStatus,
      priced: row.priced === 1,
      inputTokens: optionalNumber(row.input_tokens),
      cachedTokens: optionalNumber(row.cached_tokens),
      outputTokens: optionalNumber(row.output_tokens),
      thinkingTokens: optionalNumber(row.thinking_tokens),
      costNano: optionalNumber(row.cost_nano),
      estimateNano: optionalNumber(row.estimate_nano),
      firstByteMs: optionalNumber(row.first_byte_ms),
      durationMs: Number(row.duration_ms),
      error: optionalText(row.error),
    }))
  }

  /** Error categories of failed and unknown requests in a month, with counts. */
  errors(month: string): Record<string, number> {
    const rows = this.db.prepare(`SELECT error, COUNT(*) AS count FROM paid_request WHERE month = ? AND error IS NOT NULL
      GROUP BY error ORDER BY count DESC LIMIT 32`).all(month) as Array<{ error: string, count: number }>
    return Object.fromEntries(rows.map(row => [row.error, Number(row.count)]))
  }

  prune(beforeMs: number): void {
    this.db.prepare('DELETE FROM paid_request WHERE at_ms < ?').run(beforeMs)
  }

  close(): void {
    this.db.close()
  }
}

function totalsOf(row: Record<string, number | null> | undefined): PaidTotals {
  const n = (value: number | null | undefined) => Number(value ?? 0)
  return {
    requests: n(row?.requests),
    settled: n(row?.settled),
    unknown: n(row?.unknown),
    failed: n(row?.failed),
    unpriced: n(row?.unpriced),
    inputTokens: n(row?.inputTokens),
    cachedTokens: n(row?.cachedTokens),
    outputTokens: n(row?.outputTokens),
    thinkingTokens: n(row?.thinkingTokens),
    costNano: n(row?.costNano),
    estimateNano: n(row?.estimateNano),
  }
}

function optionalNumber(value: number | string | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : Number(value)
}

function optionalText(value: number | string | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : String(value)
}
