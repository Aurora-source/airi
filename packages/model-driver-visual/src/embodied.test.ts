import type { VRMHumanBoneName, VRMHumanBones } from '@pixiv/three-vrm'

import { VRM, VRMExpression, VRMExpressionManager, VRMHumanoid, VRMRequiredHumanBoneName } from '@pixiv/three-vrm'
import { Group, Object3D, Quaternion } from 'three'
import { describe, expect, it } from 'vitest'

import { visualBehaviorCatalog } from './catalog'
import { createVisualBehaviorController } from './controller'
import { createVrmVisualAdapter } from './vrm'

const bodyBones: VRMHumanBoneName[] = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand']

function fixture(omitted: VRMHumanBoneName[] = []) {
  const scene = new Group()
  const names = new Set<VRMHumanBoneName>([...Object.values(VRMRequiredHumanBoneName), ...bodyBones])
  const humanBones = Object.fromEntries([...names].filter(name => !omitted.includes(name)).map((name) => {
    const node = new Object3D()
    node.position.set(name.startsWith('left') ? 0.3 : name.startsWith('right') ? -0.3 : 0, name === 'head' ? 1.6 : 1, 0)
    scene.add(node)
    return [name, { node }]
  })) as VRMHumanBones
  const expressionManager = new VRMExpressionManager()
  for (const name of ['happy', 'sad', 'relaxed', 'angry', 'surprised', 'blink', 'aa'])
    expressionManager.registerExpression(new VRMExpression(name))
  const vrm = new VRM({ scene, humanoid: new VRMHumanoid(humanBones), expressionManager, meta: { metaVersion: '0' } })
  const adapter = createVrmVisualAdapter(vrm, { modelId: 'test' })
  let time = 0
  const controller = createVisualBehaviorController({ adapter, now: () => time, random: () => 0.37 })
  const bone = (name: VRMHumanBoneName) => vrm.humanoid.getNormalizedBoneNode(name)!
  const angle = (name: VRMHumanBoneName) => bone(name).quaternion.angleTo(new Quaternion())
  const update = (next: number) => {
    time = next
    controller.update()
  }
  return { vrm, adapter, controller, bone, angle, update }
}

