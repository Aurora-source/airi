import type { CompanionDatabase } from '../store/database'

const DAY_MS = 24 * 3_600_000
/** A sticky choice that nobody has used for this long is no use to anyone. */
const FORGET_AFTER_MS = 7 * DAY_MS

export interface StickyPolicy {
  /** A choice that was not used for this long expires. */
  idleMs: number
  /** Local hour of day, 0 to 23, at which every choice expires. Absent means no daily expiry. */
  resetHour?: number
}

export interface StickyChoice {
  modelId: string
  /** Why the conversation sits on this model, for example `served` or `failover:rate-limited`. */
  reason: string
  chosenAtMs: number
  lastUsedAtMs: number
}

/**
 * Remembers which model serves each conversation.
 *
 * Another model can change how the character speaks, so a conversation keeps its model while that model works.
 * A choice ends for one of these reasons only: the model failed or ran out of quota, a capability or size mismatch,
 * an explicit override, or an expiry by idle time or by the daily reset hour.
 * The router decides about the first three. This store applies the expiry.
 */
export class StickyStore {
  constructor(
    private readonly db: CompanionDatabase,
    private readonly now: () => number,
    private readonly policy: StickyPolicy,
  ) {}

  /** The current choice, or `undefined` when there is none or it expired. An expired choice is removed. */
  get(alias: string, conversation: string): StickyChoice | undefined {
    const row = this.db.prepare('SELECT model_id, reason, chosen_at_ms, last_used_at_ms FROM sticky_choice WHERE alias = ? AND conversation = ?').get(alias, conversation) as
      | { model_id: string, reason: string, chosen_at_ms: number, last_used_at_ms: number }
      | undefined
    if (!row)
      return undefined
    const now = this.now()
    const idle = now - row.last_used_at_ms > this.policy.idleMs
    const resetBoundary = this.policy.resetHour === undefined ? undefined : latestLocalHour(now, this.policy.resetHour)
    const reset = resetBoundary !== undefined && row.chosen_at_ms < resetBoundary
    if (idle || reset) {
      this.db.prepare('DELETE FROM sticky_choice WHERE alias = ? AND conversation = ?').run(alias, conversation)
      return undefined
    }
    return { modelId: row.model_id, reason: row.reason, chosenAtMs: row.chosen_at_ms, lastUsedAtMs: row.last_used_at_ms }
  }

  /**
   * Records that a model served the conversation. The same model keeps its original choice time and reason.
   * A different model replaces the choice.
   */
  set(alias: string, conversation: string, modelId: string, reason: string): void {
    const now = this.now()
    this.db.prepare('DELETE FROM sticky_choice WHERE last_used_at_ms < ?').run(now - FORGET_AFTER_MS)
    this.db.prepare(`
      INSERT INTO sticky_choice (alias, conversation, model_id, reason, chosen_at_ms, last_used_at_ms) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (alias, conversation) DO UPDATE SET
        reason = CASE WHEN sticky_choice.model_id = excluded.model_id THEN sticky_choice.reason ELSE excluded.reason END,
        chosen_at_ms = CASE WHEN sticky_choice.model_id = excluded.model_id THEN sticky_choice.chosen_at_ms ELSE excluded.chosen_at_ms END,
        model_id = excluded.model_id,
        last_used_at_ms = excluded.last_used_at_ms
    `).run(alias, conversation, modelId, reason, now, now)
  }

  /** Every live choice, for the Ops view. The conversation key is a hash and holds no message text. */
  list(): (StickyChoice & { alias: string, conversation: string })[] {
    return this.db.prepare('SELECT alias, conversation, model_id, reason, chosen_at_ms, last_used_at_ms FROM sticky_choice ORDER BY last_used_at_ms DESC LIMIT 50').all().map(row => ({
      alias: String(row.alias),
      conversation: String(row.conversation),
      modelId: String(row.model_id),
      reason: String(row.reason),
      chosenAtMs: Number(row.chosen_at_ms),
      lastUsedAtMs: Number(row.last_used_at_ms),
    }))
  }
}

/** The most recent local time at `hour:00` that is not after `nowMs`. */
function latestLocalHour(nowMs: number, hour: number): number {
  const boundary = new Date(nowMs)
  boundary.setHours(hour, 0, 0, 0)
  if (boundary.getTime() > nowMs)
    boundary.setDate(boundary.getDate() - 1)
  return boundary.getTime()
}
