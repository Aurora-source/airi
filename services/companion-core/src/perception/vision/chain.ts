import type { ObservationFacts, ScreenFrame, VisionObservationPort } from '../ports/contracts'

import { parseObservation } from '../observations/schema'
import { PerceptionFailure, withDeadline } from '../ports/failure'

export interface VisionConfiguration {
  profile: 'local' | 'cloud' | 'hybrid' | 'cloud-mura-voice'
  adapters: readonly VisionObservationPort[]
  /** @default false */
  allow_local_fallback?: boolean
  now?: () => number
  /** A primary attempt leaves time for an explicitly configured fallback. @default 7000 */
  attempt_timeout_ms?: number
}

/** Cloud-first hybrid routing is independent of runtime router wiring. No adapter is auto-created or launched. */
export class VisionChain {
  private readonly adapters: readonly VisionObservationPort[]
  private readonly now: () => number
  private readonly retryAt = new Map<VisionObservationPort, number>()
  private pending = 0
  private readonly attemptTimeout: number

  constructor(configuration: VisionConfiguration) {
    this.now = configuration.now ?? Date.now
    this.attemptTimeout = configuration.attempt_timeout_ms ?? 7000
    if (!Number.isFinite(this.attemptTimeout) || this.attemptTimeout <= 0)
      throw new Error('Invalid vision attempt timeout')
    const capable = configuration.adapters.filter(adapter => adapter.capabilities.vision)
    const cloud = capable.filter(adapter => adapter.locality === 'cloud')
    const local = capable.filter(adapter => adapter.locality === 'local')
    if (configuration.profile === 'local')
      this.adapters = local
    else if (configuration.profile === 'hybrid' && configuration.allow_local_fallback)
      this.adapters = [...cloud, ...local]
    else this.adapters = cloud
  }

  /** The guard runs directly before every upload and after each response, including local fallback. */
  async observe(frame: ScreenFrame, signal: AbortSignal, guard: () => void, attempted?: () => void): Promise<ObservationFacts> {
    if (this.adapters.length === 0)
      throw new PerceptionFailure('unconfigured')
    let failure = new PerceptionFailure('provider-error')
    for (const adapter of this.adapters) {
      guard()
      if (signal.aborted)
        throw new PerceptionFailure('cancelled')
      const remaining = (this.retryAt.get(adapter) ?? 0) - this.now()
      if (remaining > 0) {
        failure = new PerceptionFailure('rate-limited', remaining)
        continue
      }
      // One request can be superseded by a manual request. Uncooperative adapters cannot retain an unbounded queue.
      if (this.pending >= 2)
        throw new PerceptionFailure('provider-error', 5000)
      attempted?.()
      this.pending++
      try {
        const result = await withDeadline((attemptSignal) => {
          const operation = Promise.resolve().then(() => {
            if (attemptSignal.aborted)
              throw new PerceptionFailure('cancelled')
            return adapter.observe({ frame, signal: attemptSignal, guard })
          })
          operation.then(() => {
            this.pending--
          }, () => {
            this.pending--
          })
          return operation
        }, signal, this.attemptTimeout)
        guard()
        if (signal.aborted)
          throw new PerceptionFailure('cancelled')
        try {
          return parseObservation(result)
        }
        catch { failure = new PerceptionFailure('malformed') }
      }
      catch (error) {
        if (signal.aborted)
          throw new PerceptionFailure('cancelled')
        if (error instanceof PerceptionFailure && error.code === 'privacy')
          throw error
        failure = error instanceof PerceptionFailure ? error : new PerceptionFailure('provider-error')
        if (failure.code === 'rate-limited')
          this.retryAt.set(adapter, this.now() + (failure.retry_after_ms ?? 5000))
      }
    }
    throw failure
  }
}
