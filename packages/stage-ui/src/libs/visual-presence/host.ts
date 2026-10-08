import type { ExternalVisualActivity, IdleIntensity, VisualActivity, VisualModelAdapter, VisualRequestResult } from '@proj-airi/model-driver-visual'
import type { OutputVisualRequestEvent, OutputVisualStateEvent } from '@proj-airi/server-sdk'
import type { VrmFrameRuntimeContext, VrmFrameRuntimeHook } from '@proj-airi/stage-ui-three/composables/vrm'

import { createVisualBehaviorController, visualBehaviorCatalog } from '@proj-airi/model-driver-visual'
import { createVrmVisualAdapter } from '@proj-airi/model-driver-visual/vrm'

/** The model that the renderer passes to its frame hooks. */
type VRM = Parameters<VrmFrameRuntimeHook>[0]

/** The longest lease that a remote request can hold. */
const MAX_LEASE_MS = 60_000

export type VisualPresenceAdapter = VisualModelAdapter & { flushExpressions: () => void }

export interface VisualPresenceHostOptions {
  /** Source of the model that the stage shows now. Frames of any other source are ignored. */
  modelSrc: () => string | undefined
  modelId: () => string
  /** @default 'normal', the accepted Vivid default */
  intensity?: IdleIntensity
  /** @default performance.now */
  now?: () => number
  /** Receives availability changes, for example for the server channel. */
  onState?: (state: OutputVisualStateEvent) => void
  /** Tests replace the controller clock and the adapter. */
  createController?: () => ReturnType<typeof createVisualBehaviorController>
  createAdapter?: (vrm: VRM, modelId: string) => VisualPresenceAdapter
}

/**
 * Runs the Vivid visual behavior controller inside AIRI's existing VRM renderer.
 *
 * - Ownership: upstream keeps the scene, model, mixer, blink, gaze, springs, ACT, and lip sync. This host samples
 *   poses after the mixer through the VRM frame hook and flushes expressions after ACT and lip sync.
 * - Priority: speaking, ACT, and manual control release procedural motion at once. Listening outranks reactions.
 * - Remote requests: a behavior or base activity with a lease. A cancel removes only the behavior of that request.
 * - Models: a new committed source releases the old adapter before upstream disposes the old model.
 *
 * Call stack:
 *
 * ThreeScene (stage-ui-three) -> VRMModel frame loop
 *   -> {@link VisualPresenceHost.frame} -> controller.update -> adapter.apply
 *   -> {@link VisualPresenceHost.expressionFrame} -> adapter.flushExpressions
 * useStageVisualPresence (../../composables/use-stage-visual-presence)
 *   -> {@link VisualPresenceHost.request} / {@link VisualPresenceHost.cancel}
 */
export class VisualPresenceHost {
  private readonly controller: ReturnType<typeof createVisualBehaviorController>
  private readonly now: () => number
  private readonly intensity: IdleIntensity
  private adapter?: VisualPresenceAdapter
  private bound?: VRM
  private external: ExternalVisualActivity = { speaking: false, act: false, modelMotion: false, userControl: false }
  private speaking = false
  private manualUntil = -Infinity
  private local?: VisualActivity
  private remote?: { requestId: string, activity: VisualActivity, until: number, intensity?: IdleIntensity }
  private owned?: { requestId: string, until: number, cancelAtEnd: boolean }
  private activity: VisualActivity = 'idle'
  private appliedIntensity: IdleIntensity
  private published?: string
  private disposed = false

  constructor(private readonly options: VisualPresenceHostOptions) {
    this.now = options.now ?? (() => performance.now())
    this.intensity = options.intensity ?? 'normal'
    this.appliedIntensity = this.intensity
    this.controller = options.createController?.() ?? createVisualBehaviorController({ now: this.now })
    this.controller.setIdleIntensity(this.intensity)
  }

  /** Pose phase: after mixer sampling, before the humanoid update. */
  readonly frame = (vrm: VRM, _delta: number, context: VrmFrameRuntimeContext): void => {
    if (this.disposed || !context.modelSrc || context.modelSrc !== this.options.modelSrc())
      return
    if (this.bound !== vrm)
      this.bind(vrm)
    this.sync(context)
    this.controller.update(this.now())
  }

  /** Expression phase: after blink, ACT, and lip sync, before the expression manager update. */
  readonly expressionFrame = (vrm: VRM, _delta: number, context: VrmFrameRuntimeContext): void => {
    if (this.disposed || this.bound !== vrm || context.modelSrc !== this.options.modelSrc())
      return
    this.sync(context)
    if (context.actActive || context.lipSyncActive)
      return
    this.adapter?.flushExpressions()
  }

  /** Speech playback owns the model while it plays. */
  setSpeaking(speaking: boolean): void {
    this.speaking = speaking
  }

