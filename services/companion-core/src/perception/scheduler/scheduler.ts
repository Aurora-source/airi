import type { Change } from '../change-detection/detector'

export interface ScheduleOptions {
  /** @default 20000 */
  minimum_interval_ms?: number
  /** Absent disables idle uploads, including in cloud profiles. */
  maximum_idle_refresh_ms?: number
  /** @default 500 */
  debounce_ms?: number
}

export interface ScheduleInput {
  now: number
  available: boolean
  allowed: boolean
  level: Change['level']
  duplicate: boolean
  manual?: boolean
  last_success_at?: number
  activity?: string
}

/** Captures can poll cheaply. Only meaningful events, manual requests, or opt-in idle refresh trigger vision. */
export class Scheduler {
  private lastAttempt = Number.NEGATIVE_INFINITY
  private retryAt = Number.NEGATIVE_INFINITY
  private changedSince?: number
  private readonly minimum: number
  private readonly debounce: number
  private readonly idle?: number

  constructor(options: ScheduleOptions = {}) {
    this.minimum = options.minimum_interval_ms ?? 20000
    this.debounce = options.debounce_ms ?? 500
    this.idle = options.maximum_idle_refresh_ms
    for (const value of [this.minimum, this.debounce, this.idle]) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0))
        throw new Error('Invalid perception schedule')
    }
  }

  decide(input: ScheduleInput): 'skip' | 'capture-only' | 'vision-request' {
    if (!input.available)
      return 'skip'
    if (!input.allowed || input.now < this.retryAt)
      return 'capture-only'
    if (input.manual)
      return 'vision-request'
    const changed = !input.duplicate && (input.level === 'major' || input.level === 'meaningful')
    if (changed)
      this.changedSince ??= input.now
    else this.changedSince = undefined
    if (input.now - this.lastAttempt < this.minimum)
      return 'capture-only'
    const idle = this.idle !== undefined && input.last_success_at !== undefined && input.now - input.last_success_at >= this.idle
    if (idle || (changed && (input.level === 'major' || input.now - this.changedSince! >= this.debounce)))
      return 'vision-request'
    return 'capture-only'
  }

  attempted(now: number): void {
    this.lastAttempt = now
    this.changedSince = undefined
  }

  failed(now: number, retryAfterMs = 5000): void {
    this.retryAt = now + Math.max(0, retryAfterMs)
  }
}
