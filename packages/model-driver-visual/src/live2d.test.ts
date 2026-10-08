import type { VisualFrame } from './contracts'

import { describe, expect, it, vi } from 'vitest'

import { createLive2DVisualAdapter } from './live2d'

const frame: VisualFrame = { headPitch: 0, headYaw: 0.1, headRoll: 0, bodyPitch: 0, bodyRoll: 0, gazeX: 0, gazeY: 0, breath: 0, expressionWeight: 0 }

function fixture() {
  let value = 3
  const core = { getParameterValueByIndex: () => value, setParameterValueByIndex: vi.fn((_index: number, next: number) => {
    value = next
  }) }
  const adapter = createLive2DVisualAdapter({ modelId: 'cubism', core, parameters: [{ id: 'custom-head', index: 4, min: -5, max: 5 }], axes: { headYaw: { parameterId: 'custom-head', unitsPerValue: 30 }, headPitch: { parameterId: 'missing', unitsPerValue: 1 } }, nativeMicro: new Set(['blink', 'breath', 'gaze']) })
  return { core, adapter }
}

describe('live2D visual bindings', () => {
  it('retains ownership through Cubism Float32 parameter storage without drift', () => {
    const values = new Float32Array([3])
    const adapter = createLive2DVisualAdapter({ modelId: 'float32', core: { getParameterValueByIndex: index => values[index], setParameterValueByIndex: (index, value) => {
      values[index] = value
    } }, parameters: [{ id: 'head', index: 0, min: -30, max: 30 }], axes: { headYaw: { parameterId: 'head', unitsPerValue: 180 / Math.PI } }, nativeMicro: new Set() })
    const pose = { ...frame, headYaw: 0.07 }
    adapter.apply(pose)
    const first = values[0]
    for (let i = 0; i < 10000; i++) adapter.apply(pose)
    expect(values[0]).toBe(first)
    adapter.release()
    expect(values[0]).toBe(3)
  })
  it('discovers only configured real parameters and clamps model ranges', () => {
    const f = fixture()
    expect(f.adapter.capabilities.axes.has('headPitch')).toBe(false)
    f.adapter.apply(frame)
    expect(f.core.getParameterValueByIndex()).toBe(5)
    f.adapter.apply(frame)
    expect(f.core.getParameterValueByIndex()).toBe(5)
    f.adapter.release()
    expect(f.core.getParameterValueByIndex()).toBe(3)
  })

  it('preserves a changed manual value on release', () => {
    const f = fixture()
    f.adapter.apply(frame)
    f.core.setParameterValueByIndex(4, -2)
    f.adapter.release()
    expect(f.core.getParameterValueByIndex()).toBe(-2)
  })

  it('never accesses disposed models or installs timers', () => {
    const f = fixture()
    f.adapter.apply(frame)
    f.adapter.dispose()
    f.core.setParameterValueByIndex.mockClear()
    f.adapter.apply(frame)
    f.adapter.release()
    f.adapter.dispose()
    expect(f.core.setParameterValueByIndex).not.toHaveBeenCalled()
  })

  it('falls back for absent expression bindings and an empty model', () => {
    const f = fixture()
    f.adapter.apply({ ...frame, expression: 'happy', expressionWeight: 0.3 })
    expect(f.adapter.capabilities.expressions.size).toBe(0)
    const neutral = createLive2DVisualAdapter({ modelId: 'empty', core: f.core, parameters: [], axes: {}, nativeMicro: new Set() })
    expect(neutral.capabilities.axes.size).toBe(0)
    expect(() => neutral.apply(frame)).not.toThrow()
  })
})
