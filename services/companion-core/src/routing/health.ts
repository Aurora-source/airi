/** How a provider request failed before it produced output. */
export type FailureKind = 'network' | 'timeout' | 'server' | 'auth' | 'model-not-found'

export interface HealthOptions {
  /** Cool-down after the first failure in a row. It doubles for each further failure. */
  baseCooldownMs: number
  maxCooldownMs: number
}

export interface HealthSnapshot {
  latencyEwmaMs?: number
  lastSuccessAtMs?: number
  lastFailureAtMs?: number
  consecutiveFailures: number
  recentRequests: number
  recentFailures: number
  coolingUntilMs?: number
  calibration: number
}

interface ModelState {
  latencyEwmaMs?: number
  lastSuccessAtMs?: number
  lastFailureAtMs?: number
  consecutiveFailures: number
  coolingUntilMs?: number
  calibration: number
  /** Outcome of the last requests, newest last. */
  recent: boolean[]
}

const LATENCY_ALPHA = 0.3
const CALIBRATION_ALPHA = 0.2
const CALIBRATION_MIN = 0.8
const CALIBRATION_MAX = 1.5
/** A request this small gives a noisy token ratio. */
const CALIBRATION_MIN_TOKENS = 500
const RECENT_WINDOW = 20
const AUTH_COOLDOWN_MS = 10 * 60_000
const MODEL_NOT_FOUND_COOLDOWN_MS = 30 * 60_000

/**
 * Passive health of each model, kept in memory.
 *
 * It rests a model after a network, timeout, or server failure, with a cool-down that doubles for each failure in a row.
 * A restart clears it on purpose, because a restart often follows a network change. Rate limits are not health.
 * The quota ledger keeps them, because they must survive a restart.
 *
 * It also learns how far the token estimates are off for each model, from the usage that the provider reports.
 */
export class ModelHealth {
  private readonly states = new Map<string, ModelState>()

  constructor(
    private readonly options: HealthOptions,
    private readonly now: () => number = Date.now,
  ) {}

  recordSuccess(modelId: string, firstByteMs: number): void {
    const state = this.state(modelId)
    state.latencyEwmaMs = state.latencyEwmaMs === undefined ? firstByteMs : LATENCY_ALPHA * firstByteMs + (1 - LATENCY_ALPHA) * state.latencyEwmaMs
    state.lastSuccessAtMs = this.now()
    state.consecutiveFailures = 0
    state.coolingUntilMs = undefined
    this.remember(state, true)
  }

  /** Rests the model. `retryAfterMs` is the provider's own hint, and it can only lengthen the rest. */
  recordFailure(modelId: string, kind: FailureKind, retryAfterMs?: number): void {
    const state = this.state(modelId)
    state.consecutiveFailures++
    state.lastFailureAtMs = this.now()
    this.remember(state, false)

    let cooldownMs: number
    if (kind === 'auth')
      cooldownMs = AUTH_COOLDOWN_MS
    else if (kind === 'model-not-found')
      cooldownMs = MODEL_NOT_FOUND_COOLDOWN_MS
    else
      cooldownMs = Math.min(this.options.baseCooldownMs * 2 ** (state.consecutiveFailures - 1), this.options.maxCooldownMs)
    cooldownMs = Math.max(cooldownMs, retryAfterMs ?? 0)
    state.coolingUntilMs = Math.max(state.coolingUntilMs ?? 0, this.now() + cooldownMs)
  }

  /** The time until which the model rests, or `undefined` when it is free. */
  coolingUntil(modelId: string): number | undefined {
    const until = this.states.get(modelId)?.coolingUntilMs
    return until !== undefined && until > this.now() ? until : undefined
  }

  /**
   * Learns from one response that reported its input tokens.
   * `estimatedTokens` is the estimate that the gateway used, with the current calibration already applied.
   * The sample divides that calibration out again, so that learning never feeds on its own correction.
   */
  recordUsage(modelId: string, estimatedTokens: number, observedTokens: number): void {
    const state = this.state(modelId)
    const baseEstimate = estimatedTokens / state.calibration
    if (baseEstimate < CALIBRATION_MIN_TOKENS || observedTokens <= 0)
      return
    const sample = observedTokens / baseEstimate
    const next = CALIBRATION_ALPHA * sample + (1 - CALIBRATION_ALPHA) * state.calibration
    state.calibration = Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, next))
  }

  /** Ratio to apply to the base token estimate of this model. One until the model reports usage. */
  calibration(modelId: string): number {
    return this.states.get(modelId)?.calibration ?? 1
  }

  snapshot(modelId: string): HealthSnapshot {
    const state = this.state(modelId)
    return {
      latencyEwmaMs: state.latencyEwmaMs,
      lastSuccessAtMs: state.lastSuccessAtMs,
      lastFailureAtMs: state.lastFailureAtMs,
      consecutiveFailures: state.consecutiveFailures,
      recentRequests: state.recent.length,
      recentFailures: state.recent.filter(ok => !ok).length,
      coolingUntilMs: this.coolingUntil(modelId),
      calibration: state.calibration,
    }
  }

  private state(modelId: string): ModelState {
    let state = this.states.get(modelId)
    if (!state) {
      state = { consecutiveFailures: 0, calibration: 1, recent: [] }
      this.states.set(modelId, state)
    }
    return state
  }

  private remember(state: ModelState, ok: boolean): void {
    state.recent.push(ok)
    if (state.recent.length > RECENT_WINDOW)
      state.recent.shift()
  }
}
