import type { VRM } from '@pixiv/three-vrm'

/** Reused each frame. Read it during the callback. Do not retain it or change its fields. */
export interface VrmFrameRuntimeContext {
  /** Source of the committed model, including while a replacement is loading. */
  readonly modelSrc: string
  readonly actActive: boolean
  readonly lipSyncActive: boolean
}

/** Pose hooks run before humanoid update. Expression hooks run after ACT and mouth sampling, before expression update. */
export type VrmFrameRuntimeHook = (vrm: VRM, delta: number, context: VrmFrameRuntimeContext) => void
