import type { VRMCore } from '@pixiv/three-vrm-core'

import { describe, expect, it, vi } from 'vitest'
import { nextTick, shallowRef } from 'vue'

import { useVRMLipSync } from './lip-sync'

/** The wLipSync node keeps its last frame, like the real worklet after its input stops. */
const node = { volume: 0, weights: {} as Record<string, number>, disconnect: vi.fn() }

vi.mock('@proj-airi/model-driver-lipsync/runtime/wlipsync', () => ({
  createWLipSyncNode: vi.fn(async () => node),
}))

function createSource() {
  const source = new EventTarget() as EventTarget & { connect: () => void, disconnect: () => void }
  source.connect = vi.fn()
  source.disconnect = vi.fn()
  return source as unknown as AudioBufferSourceNode
}

function createVrm() {
  const values = new Map<string, number>()
  const vrm = { expressionManager: { setValue: (name: string, value: number) => values.set(name, value) } } as unknown as VRMCore
  return { vrm, values }
}

describe('useVRMLipSync', () => {
  it('closes the mouth and reports silence after the audio source ends', async () => {
    const source = shallowRef<AudioBufferSourceNode>()
    const lipSync = useVRMLipSync(shallowRef({} as AudioContext), source)
    await new Promise(resolve => setTimeout(resolve, 0))
    source.value = createSource()
    await nextTick()

    node.volume = 0.9
    node.weights = { A: 0.9 }
    const { vrm, values } = createVrm()
    for (let frame = 0; frame < 10; frame++)
      lipSync.update(vrm, 0.05)
    expect(lipSync.isLipSyncActive.value).toBe(true)
    expect(values.get('aa')).toBeGreaterThan(0.1)

    // The worklet posts nothing more, so its last loud frame stays on the node.
    source.value.dispatchEvent(new Event('ended'))
    for (let frame = 0; frame < 30; frame++)
      lipSync.update(vrm, 0.05)
    expect(lipSync.isLipSyncActive.value).toBe(false)
    expect(values.get('aa')).toBe(0)
  })

  it('follows the next source again after an ended one', async () => {
    const source = shallowRef<AudioBufferSourceNode>()
    const lipSync = useVRMLipSync(shallowRef({} as AudioContext), source)
    await new Promise(resolve => setTimeout(resolve, 0))
    const first = createSource()
    source.value = first
    await nextTick()
    first.dispatchEvent(new Event('ended'))
    source.value = createSource()
    await nextTick()

    node.volume = 0.9
    node.weights = { O: 0.8 }
    const { vrm, values } = createVrm()
    for (let frame = 0; frame < 10; frame++)
      lipSync.update(vrm, 0.05)
    expect(lipSync.isLipSyncActive.value).toBe(true)
    expect(values.get('oh')).toBeGreaterThan(0.1)
  })
})
