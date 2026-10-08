import type { MotionTuning, VisualRequestResult } from '../src/contracts'
import type { createVisualBehaviorController } from '../src/controller'

export interface VisualGalleryProbe {
  snapshot: () => ReturnType<ReturnType<typeof createVisualBehaviorController>['snapshot']> & { loaded: string, frameCount: number, cpuMs: number, models: number }
  play: (id: string) => VisualRequestResult
  expressionValue: (name: string) => number | null
  stop: () => void
  tune: (value: Partial<MotionTuning>) => void
  bones: () => Record<string, { quaternion: number[], position: number[] }>
  behaviors: readonly { id: string, durationMs: number }[]
  review: (id: string, progress: number) => VisualRequestResult
  detach: () => void
}

declare global {
  interface Window { __airiVisualDemo?: VisualGalleryProbe }
}
