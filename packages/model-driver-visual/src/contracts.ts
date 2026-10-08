export type IdleIntensity = 'still' | 'calm' | 'normal' | 'lively'
export type VisualActivity = 'idle' | 'listening' | 'thinking' | 'waiting' | 'watching'
export type VisualCategory = 'micro' | 'short' | 'long' | 'listening' | 'waiting' | 'positive' | 'concerned' | 'surprise' | 'watching'
export type NativeVisualAxis = 'headPitch' | 'headYaw' | 'headRoll' | 'bodyPitch' | 'bodyRoll' | 'gazeX' | 'gazeY' | 'breath'
export type BodyRegion = 'hips' | 'chest' | 'upperChest' | 'neck' | 'leftShoulder' | 'rightShoulder' | 'leftUpperArm' | 'rightUpperArm' | 'leftLowerArm' | 'rightLowerArm' | 'leftHand' | 'rightHand'
export type BodyAxis = 'bodyYaw' | `${BodyRegion}${'Pitch' | 'Yaw' | 'Roll'}`
export type VisualAxis = NativeVisualAxis | BodyAxis
export type VisualExpression = 'happy' | 'relaxed' | 'sad' | 'angry' | 'surprised' | 'sleepy'
export type GestureName = 'chest-open' | 'chest-collapse' | 'shoulder-lift' | 'shoulder-drop' | 'open-arms-small' | 'hands-inward' | 'lean-forward' | 'lean-back' | 'lean-side' | 'recoil' | 'small-shrug' | 'thoughtful-hand' | 'attentive-posture' | 'excited-lift' | 'relaxed-drop' | 'concerned-fold' | 'subtle-hand-fidget' | 'asymmetric-arm-shift' | 'torso-turn' | 'stretch-open'
export type MotionShape = 'soft' | 'quick' | 'reaction' | 'nod' | 'drift' | 'scan' | 'fidget' | 'stretch' | 'settle'

/** Catalog gestures are additive. Negative strength reverses a directional primitive. */
export interface VisualGesture {
  name: GestureName
  strength?: number
  shape?: MotionShape
  delayMs?: number
}

/** Host configuration changes motion size and speed without exposing bone details to behavior callers. */
export interface MotionTuning {
  bodyAmplitude: number
  armAmplitude: number
  handAmplitude: number
  transitionSpeed: number
  bodyGestures: boolean
}

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
  gestures?: readonly VisualGesture[]
  shape?: MotionShape
  lead?: 'head' | 'torso'
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
export interface VisualFrame extends Record<NativeVisualAxis, number>, Partial<Record<BodyAxis, number>> {
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
