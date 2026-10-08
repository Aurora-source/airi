import type { DirectorEvent, DirectorIdentity, DirectorOptions, RecordCandidatePort, SpeechIntentPort, VisualIntentPort } from '../../src/director'
import type { MemoryItem } from '../../src/memory/ports'

import { vi } from 'vitest'

import { VirtualClock } from '../../eval/director/virtual-clock'

export { VirtualClock } from '../../eval/director/virtual-clock'

export const identity: DirectorIdentity = { userId: 'user-1', characterId: 'mura' }

/** Captures only external effects. Internal policies remain real. */
export function fixture(overrides: Partial<DirectorOptions> = {}) {
  const clock = new VirtualClock()
  const speech = { deliver: vi.fn<SpeechIntentPort['deliver']>(async () => 'delivered') }
  const visual = { request: vi.fn<VisualIntentPort['request']>(() => 'started'), cancel: vi.fn() }
  const record = { offer: vi.fn<RecordCandidatePort['offer']>(async () => 'accepted') }
  const options: DirectorOptions = { identity, profile: 'local', clock, speech, visual, record, ...overrides }
  return { options, clock, speech, visual, record }
}

/** One canonical request stays stable across retries. */
export function conversation(clock: VirtualClock, id = 'request-1', overrides: Partial<Extract<DirectorEvent, { type: 'conversation' }>> = {}): DirectorEvent {
  return { type: 'conversation', id, identity, observedAt: clock.now(), requestId: id, addressed: true, significant: true, unresolved: true, ...overrides }
}

/** A live voice edge carries acquisition time, rather than queue delivery time. */
export function speechEvent(clock: VirtualClock, active: boolean, id = `speech-${active}`, speaker: 'user' | 'companion' = 'user'): DirectorEvent {
  return { type: 'speech', id, identity, observedAt: clock.now(), speaker, active }
}

/** Allows promise completions to settle without real time passing. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++)
    await Promise.resolve()
}

/** Evidence is synthetic, with the same provenance and ownership fields as actual R4 output. */
export function memoryItem(clock: VirtualClock, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'memory-1',
    userId: identity.userId,
    characterId: identity.characterId,
    scope: 'character',
    kind: 'fact',
    category: 'open_thread',
    originalText: 'Ask about the user-stated exam plan.',
    normalizedSearchText: 'exam plan',
    language: 'en',
    state: 'active',
    confidence: 0.9,
    pinned: false,
    stability: 1,
    difficulty: 1,
    repetitions: 1,
    lastReview: clock.now(),
    occurredAt: clock.now(),
    recordedAt: clock.now(),
    updatedAt: clock.now(),
    validFrom: null,
    validTo: null,
    supersededBy: null,
    semanticKey: 'user.exam-plan',
    semanticValue: 'exam tomorrow',
    invalidated: false,
    provenance: [{ eventId: 'airi:session:msg:exam', source: 'airi', authority: 'airi', attribution: 'user_said', occurredAt: clock.now(), invalidated: false }],
    ...overrides,
  }
}
