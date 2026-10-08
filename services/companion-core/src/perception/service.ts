import type { CurrentWorld, FailureStatus, Metrics, PerceptionEventPort, ScreenCapturePort, ScreenFrame } from './ports/contracts'
import type { ManualAuthorization, PrivacyGate } from './privacy/gate'
import type { ScheduleOptions } from './scheduler/scheduler'
import type { VisionChain } from './vision/chain'

import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

import { releaseFrame } from './capture/owner'
import { validateFrame } from './capture/validation'
import { ChangeDetector } from './change-detection/detector'
import { PerceptionFailure, withDeadline } from './ports/failure'
import { Scheduler } from './scheduler/scheduler'
import { WorldState } from './world-state/store'

export interface PerceptionPorts {
  capture: ScreenCapturePort
  privacy: PrivacyGate
  vision: VisionChain
  events?: PerceptionEventPort
  now?: () => number
}

export interface PerceptionOptions {
  /** @default 15000 */
  ttl_ms?: number
  /** @default 3000 */
  capture_timeout_ms?: number
  /** @default 10000 */
  vision_timeout_ms?: number
  /** @default 2000 */
  maximum_frame_age_ms?: number
  scheduler?: ScheduleOptions
}

/**
 * Owns the persistent perception lifecycle. A request epoch wins only while its source and policy remain unchanged.
 * Cancellation bounds waiting. Superseded adapters cannot commit state even when they ignore their AbortSignal.
 *
 * Call stack:
 * tick / look_now
 *   -> capture -> privacy -> change detection -> scheduler
 *   -> VisionChain -> validated facts -> WorldState -> PerceptionEventPort
 */
export class PerceptionService {
  private readonly detector = new ChangeDetector()
  private readonly world = new WorldState()
  private readonly scheduler: Scheduler
  private readonly now: () => number
  private readonly options: Required<Omit<PerceptionOptions, 'scheduler'>>
  private readonly counters: Metrics = { captures: 0, vision_requests: 0, observations: 0, privacy_blocks: 0, duplicates: 0, capture_ms: 0, detection_ms: 0, observation_ms: 0, event_failures: 0 }
  private epoch = 0
  private active?: { epoch: number, controller: AbortController }
  private closed = false
  private timer?: ReturnType<typeof setTimeout>
  private running = false
  private lastSuccess?: number
  private published?: string
  private readonly unsubscribe: (() => void)[]

  constructor(private readonly ports: PerceptionPorts, options: PerceptionOptions = {}) {
    this.now = ports.now ?? Date.now
    this.options = { ttl_ms: options.ttl_ms ?? 15000, capture_timeout_ms: options.capture_timeout_ms ?? 3000, vision_timeout_ms: options.vision_timeout_ms ?? 10000, maximum_frame_age_ms: options.maximum_frame_age_ms ?? 2000 }
    if (Object.values(this.options).some(value => !Number.isFinite(value) || value <= 0))
      throw new Error('Invalid perception timing')
    this.scheduler = new Scheduler(options.scheduler)
    this.unsubscribe = [
      ports.privacy.subscribe(() => {
        this.detector.reset()
        this.revoke('blocked-by-privacy')
      }),
      ports.capture.subscribe(() => {
        this.detector.reset()
        this.revoke('unavailable')
      }),
    ]
  }

  current(): CurrentWorld { return this.world.query(this.now()) }
  metrics(): Metrics { return { ...this.counters } }

  /** Periodic capture starts once. Its timer schedules after completion and never forces a vision request. */
  start(captureIntervalMs = 1000): void {
    if (!Number.isFinite(captureIntervalMs) || captureIntervalMs < 100)
      throw new Error('Invalid capture interval')
    if (this.closed || this.running)
      return
    this.running = true
    const run = async () => {
      await this.tick()
      if (this.running && !this.closed)
        this.timer = setTimeout(run, captureIntervalMs)
    }
    void run()
  }

  /** An ambient tick never competes with an active request. */
  tick(): Promise<CurrentWorld> {
    if (this.active)
      return Promise.resolve(this.current())
    return this.request(false)
  }

  /** Manual requests require a fresh capture. Unknown-context authorization applies only to this invocation. */
  look_now(authorization: ManualAuthorization = {}, signal?: AbortSignal): Promise<CurrentWorld> {
    return this.request(true, { ...authorization }, signal)
  }

  async shutdown(): Promise<void> {
    if (this.closed)
      return
    this.closed = true
    this.running = false
    if (this.timer)
      clearTimeout(this.timer)
    for (const unsubscribe of this.unsubscribe) unsubscribe()
    this.revoke('unavailable')
    await withDeadline(() => this.ports.capture.shutdown(), new AbortController().signal, this.options.capture_timeout_ms).catch(() => {})
  }

  private revoke(status: FailureStatus): void {
    this.epoch++
    this.active?.controller.abort()
    this.active = undefined
    this.invalidate(status)
    this.publish()
  }