  /** A manual model action, for example a click on the avatar, owns the model for `durationMs`. */
  noteManualControl(durationMs: number): void {
    this.manualUntil = Math.max(this.manualUntil, this.now() + durationMs)
  }

  /** Local stage activity, for example listening while the user speaks. It outranks remote activity. */
  setLocalActivity(activity: VisualActivity | undefined): void {
    this.local = activity
  }

  /** Starts one remote request. The controller decides admission. Without a loaded model nothing is supported. */
  request(data: OutputVisualRequestEvent): VisualRequestResult {
    if (this.disposed)
      return 'disposed'
    if (!this.adapter)
      return 'unsupported'
    const now = this.now()
    const lease = Math.max(0, Math.min(data.leaseMs, MAX_LEASE_MS))
    if (data.activity || data.intensity)
      this.remote = { requestId: data.requestId, activity: data.activity ?? this.remote?.activity ?? 'idle', until: now + lease, intensity: data.intensity }
    if (!data.behavior) {
      this.applyActivity()
      return 'started'
    }
    this.applyActivity()
    const result = this.controller.playVisualBehavior(data.behavior)
    if (result === 'started') {
      const duration = visualBehaviorCatalog.find(behavior => behavior.id === data.behavior)?.durationMs ?? lease
      this.owned = { requestId: data.requestId, until: now + Math.min(lease, duration), cancelAtEnd: lease < duration }
    }
    return result
  }

  /** Ends one remote request. Another owner's behavior never changes. */
  cancel(requestId: string): void {
    if (this.owned?.requestId === requestId) {
      this.owned = undefined
      this.controller.cancelBehavior()
    }
    if (this.remote?.requestId === requestId) {
      this.remote = undefined
      this.applyActivity()
    }
  }

  /** Releases the model before upstream disposes it, for example on a model or renderer change. */
  release(): void {
    if (!this.bound)
      return
    this.owned = undefined
    this.controller.attach(undefined)
    this.adapter = undefined
    this.bound = undefined
    this.publish()
  }

  /** Sends the current availability again, for example after a channel reconnect. */
  republish(): void {
    this.published = undefined
    this.publish()
  }

  diagnostics(): { available: boolean, blocked: boolean, activity: VisualActivity, ownedRequest: boolean, remoteActivity?: VisualActivity } {
    return { available: !!this.adapter && !this.disposed, blocked: this.blocked(), activity: this.activity, ownedRequest: !!this.owned, remoteActivity: this.remote?.activity }
  }

  dispose(): void {
    if (this.disposed)
      return
    this.release()
    this.disposed = true
    this.controller.dispose()
    this.publish()
  }

  private bind(vrm: VRM): void {
    this.release()
    const adapter = this.options.createAdapter?.(vrm, this.options.modelId()) ?? createVrmVisualAdapter(vrm, { modelId: this.options.modelId(), deferExpressions: true })
    this.adapter = adapter
    this.bound = vrm
    this.controller.attach(adapter)
    this.controller.start()
    this.publish()
  }

  private sync(context: VrmFrameRuntimeContext): void {
    const now = this.now()
    if (this.owned && now >= this.owned.until) {
      if (this.owned.cancelAtEnd)
        this.controller.cancelBehavior()
      this.owned = undefined
    }
    if (this.remote && now >= this.remote.until)
      this.remote = undefined
    const next: ExternalVisualActivity = { speaking: context.lipSyncActive || this.speaking, act: context.actActive, modelMotion: false, userControl: now < this.manualUntil }
    if (next.speaking !== this.external.speaking || next.act !== this.external.act || next.userControl !== this.external.userControl) {
      this.external = next
      this.controller.setExternalActivity(next)
      // A higher owner interrupted the remote behavior. Its cancel later must not touch another behavior.
      if (this.blocked())
        this.owned = undefined
    }
    this.applyActivity()
    this.publish()
  }

  private applyActivity(): void {
    const activity = this.local ?? this.remote?.activity ?? 'idle'
    if (activity !== this.activity) {
      this.activity = activity
      // Changing activity interrupts the current behavior, so a remote behavior ends here too.
      this.owned = undefined
      this.controller.setVisualActivity(activity)
    }
    const intensity = this.remote?.intensity ?? this.intensity
    if (intensity !== this.appliedIntensity) {
      this.appliedIntensity = intensity
      this.controller.setIdleIntensity(intensity)
    }
  }

  private blocked(): boolean {
    return this.external.speaking || this.external.act || this.external.userControl
  }

  private publish(): void {
    const state: OutputVisualStateEvent = { available: !!this.adapter && !this.disposed, blocked: this.blocked() }
    const key = `${state.available}|${state.blocked}`
    if (key === this.published)
      return
    this.published = key
    this.options.onState?.(state)
  }
}
