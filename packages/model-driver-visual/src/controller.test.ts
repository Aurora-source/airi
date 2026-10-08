import type { VisualAxis, VisualFrame, VisualModelAdapter } from './contracts'

import { describe, expect, it, vi } from 'vitest'

import { visualBehaviorCatalog } from './catalog'
import { createVisualBehaviorController } from './controller'

function fixture(axes: VisualAxis[] = ['headPitch', 'headYaw', 'headRoll', 'bodyPitch', 'bodyRoll']) {
  let now = 0
  let seed = 42
  const frames: VisualFrame[] = []
  const adapter: VisualModelAdapter = {
    capabilities: {
      modelId: 'test',
      axes: new Set(axes),
      expressions: new Set(['happy', 'sad']),
      motions: [],
      nativeMicro: new Set(['blink']),
    },
    apply: frame => frames.push({ ...frame }),
    release: vi.fn(),
    dispose: vi.fn(),
  }
  const controller = createVisualBehaviorController({ adapter, now: () => now, random: () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) })
  const advance = (ms: number) => {
    now += ms
    controller.update()
  }
  return { controller, adapter, frames, advance }
}
describe('visual presence admission and lifecycle', () => {
  it.each([
    { amount: 1000, initial: 0.01, next: 1.5 },
    { amount: 0.04, initial: Number.MIN_VALUE, next: 1 },
  ])('keeps recovery finite and bounded after amplitude changes: $initial', ({ amount, initial, next }) => {
    const f = fixture()
    let now = 0
    const controller = createVisualBehaviorController({ adapter: f.adapter, now: () => now, tuning: { bodyAmplitude: initial }, catalog: [{ id: 'custom', category: 'short', durationMs: 2000, cooldownMs: 0, weight: 1, pose: { bodyPitch: amount } }] })
    controller.playVisualBehavior('custom')
    now = 1200
    controller.update()
    controller.cancelBehavior()
    controller.setMotionTuning({ bodyAmplitude: next })
    now = 1300
    controller.update()
    const pose = f.frames.at(-1)!
    expect(Object.values(pose).filter(value => typeof value === 'number').every(Number.isFinite)).toBe(true)
    expect(Math.abs(pose.bodyPitch)).toBeLessThanOrEqual(0.09)
  })

  it('keeps absent and nonfinite custom pose values out of adapter frames', () => {
    const f = fixture()
    let now = 0
    const controller = createVisualBehaviorController({ adapter: f.adapter, now: () => now, catalog: [{ id: 'custom', category: 'short', durationMs: 2000, cooldownMs: 0, weight: 1, pose: { headYaw: undefined, headRoll: Infinity, headPitch: 0.1 } }] })
    expect(controller.playVisualBehavior('custom')).toBe('started')
    now = 700
    controller.update()
    expect(f.frames.at(-1)?.headYaw).toBe(0)
    expect(f.frames.at(-1)?.headRoll).toBe(0)
    expect(f.frames.at(-1)?.headPitch).toBeGreaterThan(0.05)
  })

  it('retains oscillations for caller-supplied catalogs', () => {
    const samples: number[] = []
    for (const oscillations of [1, 4]) {
      const f = fixture()
      let now = 0
      const controller = createVisualBehaviorController({ adapter: f.adapter, now: () => now, catalog: [{ id: 'custom', category: 'short', durationMs: 2000, cooldownMs: 0, weight: 1, pose: { headPitch: 0.1 }, oscillations }] })
      controller.playVisualBehavior('custom')
      now = 800
      controller.update()
      samples.push(f.frames.at(-1)!.headPitch)
    }
    expect(samples[0]).toBeGreaterThan(0.05)
    expect(samples[1]).toBeLessThan(-0.05)
  })
  it('starts idle from render ticks and stops all owned state', () => {
    const f = fixture()
    f.controller.start()
    f.advance(1000)
    expect(f.frames.length).toBeGreaterThan(0)
    f.controller.stop()
    const count = f.frames.length
    f.advance(60000)
    expect(f.frames).toHaveLength(count)
    expect(f.adapter.release).toHaveBeenCalled()
  })
  it.each(['speaking', 'act', 'modelMotion', 'userControl'] as const)('%s immediately interrupts idle and blocks requests', (owner) => {
    const f = fixture()
    f.controller.start()
    f.advance(70000)
    f.controller.setExternalActivity({ speaking: false, act: false, modelMotion: false, userControl: false, [owner]: true })
    expect(f.controller.playVisualBehavior('amused')).toBe('blocked')
    const count = f.frames.length
    f.advance(1000)
    expect(f.frames).toHaveLength(count)
    expect(f.adapter.release).toHaveBeenCalled()
  })
  it('admits an explicit reaction above idle and returns smoothly to neutral', () => {
    const f = fixture()
    f.controller.start()
    f.advance(70000)
    expect(f.controller.playVisualBehavior('concerned')).toBe('started')
    f.advance(1000)
    expect(f.frames.at(-1)?.expression).toBe('sad')
    expect(f.frames.at(-1)?.headRoll).toBeGreaterThan(0)
    f.controller.returnToNeutral()
    f.advance(500)
    expect(f.adapter.release).toHaveBeenCalled()
    expect(f.controller.snapshot().behavior).toBeUndefined()
  })
  it('listening has priority over explicit reactions and yields to speech', () => {
    const f = fixture()
    f.controller.start()
    f.controller.setVisualActivity('listening')
    expect(f.controller.snapshot().behavior).toBe('listening')
    expect(f.controller.playVisualBehavior('surprised')).toBe('blocked')
    f.controller.setVisualActivity('idle')
    expect(f.controller.snapshot().behavior).toBeUndefined()
  })
  it('enforces cooldown across cancelled repetitions', () => {
    const f = fixture()
    expect(f.controller.playVisualBehavior('amused')).toBe('started')
    f.controller.cancelBehavior()
    expect(f.controller.playVisualBehavior('amused')).toBe('cooldown')
    f.advance(12001)
    expect(f.controller.playVisualBehavior('amused')).toBe('started')
  })
  it('avoids adjacent idle repetitions and leaves long neutral periods', () => {
    const f = fixture()
    f.controller.setIdleIntensity('lively')
    f.controller.start()
    const seen: string[] = []
    let previous: string | undefined
    for (let i = 0; i < 1200; i++) {
      f.advance(1000)
      const state = f.controller.snapshot()
      if (state.behavior && state.behavior !== previous)
        seen.push(state.behavior)
      previous = state.behavior
    }
    expect(seen.length).toBeGreaterThan(10)
    expect(seen.length).toBeLessThan(55)
    for (let i = 1; i < seen.length; i++)
      expect(seen[i]).not.toBe(seen[i - 1])
  })
  it('falls back from missing expression or motion to a compatible pose', () => {
    const f = fixture()
    expect(f.controller.playVisualBehavior('surprised')).toBe('started')
    f.advance(800)
    expect(f.frames.at(-1)?.headPitch).toBeLessThan(0)
    expect(f.frames.at(-1)?.expression).toBeUndefined()
    f.controller.returnToNeutral()
    expect(f.controller.playVisualBehavior('stretch')).toBe('started')
  })
  it('remains neutral for unsupported models', () => {
    const f = fixture([])
    expect(f.controller.playVisualBehavior('surprised')).toBe('unsupported')
  })
  it('falls back safely when a configured optional motion fails', () => {
    const f = fixture()
    const adapter: VisualModelAdapter = {
      ...f.adapter,
      capabilities: { ...f.adapter.capabilities, motions: [{ id: 'native-stretch', role: 'stretch', durationMs: 5000 }] },
      playMotion: () => { throw new Error('Missing optional asset') },
    }
    f.controller.attach(adapter)
    expect(f.controller.playVisualBehavior('stretch')).toBe('started')
    f.advance(2000)
    expect(f.frames.at(-1)?.bodyPitch).toBeLessThan(0)
  })
  it('stops only its owned native motion when an external owner interrupts', () => {
    const f = fixture()
    const stop = vi.fn()
    f.controller.attach({
      ...f.adapter,
      capabilities: { ...f.adapter.capabilities, motions: [{ id: 'native-stretch', role: 'stretch', durationMs: 5000 }] },
      playMotion: () => ({ stop }),
    })
    expect(f.controller.playVisualBehavior('stretch')).toBe('started')
    f.advance(1000)
    expect(f.frames.at(-1)?.bodyPitch).toBe(0)
    f.controller.setExternalActivity({ speaking: true, act: false, modelMotion: false, userControl: false })
    expect(stop).toHaveBeenCalledTimes(1)
    f.controller.dispose()
    expect(stop).toHaveBeenCalledTimes(1)
  })
  it('switches models without retaining old handles or cooldowns', () => {
    const f = fixture()
    f.controller.playVisualBehavior('amused')
    const next = fixture().adapter
    f.controller.attach(next)
    expect(f.adapter.dispose).toHaveBeenCalledTimes(1)
    expect(f.controller.snapshot().behavior).toBeUndefined()
    expect(f.controller.playVisualBehavior('amused')).toBe('started')
  })
  it('handles rapid state changes and repeated disposal without timers', () => {
    const f = fixture()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    try {
      for (let i = 0; i < 100; i++) {
        f.controller.setVisualActivity('listening')
        f.controller.setVisualActivity('idle')
        f.controller.cancelBehavior()
        f.advance(1)
      }
      f.controller.dispose()
      f.controller.dispose()
      expect(f.adapter.dispose).toHaveBeenCalledTimes(1)
      expect(f.controller.playVisualBehavior('happy')).toBe('disposed')
      expect(timers).not.toHaveBeenCalled()
    }
    finally {
      timers.mockRestore()
    }
  })
  it('still mode produces no added idle while explicit visual requests remain available', () => {
    const f = fixture()
    f.controller.setIdleIntensity('still')
    f.controller.start()
    f.advance(300000)
    expect(f.frames).toHaveLength(0)
    expect(f.controller.playVisualBehavior('happy')).toBe('started')
  })
  it('bounds every catalog pose and expression through all intensities', () => {
    const f = fixture()
    for (const entry of visualBehaviorCatalog) {
      f.advance(300001)
      f.controller.playVisualBehavior(entry.id)
      f.advance(entry.durationMs / 2)
      const frame = f.frames.at(-1)
      expect(Math.abs(frame?.headPitch ?? 0)).toBeLessThanOrEqual(0.22)
      expect(frame?.expressionWeight ?? 0).toBeLessThanOrEqual(0.45)
    }
  })
})
