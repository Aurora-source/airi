import type { VRMHumanBones } from '@pixiv/three-vrm'

import type { VisualFrame } from './contracts'

import { VRM, VRMExpression, VRMExpressionManager, VRMHumanoid, VRMRequiredHumanBoneName } from '@pixiv/three-vrm'
import { Group, Object3D, Quaternion } from 'three'
import { describe, expect, it } from 'vitest'

import { createVrmVisualAdapter } from './vrm'

function model(version: '0' | '1' = '0') {
  const scene = new Group()
  const humanBones = Object.fromEntries(Object.values(VRMRequiredHumanBoneName).map((name) => {
    const node = new Object3D()
    node.position.y = name === 'head' ? 1.5 : 1
    scene.add(node)
    return [name, { node }]
  })) as VRMHumanBones
  const expressionManager = new VRMExpressionManager()
  expressionManager.registerExpression(new VRMExpression('happy'))
  expressionManager.registerExpression(new VRMExpression('sad'))
  return new VRM({ scene, humanoid: new VRMHumanoid(humanBones), expressionManager, meta: version === '0' ? { metaVersion: '0' } : { metaVersion: '1', name: 'test', authors: ['test'], licenseUrl: 'https://vrm.dev/licenses/1.0/' } })
}

const frame: VisualFrame = { headPitch: 0.04, headYaw: 0.03, headRoll: 0.02, bodyPitch: 0.01, bodyRoll: 0.005, gazeX: 0, gazeY: 0, breath: 0, expression: 'happy', expressionWeight: 0.3 }

describe('vRM visual adapter ownership', () => {
  it('retargets canonical pose offsets consistently between VRM0 and VRM1', () => {
    const zero = model('0')
    const one = model('1')
    createVrmVisualAdapter(zero, { modelId: 'zero' }).apply(frame)
    createVrmVisualAdapter(one, { modelId: 'one' }).apply(frame)
    const canonical = one.humanoid.getNormalizedBoneNode('head')!.quaternion
    const retargeted = new Quaternion(-canonical.x, canonical.y, -canonical.z, canonical.w)
    expect(zero.humanoid.getNormalizedBoneNode('head')!.quaternion.angleTo(retargeted)).toBeLessThan(0.000001)
  })
  it.each(['0', '1'] as const)('uses normalized semantics for VRM%s without changing mouth or scale', (version) => {
    const vrm = model(version)
    const adapter = createVrmVisualAdapter(vrm, { modelId: version })
    const head = vrm.humanoid.getNormalizedBoneNode('head')!
    adapter.apply(frame)
    expect(head.quaternion.equals(new Quaternion())).toBe(false)
    expect(head.scale.toArray()).toEqual([1, 1, 1])
    expect(vrm.expressionManager?.getValue('happy')).toBeCloseTo(0.3)
    expect(adapter.capabilities.expressions.has('surprised')).toBe(false)
  })

  it('does not accumulate additive rotations over repeated frames', () => {
    const vrm = model()
    const adapter = createVrmVisualAdapter(vrm, { modelId: 'a' })
    const head = vrm.humanoid.getNormalizedBoneNode('head')!
    adapter.apply(frame)
    const first = head.quaternion.clone()
    for (let i = 0; i < 10000; i++) adapter.apply(frame)
    expect(head.quaternion.angleTo(first)).toBeLessThan(0.000001)
    adapter.release()
    expect(head.quaternion.angleTo(new Quaternion())).toBeLessThan(0.000001)
    expect(vrm.expressionManager?.getValue('happy')).toBe(0)
  })

  it('preserves a newer animation/manual write during release', () => {
    const vrm = model()
    const adapter = createVrmVisualAdapter(vrm, { modelId: 'a' })
    const head = vrm.humanoid.getNormalizedBoneNode('head')!
    adapter.apply(frame)
    head.rotation.y = -0.2
    const manual = head.quaternion.clone()
    vrm.expressionManager?.setValue('happy', 0.8)
    adapter.release()
    expect(head.quaternion.equals(manual)).toBe(true)
    expect(vrm.expressionManager?.getValue('happy')).toBe(0.8)
  })

  it('flushes expressions in the owning renderer phase and releases on disposal', () => {
    const vrm = model()
    const adapter = createVrmVisualAdapter(vrm, { modelId: 'a', deferExpressions: true })
    adapter.apply(frame)
    expect(vrm.expressionManager?.getValue('happy')).toBe(0)
    adapter.flushExpressions()
    expect(vrm.expressionManager?.getValue('happy')).toBe(0.3)
    adapter.dispose()
    const head = vrm.humanoid.getNormalizedBoneNode('head')!
    const neutral = head.quaternion.clone()
    adapter.apply(frame)
    adapter.flushExpressions()
    expect(head.quaternion.equals(neutral)).toBe(true)
    expect(vrm.expressionManager?.getValue('happy')).toBe(0)
  })
})