describe('embodied visual vocabulary', () => {
  it('moves the torso, shoulders, arms, elbows, and wrists during happy', () => {
    const f = fixture()
    expect(f.controller.playVisualBehavior('happy')).toBe('started')
    f.update(900)
    for (const name of ['spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand'] as const)
      expect(f.angle(name), name).toBeGreaterThan(0.01)
    expect(f.vrm.expressionManager?.getValue('aa')).toBe(0)
    expect(f.vrm.expressionManager?.getValue('blink')).toBe(0)
  })

  it('starts surprise quickly and lets wrists follow the torso', () => {
    const f = fixture()
    f.controller.playVisualBehavior('surprised')
    f.update(90)
    expect(f.angle('chest')).toBeGreaterThan(0.025)
    expect(f.angle('leftHand')).toBeLessThan(0.005)
    f.update(260)
    expect(f.angle('leftHand')).toBeGreaterThan(0.025)
    const peak = f.angle('chest')
    f.update(1100)
    expect(f.angle('chest')).toBeLessThan(peak)
  })

  it('uses visible asymmetric arm motion for thinking', () => {
    const f = fixture()
    f.controller.playVisualBehavior('thinking')
    f.update(1800)
    expect(f.angle('leftLowerArm')).toBeGreaterThan(0.18)
    expect(f.angle('leftLowerArm')).toBeGreaterThan(f.angle('rightLowerArm') * 2)
    expect(f.angle('chest')).toBeGreaterThan(0.02)
  })

  it.each(['speaking', 'act', 'modelMotion', 'userControl'] as const)('immediately releases every body bone for %s', (owner) => {
    const f = fixture()
    f.controller.playVisualBehavior('stretch')
    f.update(3500)
    expect(f.angle('leftUpperArm')).toBeGreaterThan(0.1)
    f.controller.setExternalActivity({ speaking: false, act: false, modelMotion: false, userControl: false, [owner]: true })
    for (const name of bodyBones)
      expect(f.angle(name), name).toBeLessThan(0.000001)
    expect(f.controller.playVisualBehavior('happy')).toBe('blocked')
    f.update(5000)
    for (const name of bodyBones)
      expect(f.angle(name), name).toBeLessThan(0.000001)
  })

  it.each(['cancelBehavior', 'returnToNeutral'] as const)('restores all affected bones after %s', (action) => {
    const f = fixture()
    f.controller.playVisualBehavior('thinking')
    f.update(1900)
    f.controller[action]()
    f.update(2400)
    for (const name of bodyBones)
      expect(f.angle(name), name).toBeLessThan(0.000001)
  })

  it('keeps all 30 behaviors bounded and restores them at the end', () => {
    const f = fixture()
    let start = 0
    for (const behavior of visualBehaviorCatalog) {
      f.update(start)
      expect(f.controller.playVisualBehavior(behavior.id), behavior.id).toBe('started')
      let bodyMotion = 0
      for (let sample = 1; sample < 30; sample++) {
        f.update(start + behavior.durationMs * sample / 30)
        for (const name of bodyBones) {
          const angle = f.angle(name)
          expect(Number.isFinite(angle), `${behavior.id}/${name}`).toBe(true)
          expect(angle, `${behavior.id}/${name}`).toBeLessThan(0.85)
          if (name !== 'head' && name !== 'neck')
            bodyMotion = Math.max(bodyMotion, angle)
        }
      }
      expect(bodyMotion, behavior.id).toBeGreaterThan(0.001)
      f.update(start + behavior.durationMs + 1)
      for (const name of bodyBones)
        expect(f.angle(name), `${behavior.id}/${name}`).toBeLessThan(0.000001)
      start += 400000
    }
  })

  it('preserves a newer mixer pose and releases only its additive offset', () => {
    const f = fixture()
    f.controller.playVisualBehavior('happy')
    f.update(800)
    f.bone('leftUpperArm').rotation.z = -0.9
    const authored = f.bone('leftUpperArm').quaternion.clone()
    f.update(950)
    expect(f.bone('leftUpperArm').quaternion.angleTo(authored)).toBeGreaterThan(0.02)
    f.controller.stop()
    expect(f.bone('leftUpperArm').quaternion.angleTo(authored)).toBeLessThan(0.000001)
  })

  it('degrades safely when optional shoulders and hand bones are unavailable', () => {
    const f = fixture(['leftShoulder', 'rightShoulder', 'chest', 'upperChest', 'neck'])
    f.controller.playVisualBehavior('surprised')
    f.update(500)
    expect(f.angle('spine')).toBeGreaterThan(0.02)
    f.controller.dispose()
    expect(f.angle('spine')).toBeLessThan(0.000001)
  })

  it('leaves authored elbows untouched when body gestures are disabled', () => {
    const f = fixture()
    f.bone('rightLowerArm').rotation.y = 2.2
    f.bone('leftLowerArm').rotation.y = 0.2
    const left = f.bone('leftLowerArm').quaternion.clone()
    const right = f.bone('rightLowerArm').quaternion.clone()
    f.controller.setMotionTuning({ bodyGestures: false })
    f.controller.playVisualBehavior('happy')
    f.update(900)
    expect(f.bone('leftLowerArm').quaternion.angleTo(left)).toBeLessThan(0.000001)
    expect(f.bone('rightLowerArm').quaternion.angleTo(right)).toBeLessThan(0.000001)
  })

  it('rejects invalid direct frame angles and expression weights', () => {
    const f = fixture()
    f.adapter.apply({ headPitch: Number.NaN, headYaw: Infinity, headRoll: 0, bodyPitch: 0, bodyRoll: 0, gazeX: 0, gazeY: 0, breath: 0, expression: 'happy', expressionWeight: Number.NaN })
    expect(f.angle('head')).toBe(0)
    expect(f.vrm.expressionManager?.getValue('happy')).toBe(0)
  })

  it('scales body, arm, and hand amplitudes independently within safe limits', () => {
    const normal = fixture()
    const tuned = fixture()
    tuned.controller.setMotionTuning({ bodyAmplitude: 0.5, armAmplitude: 0, handAmplitude: 1.5 })
    normal.controller.playVisualBehavior('happy')
    tuned.controller.playVisualBehavior('happy')
    normal.update(900)
    tuned.update(900)
    expect(tuned.angle('chest')).toBeCloseTo(normal.angle('chest') * 0.5)
    expect(tuned.angle('leftUpperArm')).toBe(0)
    expect(tuned.angle('leftHand')).toBeGreaterThan(normal.angle('leftHand'))
    expect(tuned.angle('leftHand')).toBeLessThan(0.3)
  })

  it('keeps the speed chosen at admission throughout a behavior', () => {
    const f = fixture()
    f.controller.setMotionTuning({ transitionSpeed: 2 })
    f.controller.playVisualBehavior('surprised')
    f.controller.setMotionTuning({ transitionSpeed: 0.5 })
    f.update(450)
    expect(f.angle('chest')).toBeGreaterThan(0.025)
    f.update(901)
    expect(f.angle('chest')).toBe(0)
  })

  it('repeats seeded asymmetry without changing it between frames', () => {
    const a = fixture()
    const b = fixture()
    a.controller.playVisualBehavior('happy')
    b.controller.playVisualBehavior('happy')
    for (const time of [400, 800, 1400]) {
      a.update(time)
      b.update(time)
      for (const name of bodyBones)
        expect(a.bone(name).quaternion.toArray()).toEqual(b.bone(name).quaternion.toArray())
    }
    expect(a.angle('leftUpperArm')).not.toBeCloseTo(a.angle('rightUpperArm'))
  })

  it('replaces gestures continuously and clears the old pose on model switching', () => {
    const f = fixture()
    f.controller.playVisualBehavior('thinking')
    f.update(1600)
    const before = f.bone('leftLowerArm').quaternion.clone()
    f.controller.playVisualBehavior('happy')
    f.update(1600)
    expect(f.bone('leftLowerArm').quaternion.angleTo(before)).toBeLessThan(0.000001)
    f.update(1900)
    expect(f.bone('leftLowerArm').quaternion.angleTo(before)).toBeGreaterThan(0.02)
    const next = fixture()
    f.controller.attach(next.adapter)
    for (const name of bodyBones)
      expect(f.angle(name), name).toBeLessThan(0.000001)
    expect(f.controller.snapshot().behavior).toBeUndefined()
    expect(f.controller.playVisualBehavior('happy')).toBe('started')
  })

  it('continues on a rig without hands or arm bones', () => {
    const f = fixture(['leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand'])
    expect(f.controller.playVisualBehavior('thinking')).toBe('started')
    f.update(1800)
    expect(f.angle('chest')).toBeGreaterThan(0.02)
    f.controller.stop()
    expect(f.angle('chest')).toBe(0)
  })

  it('obeys body gestures OFF while recovering from cancellation', () => {
    const f = fixture()
    f.controller.playVisualBehavior('happy')
    f.update(900)
    f.controller.cancelBehavior()
    f.controller.setMotionTuning({ bodyGestures: false, armAmplitude: 0 })
    f.update(1000)
    for (const name of bodyBones.filter(name => name !== 'head'))
      expect(f.angle(name), name).toBeLessThan(0.000001)
  })
})
