import type { ScreenFrame } from '../ports/contracts'

export interface PrivacyPolicy {
  paused?: boolean
  excluded_apps?: readonly string[]
  excluded_windows?: readonly string[]
  limited_apps?: readonly string[]
}

/** Authorization applies to one manual request. It never overrides explicit privacy blocks. */
export interface ManualAuthorization {
  authorize_unknown?: boolean
}

export interface PrivacyDecision {
  state: 'ALLOW' | 'BLOCK' | 'LIMITED' | 'UNKNOWN'
  reason: 'safe' | 'paused' | 'denied' | 'private' | 'locked' | 'sensitive' | 'limited' | 'unknown'
  revision: number
}

/** Revisions let the service revoke pending captures and uploads without retaining sensitive metadata. */
export class PrivacyGate {
  private policy: PrivacyPolicy
  private listeners = new Set<() => void>()
  private version = 0

  constructor(policy: PrivacyPolicy = {}) {
    this.policy = structuredClone(policy)
  }

  get revision(): number { return this.version }
  get paused(): boolean { return this.policy.paused === true }

  update(policy: PrivacyPolicy): void {
    this.policy = structuredClone(policy)
    this.version++
    for (const listener of this.listeners) {
      try {
        listener()
      }
      catch { /* Revocation must reach every subscriber, even if a consumer fails. */ }
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  evaluate(frame: ScreenFrame, manual?: ManualAuthorization): PrivacyDecision {
    const result = (state: PrivacyDecision['state'], reason: PrivacyDecision['reason']): PrivacyDecision => ({ state, reason, revision: this.version })
    if (this.paused)
      return result('BLOCK', 'paused')
    const app = frame.source.foreground_app?.toLowerCase()
    const title = frame.source.window_title?.toLowerCase()
    if (this.policy.excluded_apps?.some(value => app === value.toLowerCase())
      || this.policy.excluded_windows?.some(value => title?.includes(value.toLowerCase()))) {
      return result('BLOCK', 'denied')
    }
    if (frame.safety.private_context === true)
      return result('BLOCK', 'private')
    if (frame.safety.locked === true)
      return result('BLOCK', 'locked')
    if (frame.safety.sensitive === true)
      return result('BLOCK', 'sensitive')
    if (this.policy.limited_apps?.some(value => app === value.toLowerCase()))
      return result('LIMITED', 'limited')
    if (Object.values(frame.safety).some(value => value !== false)
      || frame.safety.private_context !== false || frame.safety.locked !== false || frame.safety.sensitive !== false) {
      if (!manual?.authorize_unknown)
        return result('UNKNOWN', 'unknown')
    }
    return result('ALLOW', 'safe')
  }
}
