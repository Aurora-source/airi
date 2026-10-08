import type { VisualRequestResult } from '../src/contracts'
import type { createVisualBehaviorController } from '../src/controller'

export interface VisualGalleryProbe {
  snapshot: () => ReturnType<ReturnType<typeof createVisualBehaviorController>['snapshot']> & { loaded: string, frameCount: number, cpuMs: number, models: number }
  play: (id: string) => VisualRequestResult
  expressionValue: (name: string) => number | null
  detach: () => void
}

declare global {
  interface Window { __airiVisualDemo?: VisualGalleryProbe }
}
