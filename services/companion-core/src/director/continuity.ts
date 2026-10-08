import type { MemoryItem } from '../memory/ports'
import type { DirectorIdentity } from './contracts'

import * as v from 'valibot'

import { directorLimits } from './contracts'

const time = v.pipe(v.number(), v.safeInteger())
const finite = v.pipe(v.number(), v.check((value: number) => Number.isFinite(value)))
const text = (limit: number) => v.pipe(v.string(), v.maxLength(limit))
const id = v.pipe(v.string(), v.minLength(1), v.maxLength(128))
const itemSchema = v.object({
  id,
  userId: id,
  characterId: v.nullable(id),
  scope: v.picklist(['global', 'character']),
  kind: v.picklist(['fact', 'episode', 'relationship']),
  category: text(32),
  originalText: text(2400),
  normalizedSearchText: text(2400),
  language: text(32),
  state: v.picklist(['active', 'contested', 'superseded']),
  confidence: v.pipe(finite, v.minValue(0), v.maxValue(1)),
  pinned: v.boolean(),
  stability: finite,
  difficulty: finite,
  repetitions: finite,
  lastReview: time,
  occurredAt: time,
  recordedAt: time,
  updatedAt: time,
  validFrom: v.nullable(time),
  validTo: v.nullable(time),
  supersededBy: v.nullable(id),
  semanticKey: v.nullable(text(128)),
  semanticValue: v.nullable(text(2400)),
  invalidated: v.boolean(),
  provenance: v.pipe(v.array(v.object({
    eventId: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
    source: id,
    authority: id,
    attribution: v.picklist(['user_said', 'observed', 'inferred']),
    occurredAt: time,
    invalidated: v.boolean(),
  })), v.minLength(1), v.maxLength(8)),
})

/** Active memory requires matching scope, valid intervals, and every supporting provenance edge to remain valid. */
export function isCurrentMemory(item: MemoryItem, identity: DirectorIdentity, now: number): boolean {
  return item.userId === identity.userId && (item.scope === 'global' ? item.characterId === null : item.characterId === identity.characterId)
    && item.state === 'active' && !item.invalidated && !item.supersededBy && item.confidence >= 0.6
    && item.occurredAt <= now && item.updatedAt <= now && (item.validFrom === null || item.validFrom <= now) && (item.validTo === null || item.validTo > now)
    && item.provenance.every(p => !p.invalidated && p.occurredAt <= now)
    && (item.category !== 'goal' || item.provenance.some(p => p.attribution === 'user_said'))
    && (!['promise', 'open_thread'].includes(item.category) || item.provenance.some(p => p.attribution !== 'inferred'))
}

/** Projects at most eight R4 items. Unknown fields and oversized metadata never enter owned continuity. */
export function selectMemories(items: readonly MemoryItem[], identity: DirectorIdentity, now: number): MemoryItem[] {
  const selected: MemoryItem[] = []
  let textBytes = directorLimits.recallBytes
  let retainedBytes = 16384
  for (const raw of items.slice(0, directorLimits.recallItems)) {
    // Check collection length before schema traversal so a malformed port cannot create unbounded validation work.
    if (!raw || !Array.isArray(raw.provenance) || raw.provenance.length > 8)
      continue
    const parsed = v.safeParse(itemSchema, raw)
    if (!parsed.success || !isCurrentMemory(parsed.output, identity, now))
      continue
    const item = parsed.output
    const textSize = new TextEncoder().encode(item.originalText + item.normalizedSearchText + (item.semanticValue ?? '')).byteLength
    const size = new TextEncoder().encode(JSON.stringify(item)).byteLength
    if (textSize > textBytes || size > retainedBytes)
      continue
    textBytes -= textSize
    retainedBytes -= size
    selected.push(item)
  }
  return selected
}
