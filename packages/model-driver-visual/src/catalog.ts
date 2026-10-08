import type { IdleIntensity, VisualBehavior } from './contracts'

/** Native motion roles are opt-in semantic bindings. Unavailable motions use the bounded pose in the same entry. */
export const visualBehaviorCatalog: readonly VisualBehavior[] = [
  { id: 'gaze-drift', category: 'micro', durationMs: 2400, cooldownMs: 12000, weight: 2, pose: { gazeX: 0.12, headYaw: 0.015 }, idle: true },
  { id: 'head-drift', category: 'micro', durationMs: 3200, cooldownMs: 16000, weight: 2, pose: { headRoll: 0.018 }, idle: true },
  { id: 'breath-shift', category: 'micro', durationMs: 4200, cooldownMs: 25000, weight: 2, pose: { breath: 0.1, bodyPitch: 0.004 }, idle: true },
  { id: 'posture-shift', category: 'short', durationMs: 5000, cooldownMs: 90000, weight: 1, pose: { bodyRoll: 0.012 }, idle: true },
  { id: 'glance-left', category: 'short', durationMs: 2800, cooldownMs: 60000, weight: 3, pose: { headYaw: 0.07, gazeX: 0.25 }, idle: true },
  { id: 'glance-right', category: 'short', durationMs: 2800, cooldownMs: 60000, weight: 3, pose: { headYaw: -0.07, gazeX: -0.25 }, idle: true },
  { id: 'look-up', category: 'short', durationMs: 2400, cooldownMs: 65000, weight: 1, pose: { headPitch: -0.045, gazeY: 0.18 }, idle: true },
  { id: 'look-down', category: 'short', durationMs: 2400, cooldownMs: 65000, weight: 1, pose: { headPitch: 0.045, gazeY: -0.18 }, idle: true },
  { id: 'head-tilt', category: 'short', durationMs: 3500, cooldownMs: 70000, weight: 2, pose: { headRoll: 0.065 }, idle: true },
  { id: 'tiny-smile', category: 'short', durationMs: 2600, cooldownMs: 150000, weight: 0.25, expression: 'happy', expressionWeight: 0.14, idle: true },
  { id: 'curious', category: 'short', durationMs: 3500, cooldownMs: 30000, weight: 1, pose: { headRoll: 0.07, headPitch: -0.025 } },
  { id: 'fidget', category: 'short', durationMs: 3500, cooldownMs: 100000, weight: 0.4, pose: { bodyRoll: 0.014 }, oscillations: 2, idle: true },
  { id: 'attentive', category: 'listening', durationMs: 3000, cooldownMs: 6000, weight: 1, pose: { headPitch: 0.025 } },
  { id: 'listening', category: 'listening', durationMs: 4500, cooldownMs: 6000, weight: 1, pose: { headPitch: 0.03, headRoll: 0.025 } },
  { id: 'nod', category: 'listening', durationMs: 1800, cooldownMs: 20000, weight: 1, pose: { headPitch: 0.04 }, oscillations: 2 },
  { id: 'stretch', category: 'long', durationMs: 8000, cooldownMs: 300000, weight: 0.5, motionRole: 'stretch', pose: { bodyPitch: -0.015, headPitch: -0.03 }, idle: true },
  { id: 'relaxed', category: 'long', durationMs: 6500, cooldownMs: 200000, weight: 2, pose: { headRoll: 0.02 }, expression: 'relaxed', expressionWeight: 0.12, idle: true },
  { id: 'sleepy', category: 'long', durationMs: 5500, cooldownMs: 300000, weight: 0.3, motionRole: 'yawn', pose: { headPitch: 0.045 }, expression: 'sleepy', expressionWeight: 0.2, idle: true },
  { id: 'look-around', category: 'long', durationMs: 7500, cooldownMs: 180000, weight: 2, pose: { headYaw: 0.075 }, oscillations: 2, idle: true },
  { id: 'thoughtful', category: 'long', durationMs: 6500, cooldownMs: 200000, weight: 1, pose: { headYaw: 0.05, headPitch: -0.035 }, idle: true },
  { id: 'restless', category: 'long', durationMs: 6500, cooldownMs: 300000, weight: 0.25, pose: { bodyRoll: 0.016, headYaw: 0.025 }, oscillations: 2, idle: true },
  { id: 'settle', category: 'long', durationMs: 5000, cooldownMs: 150000, weight: 1, pose: { bodyPitch: 0.008 }, idle: true },
  { id: 'thinking', category: 'waiting', durationMs: 4500, cooldownMs: 12000, weight: 1, pose: { headYaw: 0.06, headPitch: -0.04, headRoll: 0.025 } },
  { id: 'waiting', category: 'waiting', durationMs: 3800, cooldownMs: 15000, weight: 1, pose: { headYaw: -0.04, bodyRoll: 0.008 } },
  { id: 'happy', category: 'positive', durationMs: 3200, cooldownMs: 12000, weight: 1, pose: { headRoll: 0.025, bodyPitch: -0.008 }, expression: 'happy', expressionWeight: 0.35 },
  { id: 'amused', category: 'positive', durationMs: 3000, cooldownMs: 12000, weight: 1, pose: { headPitch: 0.022, headRoll: -0.03 }, expression: 'happy', expressionWeight: 0.28 },
  { id: 'concerned', category: 'concerned', durationMs: 3600, cooldownMs: 15000, weight: 1, pose: { headRoll: 0.05, headPitch: 0.028 }, expression: 'sad', expressionWeight: 0.22 },
  { id: 'frown', category: 'concerned', durationMs: 2800, cooldownMs: 15000, weight: 1, pose: { headPitch: 0.028 }, expression: 'sad', expressionWeight: 0.18 },
  { id: 'surprised', category: 'surprise', durationMs: 1800, cooldownMs: 15000, weight: 1, pose: { headPitch: -0.055 }, expression: 'surprised', expressionWeight: 0.3 },
  { id: 'focused', category: 'watching', durationMs: 4500, cooldownMs: 15000, weight: 1, pose: { headPitch: 0.018, headYaw: 0.012 } },
]

/** These are visual settings. They do not encode or infer mood. Intervals use milliseconds. */
export const idleProfiles: Readonly<Record<IdleIntensity, { interval: readonly [number, number], amplitude: number, longProbability: number, neutralMs: number }>> = {
  still: { interval: [Infinity, Infinity], amplitude: 0, longProbability: 0, neutralMs: 15000 },
  calm: { interval: [50000, 100000], amplitude: 0.35, longProbability: 0.025, neutralMs: 16000 },
  normal: { interval: [25000, 65000], amplitude: 0.55, longProbability: 0.06, neutralMs: 12000 },
  lively: { interval: [15000, 40000], amplitude: 0.75, longProbability: 0.1, neutralMs: 9000 },
}
