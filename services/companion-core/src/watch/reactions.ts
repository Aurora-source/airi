import type { WatchSnapshot } from './contracts'
import type { WatchState } from './state'

export interface ReactionCandidate {
  kind: 'scene-change' | 'episode-end' | 'pause' | 'shared-moment'
  /** A bounded opaque semantic fingerprint. Never pass subtitle text as the key. */
  observation_key: string
  observed_at: number
  revision: number
  salience: number
}

/** The voice host revalidates this permit before output and honors its cancellation signal during speech. */
export interface ReactionPermit {
  candidate: ReactionCandidate
  signal: AbortSignal
  valid_until: number
}

/**
 * Deterministic timing only. One pending candidate waits for a proven dialogue gap.
 * A bounded fingerprint set suppresses repeats. User speech revokes pending and admitted reactions.
 * One cancellation timer enforces each admitted permit's evidence deadline. No cognition loop exists.
 */
export class ReactionPolicy {
  private pending?: ReactionCandidate
  private admitted?: { permit: ReactionPermit, controller: AbortController, timer: ReturnType<typeof setTimeout> }
  private last_reaction = -Infinity
  private readonly seen = new Set<string>()
  private user_speaking = false
  private disposed = false
  private readonly unsubscribe: () => void

  constructor(private readonly state: WatchState, private readonly now: () => number) {
    this.unsubscribe = state.subscribe(() => {
      if (this.admitted && !this.allowed(this.state.current(), this.admitted.permit.candidate.revision))
        this.revoke()
    })
  }

  offer(candidate: ReactionCandidate): boolean {
    const current = this.state.current()
    if (this.disposed || this.user_speaking || current.status !== 'watching' || candidate.revision !== current.revision
      || !Number.isFinite(candidate.salience) || candidate.salience < 0.75 || candidate.salience > 1
      || !Number.isFinite(candidate.observed_at) || candidate.observed_at > this.now() || candidate.observed_at + 30000 <= this.now()
      || !candidate.observation_key || candidate.observation_key.length > 128 || this.seen.has(candidate.observation_key)) {
      return false
    }
    if (!this.pending || candidate.salience >= this.pending.salience)
      this.pending = { ...candidate }
    return true
  }

  /** Admission consumes cooldown immediately. An interrupted reaction cannot trigger rapid retries. */
  take(): ReactionPermit | undefined {
    if (this.admitted || !this.pending)
      return undefined
    const current = this.state.current()
    const candidate = this.pending
    if (candidate.observed_at + 30000 <= this.now() || candidate.revision !== current.revision || current.status !== 'watching') {
      this.pending = undefined
      return undefined
    }
    if (!this.allowed(current, candidate.revision) || this.now() - this.last_reaction < this.state.options.reaction_cooldown_ms)
      return undefined
    const controller = new AbortController()
    const permit = { candidate: { ...candidate }, signal: controller.signal, valid_until: Math.min(this.now() + 5000, candidate.observed_at + 30000, current.valid_until!, current.playback!.valid_until, current.dialogue_valid_until!) }
    const timer = setTimeout(() => {
      if (this.admitted?.permit === permit)
        this.revoke()
    }, permit.valid_until - this.now())
    timer.unref?.()
    this.admitted = { permit, controller, timer }
    this.pending = undefined
    this.last_reaction = this.now()
    this.seen.add(candidate.observation_key)
    if (this.seen.size > 64)
      this.seen.delete(this.seen.values().next().value!)
    return permit
  }

  valid(permit: ReactionPermit): boolean {
    if (this.admitted?.permit !== permit || permit.signal.aborted || permit.valid_until <= this.now() || !this.allowed(this.state.current(), permit.candidate.revision)) {
      if (this.admitted?.permit === permit)
        this.revoke()
      return false
    }
    return true
  }

  finish(permit: ReactionPermit): void {
    if (this.admitted?.permit === permit)
      this.revoke()
  }

  userSpeech(active: boolean): void {
    this.user_speaking = active
    if (active) {
      this.pending = undefined
      this.revoke()
    }
  }

  shutdown(): void {
    this.disposed = true
    this.pending = undefined
    this.revoke()
    this.unsubscribe()
  }

  private allowed(current: WatchSnapshot, revision: number): boolean {
    return !this.disposed && !this.user_speaking && current.status === 'watching' && current.revision === revision
      && current.dialogue_active === 'gap' && current.gap_since !== undefined
      && current.playback !== undefined && current.valid_until !== undefined && current.dialogue_valid_until !== undefined
      && this.now() - current.gap_since >= this.state.options.dialogue_gap_ms
  }

  private revoke(): void {
    if (this.admitted)
      clearTimeout(this.admitted.timer)
    this.admitted?.controller.abort()
    this.admitted = undefined
  }
}
