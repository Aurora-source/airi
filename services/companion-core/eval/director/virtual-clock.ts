import type { DirectorClock } from '../../src/director'

/**
 * Advances only explicit owned deadlines. Simulations run multi-hour sessions without wall-clock sleeps.
 * @example
 * const clock = new VirtualClock()
 * clock.advance(60_000)
 */
export class VirtualClock implements DirectorClock {
  private time = Date.UTC(2026, 9, 8, 10)
  private sequence = 0
  private readonly timers = new Map<number, { at: number, callback: () => void }>()

  readonly now = () => this.time

  readonly schedule = (delayMs: number, callback: () => void): (() => void) => {
    const id = ++this.sequence
    this.timers.set(id, { at: this.time + delayMs, callback })
    return () => {
      this.timers.delete(id)
    }
  }

  get pendingTimers(): number { return this.timers.size }

  advance(durationMs: number): void {
    if (!Number.isSafeInteger(durationMs) || durationMs < 0)
      throw new Error('Invalid virtual clock duration')
    const target = this.time + durationMs
    let remaining = 10000
    while (remaining-- > 0) {
      const next = [...this.timers.entries()].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next)
        break
      this.time = next[1].at
      this.timers.delete(next[0])
      next[1].callback()
    }
    if (remaining <= 0)
      throw new Error('Unbounded timer loop')
    this.time = target
  }
}