  private invalidate(status: FailureStatus): void {
    this.detector.reset()
    this.world.invalidate(status)
  }

  private publish(): void {
    const world = this.current()
    const key = world.status === 'fresh' ? `fresh:${world.observation.observation_id}` : world.status
    if (key === this.published)
      return
    try {
      this.ports.events?.publish({ type: 'current-world', world })
      this.published = key
    }
    catch { this.counters.event_failures++ }
  }

  private async request(manual: boolean, authorization?: ManualAuthorization, externalSignal?: AbortSignal): Promise<CurrentWorld> {
    if (this.closed)
      return { status: 'unavailable' }
    if (this.ports.privacy.paused) {
      this.revoke('blocked-by-privacy')
      return this.current()
    }
    if (!this.ports.capture.isAvailable()) {
      this.revoke('unavailable')
      return this.current()
    }
    this.active?.controller.abort()
    const epoch = ++this.epoch
    const controller = new AbortController()
    const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal
    this.active = { epoch, controller }
    const revision = this.ports.privacy.revision
    const startedAt = this.now()
    let captured: ScreenFrame | undefined
    let stage: 'capture' | 'vision' = 'capture'
    const owns = () => epoch === this.epoch && !this.closed && !signal.aborted
    const guard = () => {
      if (!owns())
        throw new PerceptionFailure('cancelled')
      if (!this.ports.capture.isAvailable())
        throw new PerceptionFailure('source-lost')
      if (revision !== this.ports.privacy.revision || !captured || this.ports.privacy.evaluate(captured, manual ? authorization : undefined).state !== 'ALLOW')
        throw new PerceptionFailure('privacy')
    }
    try {
      const captureStart = performance.now()
      captured = await withDeadline(captureSignal => this.ports.capture.capture(captureSignal), signal, this.options.capture_timeout_ms, releaseFrame)
      this.counters.capture_ms += performance.now() - captureStart
      this.counters.captures++
      if (!owns())
        return { status: 'unavailable' }
      validateFrame(captured)
      if (captured.captured_at < startedAt || captured.captured_at > this.now() || this.now() - captured.captured_at > this.options.maximum_frame_age_ms)
        throw new PerceptionFailure('stale-capture')
      if (revision !== this.ports.privacy.revision || this.ports.privacy.evaluate(captured, manual ? authorization : undefined).state !== 'ALLOW') {
        this.counters.privacy_blocks++
        this.invalidate('blocked-by-privacy')
        this.publish()
        return this.current()
      }
      const detectionStart = performance.now()
      const change = this.detector.inspect(captured)
      this.counters.detection_ms += performance.now() - detectionStart
      if (change.duplicate)
        this.counters.duplicates++
      if (change.duplicate)
        this.world.restore()
      if (change.protected) {
        this.invalidate('unavailable')
        this.publish()
        return this.current()
      }
      if (!change.duplicate && (change.level === 'major' || change.level === 'meaningful'))
        this.world.suspend()
      const decision = this.scheduler.decide({ now: this.now(), available: true, allowed: true, level: change.level, duplicate: change.duplicate, manual, last_success_at: this.lastSuccess })
      if (decision !== 'vision-request') {
        this.publish()
        return this.current()
      }
      stage = 'vision'
      this.scheduler.attempted(this.now())
      const visionStart = performance.now()
      const facts = await withDeadline(visionSignal => this.ports.vision.observe(captured!, visionSignal, guard, () => {
        this.counters.vision_requests++
      }), signal, this.options.vision_timeout_ms)
      this.counters.observation_ms += performance.now() - visionStart
      guard()
      const accepted = this.world.accept({ ...facts, observation_id: randomUUID(), captured_at: captured.captured_at, valid_until: captured.captured_at + this.options.ttl_ms, source: structuredClone(captured.source) }, this.now(), epoch)
      if (!accepted)
        throw new PerceptionFailure('stale-capture')
      this.detector.accept(change.signature)
      this.lastSuccess = this.now()
      this.counters.observations++
      this.publish()
      return this.current()
    }
    catch (error) {
      if (epoch !== this.epoch || this.closed)
        return this.current().status === 'blocked-by-privacy' ? { status: 'blocked-by-privacy' } : { status: 'unavailable' }
      if (signal.aborted) {
        this.invalidate('unavailable')
      }
      else if (error instanceof PerceptionFailure && error.code === 'privacy') {
        this.invalidate('blocked-by-privacy')
      }
      else {
        this.invalidate(stage === 'capture' ? 'capture-failed' : 'vlm-failed')
        if (stage === 'vision')
          this.scheduler.failed(this.now(), error instanceof PerceptionFailure ? error.retry_after_ms : undefined)
      }
      this.publish()
      return this.current()
    }
    finally {
      if (captured)
        releaseFrame(captured)
      if (this.active?.epoch === epoch)
        this.active = undefined
    }
  }
}
