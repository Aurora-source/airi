import type { PerceptionConfig } from '../config/config'
import type { GatewayRuntime } from '../gateway/runtime'
import type { CaptureBackend, CurrentWorld, Metrics, PerceptionEventPort, PrivacyPolicy } from '../perception'
import type { TurnIdentity } from './turn-identity'

import { OwnedScreenCapture, PerceptionService, PrivacyGate, VisionChain } from '../perception'
import { RoutedVisionAdapter } from './routed-vision'

/** A manual look within this gap reuses the last manual observation. A model cannot loop paid vision calls. */
const MANUAL_GAP_MS = 5000

/** Perception event metadata kept for Ops. It is a short in-memory window, never a database. */
const MAX_EVENT_RECORDS = 32

/**
 * Durable memory policy of perception events. `none`: no perception event becomes a memory event.
 * Only the user can make a screen fact durable, through the memory tools. R7 owns salience rules.
 */
export const PERCEPTION_MEMORY_POLICY = 'none'

/** A capture backend that can start ahead of the first capture and report display changes. */
export interface ScreenBackend extends CaptureBackend {
  start?: () => void
  onSourceChange?: (listener: (available: boolean) => void) => void
}

export interface CompanionPerceptionOptions {
  config: PerceptionConfig
  backend: ScreenBackend
  /** Character and session of the newest AIRI turn. Event metadata names them, so Ops can tell whose screen it was. */
  activeTurn?: () => TurnIdentity | undefined
  now?: () => number
}

/**
 * What perception published, without screen content. It keeps the seam to memory: acquisition time, observation id,
 * confidence, provenance, and character and session context.
 */
export interface PerceptionEventRecord {
  status: CurrentWorld['status']
  published_at: number
  observation_id?: string
  captured_at?: number
  confidence?: number
  /** Capture source without window title or window id. */
  provenance?: { kind: string, generation: number, app?: string }
  character_id?: string
  session_id?: string
}

export type LookResult
  = | CurrentWorld
    | { status: 'too-soon', retry_after_ms: number }

/**
 * Owns screen perception next to the gateway: privacy gate, capture ownership, routed vision, and world state.
 *
 * Lifecycle: the constructor starts the capture backend. {@link CompanionPerception.attach} builds the vision chain
 * on the gateway's router after the gateway listens, and starts periodic capture only when `ambient` is on.
 * {@link CompanionPerception.shutdown} stops capture and awaits the backend, before the gateway and memory close.
 *
 * Call stack:
 *
 * main (../bin/run)
 *   -> CompanionRuntime.open (./runtime) -> {@link CompanionPerception}
 *   -> startGateway (../server) -> CompanionRuntime.attach -> {@link CompanionPerception.attach}
 *     -> PerceptionService.start (../perception/service)
 */
export class CompanionPerception {
  private readonly gate: PrivacyGate
  private readonly capture: OwnedScreenCapture
  private readonly now: () => number
  private policy: PrivacyPolicy
  private service?: PerceptionService
  private lastManualAt = Number.NEGATIVE_INFINITY
  private readonly events: PerceptionEventRecord[] = []
  private eventCount = 0
  private closed = false

  constructor(private readonly options: CompanionPerceptionOptions) {
    const { config, backend } = options
    this.now = options.now ?? Date.now
    this.policy = {
      excluded_apps: config.privacy.excludedApps,
      excluded_windows: config.privacy.excludedWindows,
      limited_apps: config.privacy.limitedApps,
    }
    this.gate = new PrivacyGate(this.policy)
    this.capture = new OwnedScreenCapture(backend)
    backend.onSourceChange?.(available => this.capture.sourceChanged(available))
    backend.start?.()
  }

  get attached(): boolean {
    return this.service !== undefined
  }

