import { describe, expect, it } from 'vitest'

import { ModelHealth } from '../src/routing/health'

const T0 = 1_000_000
const OPTIONS = { baseCooldownMs: 10_000, maxCooldownMs: 300_000 }

function create() {
  const clock = { now: T0 }
  return { health: new ModelHealth(OPTIONS, () => clock.now), clock }
}

describe('modelHealth failures', () => {
  it('has no cool-down for a model without failures', () => {
    const { health } = create()

    expect(health.coolingUntil('a')).toBeUndefined()
  })

  it('doubles the cool-down for each failure in a row, up to the maximum', () => {
    const { health, clock } = create()
    const seen: number[] = []
    for (let i = 0; i < 8; i++) {
      health.recordFailure('a', 'network')
      seen.push(health.coolingUntil('a')! - clock.now)
    }

    expect(seen).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000])
  })

  it('clears the failure streak and the cool-down after a success', () => {
    const { health } = create()
    health.recordFailure('a', 'server')
    health.recordFailure('a', 'server')

    health.recordSuccess('a', 300)

    expect(health.coolingUntil('a')).toBeUndefined()
    health.recordFailure('a', 'server')
    expect(health.coolingUntil('a')).toBe(T0 + 10_000)
  })

  it('ends a cool-down when its time passes', () => {
    const { health, clock } = create()
    health.recordFailure('a', 'timeout')

    clock.now += 10_001

    expect(health.coolingUntil('a')).toBeUndefined()
  })

  it('rests an unauthorized key for ten minutes and a missing model for thirty', () => {
    const { health } = create()
    health.recordFailure('a', 'auth')
    health.recordFailure('b', 'model-not-found')

    expect(health.coolingUntil('a')).toBe(T0 + 600_000)
    expect(health.coolingUntil('b')).toBe(T0 + 1_800_000)
  })

  it('never shortens a cool-down because of a provider retry hint', () => {
    const { health } = create()
    health.recordFailure('a', 'server', 120_000)

    expect(health.coolingUntil('a')).toBe(T0 + 120_000)
  })

  it('keeps models apart', () => {
    const { health } = create()
    health.recordFailure('a', 'network')

    expect(health.coolingUntil('b')).toBeUndefined()
  })
})

describe('modelHealth latency', () => {
  it('keeps an exponentially weighted average of the first-byte latency', () => {
    const { health } = create()
    health.recordSuccess('a', 1000)
    health.recordSuccess('a', 2000)

    expect(health.snapshot('a').latencyEwmaMs).toBeCloseTo(1300, 0)
  })

  it('reports the last success and the failures of the recent window', () => {
    const { health, clock } = create()
    health.recordSuccess('a', 500)
    clock.now += 1000
    health.recordFailure('a', 'network')

    const snapshot = health.snapshot('a')

    expect(snapshot.lastSuccessAtMs).toBe(T0)
    expect(snapshot.consecutiveFailures).toBe(1)
    expect(snapshot.recentFailures).toBe(1)
    expect(snapshot.recentRequests).toBe(2)
  })
})

describe('modelHealth calibration', () => {
  it('starts at one and moves toward the ratio of reported to estimated tokens', () => {
    const { health } = create()

    expect(health.calibration('a')).toBe(1)

    health.recordUsage('a', 10_000, 8000)
    expect(health.calibration('a')).toBeLessThan(1)
    expect(health.calibration('a')).toBeGreaterThan(0.8)
  })

  it('stays between 0.8 and 1.5, so that a bad sample cannot make the estimates reckless', () => {
    const { health } = create()
    for (let i = 0; i < 50; i++)
      health.recordUsage('low', 10_000, 1000)
    for (let i = 0; i < 50; i++)
      health.recordUsage('high', 1000, 10_000)

    expect(health.calibration('low')).toBe(0.8)
    expect(health.calibration('high')).toBe(1.5)
  })

  it('ignores tiny requests, whose ratio is noise', () => {
    const { health } = create()
    health.recordUsage('a', 100, 10)

    expect(health.calibration('a')).toBe(1)
  })

  it('settles on the true ratio and stays there, because it learns from the uncalibrated estimate', () => {
    const { health } = create()
    const baseEstimate = 10_000
    const trueTokens = 9000

    // Each request is estimated with the calibration that was learned so far, as the executor does.
    for (let i = 0; i < 80; i++)
      health.recordUsage('a', baseEstimate * health.calibration('a'), trueTokens)

    expect(health.calibration('a')).toBeCloseTo(0.9, 2)
  })
})
