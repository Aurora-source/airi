import type { VRMHumanBoneName } from '@pixiv/three-vrm'

import type { GestureName, MotionShape, VisualAxis, VisualBehavior, VisualFrame } from './contracts'

/** Limits describe additive rotations around the sampled pose, in normalized humanoid coordinates and radians. */
export const poseBones: readonly {
  name: VRMHumanBoneName
  axes: readonly [VisualAxis, VisualAxis, VisualAxis]
  limits: readonly [number, number, number]
}[] = [
  { name: 'hips', axes: ['hipsPitch', 'hipsYaw', 'hipsRoll'], limits: [0.025, 0.035, 0.025] },
  { name: 'spine', axes: ['bodyPitch', 'bodyYaw', 'bodyRoll'], limits: [0.09, 0.10, 0.08] },
  { name: 'chest', axes: ['chestPitch', 'chestYaw', 'chestRoll'], limits: [0.12, 0.12, 0.085] },
  { name: 'upperChest', axes: ['upperChestPitch', 'upperChestYaw', 'upperChestRoll'], limits: [0.085, 0.08, 0.07] },
  { name: 'neck', axes: ['neckPitch', 'neckYaw', 'neckRoll'], limits: [0.10, 0.16, 0.10] },
  { name: 'head', axes: ['headPitch', 'headYaw', 'headRoll'], limits: [0.22, 0.36, 0.19] },
  { name: 'leftShoulder', axes: ['leftShoulderPitch', 'leftShoulderYaw', 'leftShoulderRoll'], limits: [0.10, 0.14, 0.15] },
  { name: 'rightShoulder', axes: ['rightShoulderPitch', 'rightShoulderYaw', 'rightShoulderRoll'], limits: [0.10, 0.14, 0.15] },
  { name: 'leftUpperArm', axes: ['leftUpperArmPitch', 'leftUpperArmYaw', 'leftUpperArmRoll'], limits: [0.16, 0.26, 0.38] },
  { name: 'rightUpperArm', axes: ['rightUpperArmPitch', 'rightUpperArmYaw', 'rightUpperArmRoll'], limits: [0.16, 0.26, 0.38] },
  { name: 'leftLowerArm', axes: ['leftLowerArmPitch', 'leftLowerArmYaw', 'leftLowerArmRoll'], limits: [0.08, 0.65, 0.08] },
  { name: 'rightLowerArm', axes: ['rightLowerArmPitch', 'rightLowerArmYaw', 'rightLowerArmRoll'], limits: [0.08, 0.65, 0.08] },
  { name: 'leftHand', axes: ['leftHandPitch', 'leftHandYaw', 'leftHandRoll'], limits: [0.14, 0.16, 0.18] },
  { name: 'rightHand', axes: ['rightHandPitch', 'rightHandYaw', 'rightHandRoll'], limits: [0.14, 0.16, 0.18] },
]

export const visualAxes: readonly VisualAxis[] = [...poseBones.flatMap(b => b.axes), 'gazeX', 'gazeY', 'breath']
export const axisLimits = new Map<VisualAxis, number>(poseBones.flatMap(b => b.axes.map((axis, index) => [axis, b.limits[index]] as const)))
axisLimits.set('gazeX', 0.4)
axisLimits.set('gazeY', 0.4)
axisLimits.set('breath', 0.15)

type Curve = readonly (readonly [time: number, value: number])[]
const shapes: Record<MotionShape, Curve> = {
  soft: [[0, 0], [0.28, 1], [0.62, 0.94], [1, 0]],
  quick: [[0, 0], [0.15, 1], [0.48, 0.92], [1, 0]],
  reaction: [[0, 0], [0.065, 1], [0.14, 1.16], [0.34, 0.88], [0.67, 0.48], [1, 0]],
  nod: [[0, 0], [0.13, -0.18], [0.31, 1], [0.5, -0.08], [0.66, 0.46], [0.8, 0.08], [1, 0]],
  drift: [[0, 0], [0.24, 0.8], [0.46, 0.25], [0.73, -0.55], [1, 0]],
  scan: [[0, 0], [0.2, 1], [0.32, 1], [0.59, -0.85], [0.73, -0.85], [0.88, 0.22], [1, 0]],
  fidget: [[0, 0], [0.18, 0.75], [0.32, 0.1], [0.54, -0.45], [0.69, 0.18], [0.82, 0.55], [1, 0]],
  stretch: [[0, 0], [0.10, -0.08], [0.44, 1], [0.65, 1.03], [0.78, 0.82], [1, 0]],
  settle: [[0, 0], [0.19, 0.75], [0.42, 1], [0.72, 0.30], [0.86, 0.13], [1, 0]],
}

