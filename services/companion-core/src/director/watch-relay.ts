import type { ReactionCandidate, ReactionPermit } from '../watch/reactions'
import type { AdmittedWatchReaction, DirectorClock, WatchReactionPort, WatchReactionRequest } from './contracts'

type Outcome = 'delivered' | 'declined' | 'cancelled'

interface Handoff {
  input: WatchReactionRequest
  resolve: (outcome: Outcome) => void
  settled: boolean
  delivering: boolean
  controller: AbortController
  cancelTimer: () => void
  onAbort: () => void
}

/** Uses the existing R6 owner. validatePermit must check the actual R6-issued permit, not a reconstructed object. */
export interface WatchReactionRelayOptions {
  clock: DirectorClock
  offer: (candidate: ReactionCandidate) => boolean
  validatePermit: (permit: ReactionPermit) => boolean
  deliver: (input: AdmittedWatchReaction) => Promise<Outcome>
}

/**
 * Owns one Director handoff. R6 owns admission, cooldown, permit expiry, and permit completion.
 * The host calls admit only from R6's admitted-permit callback and finishes the permit after this promise settles.
 * Cancellation resolves the offer and makes later callbacks inert. A stalled delivery occupies one bounded lane.
 */
export class WatchReactionRelay implements WatchReactionPort {
  private handoff?: Handoff
  private disposed = false

  constructor(private readonly options: WatchReactionRelayOptions) {}

  offerReaction(input: WatchReactionRequest): Promise<Outcome> {
    if (this.disposed || this.handoff || input.signal.aborted || input.validUntil <= this.options.clock.now() || !this.safeGuard(input))
      return Promise.resolve('declined')
    return new Promise<Outcome>((resolve) => {
      const handoff: Handoff = {
        input: { ...input, candidate: { ...input.candidate } },
        resolve,
        settled: false,
        delivering: false,
        controller: new AbortController(),
        cancelTimer: () => {},
        onAbort: () => {},
      }
      this.handoff = handoff
      handoff.onAbort = () => this.finish(handoff, 'cancelled')
      input.signal.addEventListener('abort', handoff.onAbort, { once: true })
      handoff.cancelTimer = this.options.clock.schedule(Math.max(0, Math.min(input.validUntil, input.candidate.observed_at + 30000) - this.options.clock.now()), handoff.onAbort)
      try {
        // Register before offering. CompanionWatch can admit synchronously inside offerReaction.
        if (!this.options.offer({ ...input.candidate }))
          this.finish(handoff, 'declined')
      }
      catch {
        this.finish(handoff, 'declined')
      }
    })
  }

  /** This callback never admits a candidate itself. The owning R6 policy must validate its exact permit. */
  async admit(permit: ReactionPermit): Promise<Outcome> {
    const handoff = this.handoff
    if (!handoff || handoff.settled || handoff.delivering
      || permit.candidate.observation_key !== handoff.input.candidate.observation_key
      || permit.candidate.revision !== handoff.input.candidate.revision
      || permit.candidate.observed_at !== handoff.input.candidate.observed_at
      || !this.validPermit(permit)) {
      return 'declined'
    }
    const signal = AbortSignal.any([permit.signal, handoff.input.signal, handoff.controller.signal])
    const validUntil = Math.min(permit.valid_until, handoff.input.validUntil)
    const guard = () => !handoff.settled && this.handoff === handoff && !signal.aborted
      && this.options.clock.now() < validUntil && this.validPermit(permit) && this.safeGuard(handoff.input)
    if (!guard()) {
      this.finish(handoff, 'cancelled')
      return 'cancelled'
    }
    handoff.cancelTimer()
    handoff.cancelTimer = this.options.clock.schedule(Math.max(0, validUntil - this.options.clock.now()), handoff.onAbort)
    handoff.delivering = true
    const aborted = () => this.finish(handoff, 'cancelled')
    signal.addEventListener('abort', aborted, { once: true })
    try {
      const outcome = await this.options.deliver({ ...handoff.input, signal, validUntil, guard, permit })
      const result = guard() ? outcome : 'cancelled'
      this.finish(handoff, result)
      return result
    }
    catch {
      const result = signal.aborted ? 'cancelled' : 'declined'
      this.finish(handoff, result)
      return result
    }
    finally {
      signal.removeEventListener('abort', aborted)
      handoff.delivering = false
      if (this.handoff === handoff)
        this.handoff = undefined
    }
  }

  /** Whether `permit` answers this relay's waiting offer. Read-only: R6 still validates the permit itself. */
  owns(permit: ReactionPermit): boolean {
    const handoff = this.handoff
    return !!handoff && !handoff.settled && !handoff.delivering
      && permit.candidate.observation_key === handoff.input.candidate.observation_key
      && permit.candidate.revision === handoff.input.candidate.revision
      && permit.candidate.observed_at === handoff.input.candidate.observed_at
  }

  status(): { pending: number, delivering: number } {
    return { pending: this.handoff && !this.handoff.settled ? 1 : 0, delivering: this.handoff?.delivering ? 1 : 0 }
  }

  dispose(): void {
    this.disposed = true
    if (this.handoff)
      this.finish(this.handoff, 'cancelled')
  }

  private validPermit(permit: ReactionPermit): boolean {
    try {
      return !permit.signal.aborted && permit.valid_until > this.options.clock.now() && this.options.validatePermit(permit)
    }
    catch {
      return false
    }
  }

  private safeGuard(input: WatchReactionRequest): boolean {
    try {
      return input.guard()
    }
    catch {
      return false
    }
  }

  private finish(handoff: Handoff, outcome: Outcome): void {
    if (handoff.settled)
      return
    handoff.settled = true
    handoff.cancelTimer()
    handoff.controller.abort()
    handoff.input.signal.removeEventListener('abort', handoff.onAbort)
    handoff.resolve(outcome)
    if (this.handoff === handoff && !handoff.delivering)
      this.handoff = undefined
  }
}
