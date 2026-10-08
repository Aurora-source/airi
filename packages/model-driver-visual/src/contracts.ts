export type IdleIntensity = 'still' | 'calm' | 'normal' | 'lively'
export type VisualActivity = 'idle' | 'listening' | 'thinking' | 'waiting' | 'watching'
export type VisualCategory = 'micro' | 'short' | 'long' | 'listening' | 'waiting' | 'positive' | 'concerned' | 'surprise' | 'watching'
export type VisualAxis = 'headPitch' | 'headYaw' | 'headRoll' | 'bodyPitch' | 'bodyRoll' | 'gazeX' | 'gazeY' | 'breath'
export type VisualExpression = 'happy' | 'relaxed' | 'sad' | 'surprised' | 'sleepy'

export interface VisualBehavior {
  id: string
  category: VisualCategory
  durationMs: number
  cooldownMs: number
  weight: number
  pose?: Partial<Record<VisualAxis, number>>
  expression?: VisualExpression
  expressionWeight?: number
  motionRole?: string
  oscillations?: number
  idle?: boolean
}

export interface VisualCapabilities {
  readonly modelId: string
  readonly axes: ReadonlySet<VisualAxis>
  readonly expressions: ReadonlySet<VisualExpression>
  readonly motions: readonly VisualMotion[]
  readonly nativeMicro: ReadonlySet<'blink' | 'gaze' | 'breath' | 'pose'>
}

export interface VisualMotion {
  readonly id: string
  readonly role?: string
  readonly durationMs: number
}

/** This handle owns only its motion. stop() must never stop another owner's animation. */
export interface VisualMotionHandle { stop: () => void }

/** Frame values are reused. Adapters must not retain or mutate this object. Pose angles are radians. */
export interface VisualFrame extends Record<VisualAxis, number> {
  expression?: VisualExpression
  expressionWeight: number
}

/** Bind one model at a time. The host must release this adapter before it disposes the model. */
export interface VisualModelAdapter {
  readonly capabilities: VisualCapabilities
  apply: (frame: Readonly<VisualFrame>) => void
  release: () => void
  playMotion?: (motion: VisualMotion, priority: 'idle' | 'explicit') => VisualMotionHandle | undefined
  dispose: () => void
}

/** The host supplies current owner flags before its ACT, mouth, tracking or manual-control writes. */
export interface ExternalVisualActivity {
  speaking: boolean
  act: boolean
  modelMotion: boolean
  userControl: boolean
}

export type VisualRequestResult = 'started' | 'blocked' | 'cooldown' | 'unsupported' | 'unknown' | 'disposed'

/** R6 and R7 supply visual requests. This port contains no story, mood, attention or speech decisions. */
export interface VisualBehaviorPort {
  playVisualBehavior: (id: string) => VisualRequestResult
  setIdleIntensity: (intensity: IdleIntensity) => void
  setVisualActivity: (activity: VisualActivity) => void
  setExternalActivity: (activity: Readonly<ExternalVisualActivity>) => void
  cancelBehavior: () => void
  returnToNeutral: () => void
}
