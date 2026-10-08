import type { MemoryObservation } from './ports'

import * as v from 'valibot'

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(256), v.check(text => text.trim().length > 0))
const timestamp = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8_640_000_000_000_000))
const score = v.pipe(v.number(), v.minValue(0), v.maxValue(1))
const text = v.pipe(v.string(), v.minLength(1), v.maxLength(16_000))
const claim = v.strictObject({
  key: id,
  value: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
  text,
  category: v.picklist(['identity', 'preference', 'interest', 'goal', 'stable_fact', 'personality', 'guideline', 'relationship', 'nickname', 'inside_joke', 'promise', 'open_thread', 'watch_session', 'experience']),
  attribution: v.picklist(['user_said', 'observed', 'inferred']),
  scope: v.optional(v.picklist(['global', 'character'])),
  aboutUser: v.optional(v.boolean()),
  refersToCharacter: v.optional(v.boolean()),
  correction: v.optional(v.boolean()),
  cardinality: v.optional(v.picklist(['single', 'set'])),
  confidence: v.optional(score),
  validFrom: v.optional(timestamp),
  validTo: v.optional(timestamp),
})
const observation = v.strictObject({
  userId: id,
  characterId: id,
  source: v.picklist(['gateway', 'airi', 'spark', 'admin', 'watch']),
  kind: v.picklist(['user_text', 'user_voice', 'assistant', 'spark_reaction', 'observation', 'watch_milestone', 'memory_command']),
  text,
  occurredAt: timestamp,
  language: v.optional(v.pipe(v.string(), v.regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/))),
  sessionId: v.optional(id),
  messageId: v.optional(id),
  turnId: v.optional(id),
  sparkId: v.optional(id),
  watchEventId: v.optional(id),
  requestId: v.optional(id),
  completion: v.optional(v.picklist(['complete', 'incomplete'])),
  topic: v.optional(id),
  boundary: v.optional(v.picklist(['topic', 'task', 'watch_start', 'watch_stop'])),
  claims: v.optional(v.pipe(v.array(claim), v.maxLength(32))),
  tools: v.optional(v.pipe(v.array(v.strictObject({ callId: id, name: id, outcome: v.picklist(['success', 'failed', 'cancelled']), text })), v.maxLength(32))),
  salience: v.optional(score),
  surprise: v.optional(score),
  relationship: v.optional(v.strictObject({ familiarity: v.optional(v.pipe(v.number(), v.minValue(-1), v.maxValue(1))), closeness: v.optional(v.pipe(v.number(), v.minValue(-1), v.maxValue(1))), trust: v.optional(v.pipe(v.number(), v.minValue(-1), v.maxValue(1))), playfulness: v.optional(v.pipe(v.number(), v.minValue(-1), v.maxValue(1))) })),
})

/** Validates the observer boundary before any writes. Empty or malformed evidence leaves no partial rows. */
export function parseObservation(input: MemoryObservation): MemoryObservation | null {
  const parsed = v.safeParse(observation, input)
  return parsed.success ? parsed.output : null
}
