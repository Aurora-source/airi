import type { VisualAxis, VisualFrame } from '@proj-airi/model-driver-visual'
import type { OutputVisualStateEvent } from '@proj-airi/server-sdk'
import type { VrmFrameRuntimeHook } from '@proj-airi/stage-ui-three/composables/vrm'

import type { VisualPresenceAdapter } from './host'

import { createVisualBehaviorController } from '@proj-airi/model-driver-visual'
import { describe, expect, it } from 'vitest'

import { VisualPresenceHost } from './host'

type VRM = Parameters<VrmFrameRuntimeHook>[0]

/** Every axis and expression exists, so admission depends only on ownership. */
class AllAxes extends Set<VisualAxis> {
  override has(): boolean {
    return true
  }
}

function fakeAdapter() {
  const record = { applied: [] as Readonly<VisualFrame>[], released: 0, flushed: 0, disposed: 0 }
  const adapter: VisualPresenceAdapter = {
    capabilities: { modelId: 'model', axes: new AllAxes(), expressions: new Set(['happy', 'relaxed', 'sad', 'angry', 'surprised', 'sleepy']), motions: [], nativeMicro: new Set(['blink', 'gaze', 'pose']) },
    apply: frame => void record.applied.push({ ...frame }),
    release: () => void record.released++,
    flushExpressions: () => void record.flushed++,
    dispose: () => void record.disposed++,
  }
  return { adapter, record }
}

function setup(options: { src?: string } = {}) {
  let time = 1000
  let src = options.src ?? 'blob:model-a'
  const adapters: ReturnType<typeof fakeAdapter>[] = []
  const states: OutputVisualStateEvent[] = []
  const host = new VisualPresenceHost({
    modelSrc: () => src,
    modelId: () => 'model',
    now: () => time,
    onState: state => states.push(state),
    createController: () => createVisualBehaviorController({ now: () => time, random: () => 0.5 }),
    createAdapter: () => {
      const created = fakeAdapter()
      adapters.push(created)
      return created.adapter
    },
  })
  const vrm = {} as VRM
  const context = { modelSrc: src, actActive: false, lipSyncActive: false }
  const frame = (model = vrm, overrides: Partial<typeof context> = {}) => {
    const current = { ...context, modelSrc: src, ...overrides }
    host.frame(model, 1 / 60, current)
    host.expressionFrame(model, 1 / 60, current)
  }
  return {
    host,
    adapters,
    states,
    vrm,
    frame,
    advance: (ms: number) => {
      time += ms
    },
    switchModel: (next: string) => {
      src = next
    },
  }
}

describe('visualPresenceHost', () => {
  it('binds the committed model on its first frame and ignores frames of another source', () => {
    const t = setup()
    t.frame(t.vrm, { modelSrc: 'blob:other' })
    expect(t.adapters).toHaveLength(0)
    t.frame()
    expect(t.adapters).toHaveLength(1)
    expect(t.states.at(-1)).toEqual({ available: true, blocked: false })
  })

  it('starts the dedicated curious behavior for a remote request and samples it after the mixer', () => {
    const t = setup()
    t.frame()
    expect(t.host.request({ requestId: 'r1', behavior: 'curious', activity: 'watching', leaseMs: 5000 })).toBe('started')
    t.advance(800)
    t.frame()
    const last = t.adapters[0].record.applied.at(-1)!
    expect(Math.abs(last.headRoll)).toBeGreaterThan(0)
    expect(t.adapters[0].record.flushed).toBeGreaterThan(0)
  })

  it('yields at once to speaking and ACT, and never flushes expressions over them', () => {
    const t = setup()
    t.frame()
    t.host.request({ requestId: 'r1', behavior: 'amused', leaseMs: 5000 })
    t.advance(300)
    t.frame()
    const flushed = t.adapters[0].record.flushed
    t.frame(t.vrm, { lipSyncActive: true })
    expect(t.adapters[0].record.released).toBeGreaterThan(0)
    expect(t.states.at(-1)).toEqual({ available: true, blocked: true })
    expect(t.adapters[0].record.flushed).toBe(flushed)
    expect(t.host.diagnostics().ownedRequest).toBe(false)

    t.frame(t.vrm, { actActive: true })
    expect(t.host.request({ requestId: 'r2', behavior: 'surprised', leaseMs: 5000 })).toBe('blocked')
  })

  it('blocks reactions while the user speaks, so listening keeps priority', () => {
    const t = setup()
    t.frame()
    t.host.setLocalActivity('listening')
    t.frame()
    expect(t.host.diagnostics().activity).toBe('listening')
    expect(t.host.request({ requestId: 'r1', behavior: 'curious', leaseMs: 5000 })).toBe('blocked')
  })

  it('keeps thinking and waiting distinct, and lets local activity outrank remote watching', () => {
    const t = setup()
    t.frame()
    t.host.request({ requestId: 'activity', activity: 'watching', leaseMs: 30_000 })
    t.frame()
    expect(t.host.diagnostics().activity).toBe('watching')
    t.host.setLocalActivity('thinking')
    t.frame()
    expect(t.host.diagnostics().activity).toBe('thinking')
    t.host.setLocalActivity('waiting')
    t.frame()
    expect(t.host.diagnostics().activity).toBe('waiting')
    t.host.setLocalActivity(undefined)
    t.frame()
    expect(t.host.diagnostics().activity).toBe('watching')
    t.advance(31_000)
    t.frame()
    expect(t.host.diagnostics().activity).toBe('idle')
  })

  it('cancels only its own request, and ends a behavior at a shorter lease', () => {
    const t = setup()
    t.frame()
    t.host.request({ requestId: 'r1', behavior: 'focused', leaseMs: 1000 })
    t.host.cancel('someone-else')
    expect(t.host.diagnostics().ownedRequest).toBe(true)
    t.advance(1100)
    t.frame()
    expect(t.host.diagnostics().ownedRequest).toBe(false)
    // Recovery fades toward neutral without a new behavior.
    t.advance(500)
    t.frame()
    t.advance(500)
    t.frame()
    const last = t.adapters[0].record.applied.at(-1)
    expect(last === undefined || Math.abs(last.headPitch) < 1e-6).toBe(true)
  })

  it('does not accumulate offsets across rapid repeated reactions', () => {
    const t = setup()
    t.frame()
    let peak = 0
    for (let i = 0; i < 40; i++) {
      t.host.request({ requestId: `r${i}`, behavior: i % 2 ? 'surprised' : 'amused', leaseMs: 5000 })
      t.advance(150)
      t.frame()
      for (const value of Object.values(t.adapters[0].record.applied.at(-1) ?? {})) {
        if (typeof value === 'number')
          peak = Math.max(peak, Math.abs(value))
      }
    }
    expect(peak).toBeLessThan(0.85)
  })

  it('releases the old model before a switch, binds the new one, and disposes cleanly', () => {
    const t = setup()
    t.frame()
    t.switchModel('blob:model-b')
    t.host.release()
    expect(t.adapters[0].record.disposed).toBe(1)
    expect(t.states.at(-1)).toEqual({ available: false, blocked: false })
    const next = {} as VRM
    t.frame(next)
    expect(t.adapters).toHaveLength(2)
    t.host.dispose()
    expect(t.adapters[1].record.disposed).toBe(1)
    expect(t.host.request({ requestId: 'late', behavior: 'curious', leaseMs: 1000 })).toBe('disposed')
    t.frame(next)
    expect(t.adapters).toHaveLength(2)
  })
})
