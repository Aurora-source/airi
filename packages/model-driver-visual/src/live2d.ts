import type { Cubism4InternalModel } from 'pixi-live2d-display/cubism4'

import type { VisualAxis, VisualExpression, VisualModelAdapter, VisualMotion } from './contracts'

type CubismParameters = Pick<Cubism4InternalModel['coreModel'], 'getParameterValueByIndex' | 'setParameterValueByIndex'>
export interface Live2DVisualParameter {
  id: string
  index: number
  min: number
  max: number
}
export interface Live2DVisualBindings {
  modelId: string
  core: CubismParameters
  parameters: readonly Live2DVisualParameter[]
  /** Semantic bindings come from model configuration. No parameter names are guessed. */
  axes: Partial<Record<VisualAxis, {
    parameterId: string
    unitsPerValue: number
  }>>
  expressions?: {
    names: readonly string[]
    bindings: Partial<Record<VisualExpression, string>>
    get: (name: string) => number
    set: (name: string, value: number) => void
  }
  nativeMicro: ReadonlySet<'blink' | 'gaze' | 'breath' | 'pose'>
  motions?: readonly VisualMotion[]
  playMotion?: VisualModelAdapter['playMotion']
}
/** Read the real Cubism parameter table once per model. Synthetic getParameterIndex entries are never accepted. */
export function discoverLive2DVisualParameters(core: Cubism4InternalModel['coreModel']): Live2DVisualParameter[] {
  return Array.from(core.getModel().parameters.ids, (id, index) => ({
    id,
    index,
    min: core.getParameterMinimumValue(index),
    max: core.getParameterMaximumValue(index),
  }))
}
/**
 * Bind this adapter to AIRI's motion-manager post/final pass after its base pose.
 * The existing expression controller remains the writer through the supplied expression binding.
 * Leave native blink, breathing and eye focus under their existing owners.
 */
export function createLive2DVisualAdapter(bindings: Live2DVisualBindings): VisualModelAdapter {
  const parameters = Object.entries(bindings.axes).flatMap(([axis, binding]) => {
    const parameter = bindings.parameters.find(p => p.id === binding.parameterId)
    if (!parameter || !Number.isFinite(binding.unitsPerValue) || parameter.min >= parameter.max)
      return []
    return [{ axis: axis as VisualAxis, binding, parameter, base: 0, written: 0, owned: false }]
  })
  const expressions = new Set<VisualExpression>()
  for (const [semantic, name] of Object.entries(bindings.expressions?.bindings ?? {})) {
    if (bindings.expressions?.names.includes(name))
      expressions.add(semantic as VisualExpression)
  }
  const expressionValues = new Map<string, {
    base: number
    written: number
  }>()
  let disposed = false
  function releaseExpressions() {
    for (const [name, value] of expressionValues) {
      if (bindings.expressions?.get(name) === value.written)
        bindings.expressions.set(name, value.base)
    }
    expressionValues.clear()
  }
  function release() {
    if (disposed)
      return
    for (const p of parameters) {
      if (p.owned && bindings.core.getParameterValueByIndex(p.parameter.index) === p.written)
        bindings.core.setParameterValueByIndex(p.parameter.index, p.base)
      p.owned = false
    }
    releaseExpressions()
  }
  return {
    capabilities: { modelId: bindings.modelId, axes: new Set(parameters.map(p => p.axis)), expressions, nativeMicro: bindings.nativeMicro, motions: bindings.motions ?? [] },
    playMotion: bindings.playMotion,
    apply(frame) {
      if (disposed)
        return
      for (const p of parameters) {
        const current = bindings.core.getParameterValueByIndex(p.parameter.index)
        p.base = p.owned && current === p.written ? p.base : current
        p.written = Math.min(p.parameter.max, Math.max(p.parameter.min, p.base + frame[p.axis] * p.binding.unitsPerValue))
        bindings.core.setParameterValueByIndex(p.parameter.index, p.written)
        // Cubism stores Float32 values. Ownership follows the stored value, not the unrounded calculation.
        p.written = bindings.core.getParameterValueByIndex(p.parameter.index)
        p.owned = true
      }
      const name = frame.expression ? bindings.expressions?.bindings[frame.expression] : undefined
      if (!name || !frame.expression || !expressions.has(frame.expression)) {
        releaseExpressions()
        return
      }
      if (!expressionValues.has(name)) {
        releaseExpressions()
        expressionValues.set(name, { base: bindings.expressions?.get(name) ?? 0, written: 0 })
      }
      const value = expressionValues.get(name)!
      value.written = Math.max(0, Math.min(0.45, frame.expressionWeight))
      bindings.expressions?.set(name, value.written)
      value.written = bindings.expressions?.get(name) ?? value.written
    },
    release,
    dispose() {
      if (!disposed) {
        release()
        parameters.length = 0
        disposed = true
      }
    },
  }
}