/** Normalized T-pose arms extend along X. Mirrored Y bends bring elbows forward, and mirrored Z lifts open arms. */
export const gesturePrimitives: Readonly<Record<GestureName, Partial<Record<VisualAxis, number>>>> = {
  'chest-open': { bodyPitch: -0.034, chestPitch: -0.058, upperChestPitch: -0.027, leftShoulderYaw: -0.03, rightShoulderYaw: 0.03 },
  'chest-collapse': { bodyPitch: 0.04, chestPitch: 0.06, upperChestPitch: 0.035, neckPitch: 0.027 },
  'shoulder-lift': { leftShoulderRoll: 0.085, rightShoulderRoll: -0.073, leftUpperArmRoll: 0.045, rightUpperArmRoll: -0.035 },
  'shoulder-drop': { leftShoulderRoll: -0.038, rightShoulderRoll: 0.045, leftShoulderYaw: 0.02, rightShoulderYaw: -0.025 },
  'open-arms-small': { leftUpperArmRoll: 0.18, rightUpperArmRoll: -0.14, leftUpperArmYaw: -0.12, rightUpperArmYaw: 0.10, leftLowerArmYaw: -0.17, rightLowerArmYaw: 0.12, leftHandPitch: -0.055, rightHandPitch: -0.035, leftHandRoll: 0.06, rightHandRoll: -0.045 },
  'hands-inward': { leftUpperArmYaw: -0.10, rightUpperArmYaw: 0.075, leftLowerArmYaw: -0.29, rightLowerArmYaw: 0.21, leftHandYaw: 0.045, rightHandYaw: -0.055 },
  'lean-forward': { hipsPitch: 0.01, bodyPitch: 0.034, chestPitch: 0.025, neckPitch: -0.018 },
  'lean-back': { hipsPitch: -0.009, bodyPitch: -0.034, chestPitch: -0.027 },
  'lean-side': { hipsRoll: 0.012, bodyRoll: 0.037, chestRoll: 0.018, upperChestRoll: -0.008 },
  'recoil': { bodyPitch: -0.065, chestPitch: -0.095, upperChestPitch: -0.034, neckPitch: 0.045, leftUpperArmRoll: 0.16, rightUpperArmRoll: -0.12, leftUpperArmYaw: -0.14, rightUpperArmYaw: 0.11, leftLowerArmYaw: -0.27, rightLowerArmYaw: 0.23, leftHandPitch: -0.10, rightHandPitch: -0.08 },
  'small-shrug': { chestPitch: 0.018, leftShoulderRoll: 0.075, rightShoulderRoll: -0.057, leftUpperArmRoll: 0.10, rightUpperArmRoll: -0.07, leftLowerArmYaw: -0.22, rightLowerArmYaw: 0.16, leftHandRoll: 0.09, rightHandRoll: -0.07 },
  'thoughtful-hand': { leftShoulderYaw: 0.05, leftUpperArmYaw: -0.16, leftUpperArmRoll: 0.12, leftLowerArmYaw: -0.49, leftHandPitch: 0.075, leftHandYaw: 0.09, rightUpperArmRoll: 0.012, rightHandPitch: -0.025 },
  'attentive-posture': { bodyPitch: -0.018, chestPitch: -0.035, upperChestPitch: -0.02, neckPitch: 0.025, leftShoulderRoll: -0.02, rightShoulderRoll: 0.024, leftLowerArmYaw: -0.07, rightLowerArmYaw: 0.055, leftHandPitch: -0.025, rightHandPitch: -0.03 },
  'excited-lift': { leftShoulderRoll: 0.047, rightShoulderRoll: -0.036, leftUpperArmRoll: 0.10, rightUpperArmRoll: -0.075, leftLowerArmYaw: -0.12, rightLowerArmYaw: 0.09, leftHandYaw: -0.045, rightHandYaw: 0.03 },
  'relaxed-drop': { bodyRoll: -0.026, chestPitch: 0.025, upperChestPitch: 0.012, leftUpperArmRoll: -0.025, rightUpperArmRoll: 0.034, leftLowerArmYaw: -0.065, rightLowerArmYaw: 0.045, leftHandPitch: 0.045, rightHandPitch: 0.03, leftHandRoll: -0.035, rightHandRoll: 0.045 },
  'concerned-fold': { chestYaw: 0.026, leftShoulderYaw: 0.068, rightShoulderYaw: -0.052, leftUpperArmYaw: -0.13, rightUpperArmYaw: 0.09, leftLowerArmYaw: -0.25, rightLowerArmYaw: 0.20, leftHandPitch: 0.055, rightHandPitch: 0.04 },
  'subtle-hand-fidget': { leftHandPitch: 0.08, leftHandYaw: 0.07, leftHandRoll: 0.04, rightHandPitch: -0.027, leftLowerArmYaw: -0.095, rightLowerArmYaw: 0.025 },
  'asymmetric-arm-shift': { leftShoulderRoll: 0.027, rightShoulderRoll: 0.012, leftUpperArmRoll: 0.045, rightUpperArmRoll: 0.018, leftLowerArmYaw: -0.13, rightLowerArmYaw: 0.04, leftHandRoll: 0.045, rightHandPitch: 0.03 },
  'torso-turn': { hipsYaw: 0.015, bodyYaw: 0.035, chestYaw: 0.04, upperChestYaw: 0.017 },
  'stretch-open': { hipsPitch: -0.009, bodyPitch: -0.06, chestPitch: -0.08, upperChestPitch: -0.04, leftShoulderRoll: 0.07, rightShoulderRoll: -0.06, leftUpperArmRoll: 0.32, rightUpperArmRoll: -0.29, leftUpperArmYaw: -0.13, rightUpperArmYaw: 0.11, leftLowerArmYaw: -0.27, rightLowerArmYaw: 0.21, leftHandPitch: -0.07, rightHandPitch: -0.055 },
}

