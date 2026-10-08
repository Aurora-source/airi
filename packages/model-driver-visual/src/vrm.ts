import type { VRM } from '@pixiv/three-vrm'
import type { Object3D } from 'three'

import type { VisualAxis, VisualExpression, VisualFrame, VisualModelAdapter, VisualMotion } from './contracts'

import { Euler, Quaternion } from 'three'

export interface VrmVisualOptions {
  modelId: string
  /** Upstream blink, gaze and idle animation own micro motion by default. */
  nativeMicro?: ReadonlySet<'blink' | 'gaze' | 'breath' | 'pose'>
  expressions?: Partial<Record<VisualExpression, string>>
  motions?: readonly VisualMotion[]
  playMotion?: VisualModelAdapter['playMotion']
  /** AIRI's expression frame hook flushes these values after its ACT and blink controllers. */
  deferExpressions?: boolean
}
const presetExpressions: readonly VisualExpression[] = ['happy', 'relaxed', 'sad', 'surprised']
/** The three-vrm loader converts VRM0 presets into VRM1 names. Custom expression semantics require explicit bindings. */
export function discoverVrmVisualCapabilities(vrm: VRM, options: VrmVisualOptions) {
  const head = vrm.humanoid?.getNormalizedBoneNode('head') ?? vrm.humanoid?.getNormalizedBoneNode('neck')
  const body = vrm.humanoid?.getNormalizedBoneNode('spine') ?? vrm.humanoid?.getNormalizedBoneNode('chest')
  const axes = new Set<VisualAxis>()
  if (head) {
    axes.add('headPitch')
    axes.add('headYaw')
    axes.add('headRoll')
  }
  if (body) {
    axes.add('bodyPitch')
    axes.add('bodyRoll')
  }
  const expressions = new Set<VisualExpression>()
  for (const semantic of [...presetExpressions, 'sleepy'] as const) {
    const name = options.expressions?.[semantic] ?? semantic
    if (vrm.expressionManager?.getExpression(name))
      expressions.add(semantic)
  }
  return {
    modelId: options.modelId,
    axes,
    expressions,
    motions: options.motions ?? [],
    nativeMicro: options.nativeMicro ?? new Set<'blink' | 'gaze' | 'pose'>(['blink', 'gaze', 'pose']),
  }
}
/**
 * Apply after upstream animation sampling and before humanoid/expression updates.
 * The host must block this layer for ACT, lip sync, explicit motion and manual control.
 * Additive offsets never change scale, positions, eyes, mouth or spring bones.
 */
export function createVrmVisualAdapter(vrm: VRM, options: VrmVisualOptions) {
  const capabilities = discoverVrmVisualCapabilities(vrm, options)
  const bones: {
    node: Object3D
    head: boolean
    base: Quaternion
    written: Quaternion
    owned: boolean
  }[] = []
  const head = vrm.humanoid?.getNormalizedBoneNode('head') ?? vrm.humanoid?.getNormalizedBoneNode('neck')
  const body = vrm.humanoid?.getNormalizedBoneNode('spine') ?? vrm.humanoid?.getNormalizedBoneNode('chest')
  if (head)
    bones.push({ node: head, head: true, base: new Quaternion(), written: new Quaternion(), owned: false })
  if (body && body !== head)
    bones.push({ node: body, head: false, base: new Quaternion(), written: new Quaternion(), owned: false })
  const rotation = new Euler(0, 0, 0, 'YXZ')
  const offset = new Quaternion()
  const expressionValues = new Map<string, {
    base: number
    written: number
  }>()
  let disposed = false
  let pendingExpression: VisualExpression | undefined
  let pendingExpressionWeight = 0
  function releaseExpressions() {
    for (const [name, value] of expressionValues) {
      // A changed value belongs to another owner. Never restore over it.
      if (vrm.expressionManager?.getValue(name) === value.written)
        vrm.expressionManager.setValue(name, value.base)
    }
    expressionValues.clear()
  }
  function release() {
    if (disposed)
      return
    for (const bone of bones) {
      if (bone.owned && bone.node.quaternion.equals(bone.written))
        bone.node.quaternion.copy(bone.base)
      bone.owned = false
    }
    releaseExpressions()
    pendingExpression = undefined
    pendingExpressionWeight = 0
  }
  function flushExpressions() {
    if (disposed)
      return
    if (!pendingExpression || !capabilities.expressions.has(pendingExpression)) {
      releaseExpressions()
      return
    }
    const name = options.expressions?.[pendingExpression] ?? pendingExpression
    if (!expressionValues.has(name)) {
      releaseExpressions()
      expressionValues.set(name, { base: vrm.expressionManager?.getValue(name) ?? 0, written: 0 })
    }
    const value = expressionValues.get(name)!
    value.written = Math.max(0, Math.min(0.45, pendingExpressionWeight))
    vrm.expressionManager?.setValue(name, value.written)
  }
  return {
    capabilities,
    playMotion: options.playMotion,
    apply(frame: Readonly<VisualFrame>) {
      if (disposed)
        return
      for (const bone of bones) {
        // The mixer can write a new base between frames. Undo only a still-owned offset.
        if (bone.owned && bone.node.quaternion.equals(bone.written))
          bone.node.quaternion.copy(bone.base)
        bone.base.copy(bone.node.quaternion)
        rotation.set(bone.head ? frame.headPitch : frame.bodyPitch, bone.head ? frame.headYaw : 0, bone.head ? frame.headRoll : frame.bodyRoll, 'YXZ')
        offset.setFromEuler(rotation)
        bone.node.quaternion.multiply(offset)
        bone.written.copy(bone.node.quaternion)
        bone.owned = true
      }
      pendingExpression = frame.expression
      pendingExpressionWeight = frame.expressionWeight
      if (!options.deferExpressions)
        flushExpressions()
    },
    release,
    flushExpressions,
    dispose() {
      if (!disposed) {
        release()
        bones.length = 0
        disposed = true
      }
    },
  }
}
