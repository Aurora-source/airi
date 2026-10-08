import type { MemoryItem } from '../memory/ports'
import type { ReactionCandidate } from '../watch/reactions'
import type { Affect, Decision, RecordCandidate } from './contracts'
import type { QueuedEvent } from './ingress'

import { directorLimits } from './contracts'

/** A candidate retains only an intent and validated evidence references. */
export interface Candidate {
  key: string
  score: number
  observedAt: number
  validUntil: number
  origin: Decision['origin']
  mode: 'respond' | 'continue' | 'follow-up' | 'visual' | 'watch' | 'record' | 'reason'
  affect: Affect
  requestId?: string
  watch?: ReactionCandidate
  record?: Omit<RecordCandidate, 'signal' | 'guard'>
  memorySupport?: Array<Pick<MemoryItem, 'id' | 'updatedAt'>>
  screenSupport?: { key: string, capturedAt: number }
}

/** Deterministic ranking and bounded repeat suppression. Idle time never creates a candidate. */
export class SalienceState {
  private readonly candidates = new Map<string, Candidate>()
  private readonly fingerprints = new Map<string, number>()

  offerEvent(event: QueuedEvent, now: number): 'added' | 'suppressed' | 'none' {
    const base = { observedAt: event.observedAt, validUntil: event.observedAt + 30000, origin: event.type, affect: 'focused' as Affect }
    switch (event.type) {
      case 'conversation':
        if (!event.addressed && !event.unresolved && !event.significant)
          return 'none'
        return this.add({ ...base, key: `request:${event.requestId}`, score: event.addressed ? 1 : event.unresolved ? 0.9 : 0.85, mode: event.addressed || event.unresolved ? 'respond' : 'continue', requestId: event.requestId, affect: event.affect ?? 'focused' }, now)
      case 'watch':
        if (!event.observationKey || !event.kind || event.salience === undefined || event.salience < 0.75
          || event.snapshot.status !== 'watching' || event.snapshot.perception_blocked) {
          return 'none'
        }
        return this.add({ ...base, key: `watch:${event.observationKey}`, score: event.salience * 0.8, mode: 'watch', affect: event.affect ?? 'focused', validUntil: Math.min(base.validUntil, event.snapshot.valid_until ?? now), watch: { kind: event.kind, observation_key: event.observationKey, observed_at: event.observedAt, revision: event.snapshot.revision, salience: event.salience } }, now)
      case 'screen':
        if (!event.noteworthy || event.world.status !== 'fresh' || event.world.observation.confidence < 0.65)
          return 'none'
        return this.add({ ...base, key: `screen:${event.observationKey}`, score: 0.45 * event.world.observation.confidence, mode: 'visual', affect: event.affect ?? 'curious', observedAt: event.world.observation.captured_at, validUntil: Math.min(base.validUntil, event.world.observation.captured_at + 30000, event.world.observation.valid_until), screenSupport: { key: event.observationKey, capturedAt: event.world.observation.captured_at } }, now)
      case 'record':
        if (event.provenance.invalidated || event.provenance.attribution !== 'user_said' || event.provenance.occurredAt > now)
          return 'none'
        return this.add({ ...base, key: `record:${event.messageId}:${event.kind}`, score: event.kind === 'correction' ? 0.98 : 0.95, mode: 'record', record: { identity: { ...event.identity }, kind: event.kind, messageId: event.messageId, provenance: { ...event.provenance } } }, now)
      case 'reason':
        return this.add({ ...base, key: `reason:${event.observationKey}`, score: 0.5, mode: 'reason', affect: event.affect ?? 'curious' }, now)
      default:
        return 'none'
    }
  }

  add(candidate: Candidate, now: number): 'added' | 'suppressed' {
    this.prune(now)
    if (candidate.validUntil <= now || this.fingerprints.has(candidate.key))
      return 'suppressed'
    this.fingerprints.set(candidate.key, now + 300000)
    if (this.fingerprints.size > directorLimits.fingerprints)
      this.fingerprints.delete(this.fingerprints.keys().next().value!)
    if (this.candidates.size >= directorLimits.candidates) {
      const lowest = [...this.candidates.values()].sort((a, b) => a.score - b.score || a.observedAt - b.observedAt)[0]
      if (lowest.score >= candidate.score)
        return 'suppressed'
      this.candidates.delete(lowest.key)
    }
    this.candidates.set(candidate.key, candidate)
    return 'added'
  }

  best(now: number): Candidate | undefined {
    this.prune(now)
    return [...this.candidates.values()].sort((a, b) => b.score - a.score || a.observedAt - b.observedAt)[0]
  }

  remove(candidate: Candidate): void { this.candidates.delete(candidate.key) }

  discardScreen(): void {
    for (const [key, candidate] of this.candidates) {
      if (candidate.origin === 'screen')
        this.candidates.delete(key)
    }
  }

  prune(now: number): void {
    for (const [key, candidate] of this.candidates) {
      if (candidate.validUntil <= now)
        this.candidates.delete(key)
    }
    for (const [key, until] of this.fingerprints) {
      if (until <= now)
        this.fingerprints.delete(key)
    }
  }

  resources(): { candidates: number, fingerprints: number } {
    return { candidates: this.candidates.size, fingerprints: this.fingerprints.size }
  }

  clear(): void {
    this.candidates.clear()
    this.fingerprints.clear()
  }
}