function smooth(t: number) {
  return t * t * (3 - 2 * t)
}

/** Sparse curves include their neutral endpoints. Sampling neither allocates nor modifies catalog data. */
export function sampleMotionShape(shape: MotionShape, progress: number) {
  const keys = shapes[shape]
  if (progress <= 0 || progress >= 1)
    return 0
  for (let i = 1; i < keys.length; i++) {
    const [end, value] = keys[i]
    const [start, previous] = keys[i - 1]
    if (progress <= end)
      return previous + (value - previous) * smooth((progress - start) / (end - start))
  }
  return 0
}

function delayFor(axis: VisualAxis, lead: VisualBehavior['lead']) {
  if (axis.startsWith('gaze'))
    return 0
  if (axis.startsWith('head') || axis.startsWith('neck'))
    return lead === 'head' ? 20 : 45
  if (axis.includes('Shoulder'))
    return lead === 'head' ? 125 : 60
  if (axis.includes('UpperArm'))
    return 95
  if (axis.includes('LowerArm'))
    return 125
  if (axis.includes('Hand'))
    return 165
  return lead === 'head' ? 100 : 0
}

/** Compile once when binding a catalog. Render frames only sample the resulting numeric tracks. */
export function compilePoseTracks(behavior: VisualBehavior) {
  const tracks: { axis: VisualAxis, amount: number, delayMs: number, shape: MotionShape }[] = []
  function add(pose: Partial<Record<VisualAxis, number>>, strength: number, shape: MotionShape, delayMs: number) {
    for (const [key, value] of Object.entries(pose)) {
      if (value === undefined || !Number.isFinite(value) || !Number.isFinite(strength))
        continue
      const axis = key as VisualAxis
      tracks.push({ axis, amount: value * strength, delayMs: delayMs + delayFor(axis, behavior.lead), shape })
    }
  }
  if (behavior.pose)
    add(behavior.pose, 1, behavior.shape ?? 'soft', 0)
  for (const gesture of behavior.gestures ?? [])
    add(gesturePrimitives[gesture.name], gesture.strength ?? 1, gesture.shape ?? behavior.shape ?? 'soft', gesture.delayMs ?? 0)
  return tracks
}

/** Add staggered motion into the caller's reusable frame. Variation stays fixed throughout one behavior. */
export function samplePoseTracks(tracks: ReturnType<typeof compilePoseTracks>, elapsedMs: number, durationMs: number, frame: VisualFrame, variation: number, amplitude: number) {
  for (const track of tracks) {
    const delay = Math.min(durationMs * 0.2, track.delayMs)
    const progress = (elapsedMs - delay) / (durationMs - delay)
    const side = track.axis.startsWith('left') ? 1 : track.axis.startsWith('right') ? -1 : 0
    frame[track.axis] = (frame[track.axis] ?? 0) + track.amount * sampleMotionShape(track.shape, progress) * (1 + side * variation) * amplitude
  }
}
