import * as v from 'valibot'

const time = v.pipe(v.number(), v.safeInteger(), v.minValue(0))
const fraction = v.pipe(v.number(), v.minValue(0), v.maxValue(1))
const opaque = v.pipe(v.string(), v.minLength(1), v.maxLength(128), v.regex(/^[\w.:-]+$/))
const affect = v.picklist(['amused', 'curious', 'surprised', 'concerned', 'focused'])
export const identitySchema = v.object({ userId: opaque, characterId: opaque })
const envelope = { id: opaque, identity: identitySchema, observedAt: time }
const evidence = { confidence: fraction, observed_at: time, valid_until: time }

// Projection deliberately omits subtitle, title, scene, and observation text before queue ownership begins.
const watchSnapshot = v.object({
  status: v.picklist(['idle', 'watching', 'stale', 'cancelled']),
  revision: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  valid_until: v.optional(time),
  media: v.optional(v.object({ id: opaque })),
  playback: v.optional(v.object({ ...evidence, value: v.picklist(['playing', 'paused']) })),
  dialogue_active: v.picklist(['active', 'gap', 'unknown']),
  gap_since: v.optional(time),
  dialogue_valid_until: v.optional(time),
  confidence: fraction,
  perception_blocked: v.boolean(),
})
const world = v.variant('status', [
  v.object({
    status: v.literal('fresh'),
    observation: v.object({
      captured_at: time,
      valid_until: time,
      confidence: fraction,
      activity: v.pipe(v.string(), v.maxLength(64)),
    }),
  }),
  v.object({ status: v.picklist(['stale', 'unavailable', 'blocked-by-privacy', 'capture-failed', 'vlm-failed']) }),
])

export const eventSchema = v.variant('type', [
  v.object({ ...envelope, type: v.literal('conversation'), requestId: opaque, addressed: v.boolean(), significant: v.boolean(), unresolved: v.boolean(), affect: v.optional(affect) }),
  v.object({ ...envelope, type: v.literal('speech'), speaker: v.picklist(['user', 'companion']), active: v.boolean(), outputId: v.optional(opaque) }),
  v.object({ ...envelope, type: v.literal('activity'), activity: v.picklist(['working', 'idle', 'absent', 'unknown']), source: v.picklist(['user-declared', 'input-activity', 'presence-signal']), confidence: fraction }),
  v.object({ ...envelope, type: v.literal('watch'), snapshot: watchSnapshot, observationKey: v.optional(opaque), kind: v.optional(v.picklist(['scene-change', 'episode-end', 'pause', 'shared-moment'])), affect: v.optional(affect), salience: v.optional(fraction), context: v.optional(v.picklist(['anime', 'media'])) }),
  v.object({ ...envelope, type: v.literal('screen'), world, observationKey: opaque, noteworthy: v.boolean(), affect: v.optional(affect) }),
  v.object({ ...envelope, type: v.literal('record'), kind: v.picklist(['preference', 'correction', 'plan', 'promise']), messageId: opaque, provenance: v.object({ eventId: opaque, source: opaque, authority: opaque, attribution: v.picklist(['user_said', 'observed', 'inferred']), occurredAt: time, invalidated: v.boolean() }) }),
  v.object({ ...envelope, type: v.literal('recall'), query: v.pipe(v.string(), v.minLength(1), v.maxLength(256)), requestId: opaque, purpose: v.picklist(['relevant-recall', 'follow-up']) }),
  v.object({ ...envelope, type: v.literal('memory-invalidated'), itemIds: v.pipe(v.custom<unknown[]>(input => Array.isArray(input) && input.length <= 16), v.array(opaque)) }),
  v.object({ ...envelope, type: v.literal('reason'), observationKey: opaque, affect: v.optional(affect) }),
])

export type QueuedEvent = v.InferOutput<typeof eventSchema>

export const configurationSchema = v.strictObject({
  enabled: v.boolean(),
  proactiveSpeech: v.boolean(),
  quietMode: v.boolean(),
  privateMode: v.boolean(),
  reactionFrequency: v.picklist(['off', 'low', 'normal']),
  reasoningEnabled: v.boolean(),
  utcOffsetMinutes: v.pipe(v.number(), v.integer(), v.minValue(-840), v.maxValue(840)),
  quietPeriods: v.pipe(v.custom<unknown[]>(input => Array.isArray(input) && input.length <= 8), v.array(v.strictObject({
    startMinute: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1439)),
    endMinute: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1439)),
  }))),
})

/** Structured model output has no free-text field or executable action. */
export const reasoningResultSchema = v.strictObject({ action: v.picklist(['wait', 'visual']), affect })