  /** Builds vision on the gateway's router. Every vision request then shares its profile, quota ledger, and health. */
  attach(runtime: GatewayRuntime): void {
    if (this.closed || this.service)
      return
    const { config } = this.options
    const adapter = new RoutedVisionAdapter({ runtime, alias: config.visionAlias, allowLocal: config.allowLocalFallback })
    const vision = new VisionChain({
      profile: runtime.config.profile,
      adapters: [adapter],
      allow_local_fallback: config.allowLocalFallback,
      attempt_timeout_ms: config.attemptTimeoutMs,
      now: this.now,
    })
    const events: PerceptionEventPort = { publish: ({ world }) => this.record(world) }
    this.service = new PerceptionService({ capture: this.capture, privacy: this.gate, vision, events, now: this.now }, {
      ttl_ms: config.ttlMs,
      vision_timeout_ms: config.visionTimeoutMs,
      scheduler: { minimum_interval_ms: config.minimumIntervalMs, maximum_idle_refresh_ms: config.maximumIdleRefreshMs },
    })
    if (config.ambient)
      this.service.start(config.captureIntervalMs)
  }

  /** Current world state. Freshness is decided at this call: expired facts come back as `stale`. */
  current(): CurrentWorld {
    return this.service?.current() ?? { status: 'unavailable' }
  }

  /**
   * Captures and observes now, for the `look_now` tool. `authorizeUnknown` lets this one request upload an
   * unclassified window. It never overrides a pause, an excluded app or window, or a sensitive, private, or locked screen.
   */
  async lookNow(authorizeUnknown: boolean, signal?: AbortSignal): Promise<LookResult> {
    if (!this.service || this.closed)
      return { status: 'unavailable' }
    const elapsed = this.now() - this.lastManualAt
    if (elapsed < MANUAL_GAP_MS) {
      // The last manual observation answers a repeated call while it is still fresh. Its freshness is checked now.
      const world = this.service.current()
      if (world.status === 'fresh' && world.observation.captured_at >= this.lastManualAt)
        return world
      return { status: 'too-soon', retry_after_ms: MANUAL_GAP_MS - elapsed }
    }
    this.lastManualAt = this.now()
    return this.service.look_now({ authorize_unknown: authorizeUnknown }, signal)
  }

  /** Pausing revokes in-flight captures and uploads and clears the current facts. */
  setPaused(paused: boolean): void {
    this.policy = { ...this.policy, paused }
    this.gate.update(this.policy)
  }

  /** Numbers and states only. It holds no screen text, app name, or window title. */
  status(): { enabled: true, attached: boolean, ambient: boolean, paused: boolean, memoryPolicy: typeof PERCEPTION_MEMORY_POLICY, world: { status: CurrentWorld['status'], ageMs?: number, remainingMs?: number }, metrics?: Metrics, events: number } {
    const world = this.current()
    const now = this.now()
    return {
      enabled: true,
      attached: this.attached,
      ambient: this.options.config.ambient,
      paused: this.gate.paused,
      memoryPolicy: PERCEPTION_MEMORY_POLICY,
      world: world.status === 'fresh'
        ? { status: 'fresh', ageMs: now - world.observation.captured_at, remainingMs: world.observation.valid_until - now }
        : { status: world.status },
      metrics: this.service?.metrics(),
      events: this.eventCount,
    }
  }

  /** Newest last. Each record is a copy. */
  recentEvents(): PerceptionEventRecord[] {
    return this.events.map(event => ({ ...event, provenance: event.provenance && { ...event.provenance } }))
  }

  /** Stops periodic capture, revokes in-flight work, and awaits the backend shutdown. */
  async shutdown(): Promise<void> {
    if (this.closed)
      return
    this.closed = true
    if (this.service)
      await this.service.shutdown()
    else
      await this.capture.shutdown()
  }

  /**
   * The perception-to-memory seam. With policy `none` it keeps metadata in memory and never calls the memory store,
   * so routine screens, repeated frames, and screenshots never become durable memory.
   */
  private record(world: CurrentWorld): void {
    const active = this.options.activeTurn?.()
    const record: PerceptionEventRecord = { status: world.status, published_at: this.now(), character_id: active?.characterId, session_id: active?.sessionId }
    if (world.status === 'fresh') {
      const { observation } = world
      record.observation_id = observation.observation_id
      record.captured_at = observation.captured_at
      record.confidence = observation.confidence
      record.provenance = { kind: observation.source.kind, generation: observation.source.generation, app: observation.source.foreground_app }
    }
    this.eventCount++
    this.events.push(record)
    if (this.events.length > MAX_EVENT_RECORDS)
      this.events.shift()
  }
}
