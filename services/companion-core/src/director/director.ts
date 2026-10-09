import type { MemoryItem } from '../memory/ports'
import type { Admission, Continuity, Decision, DecisionAction, DecisionReason, DirectorClock, DirectorConfiguration, DirectorMetrics, DirectorOptions, DirectorStatus, EffectGuard, SpeechIntent, VisualIntent } from './contracts'
import type { QueuedEvent } from './ingress'
import type { Candidate } from './salience'

import { randomUUID } from 'node:crypto'

import * as v from 'valibot'

import { isCurrentMemory, selectMemories } from './continuity'
import { directorLimits } from './contracts'
import { configurationSchema, eventSchema, identitySchema, reasoningResultSchema } from './ingress'
import { SalienceState } from './salience'
import { AttentionState, EnergyState, MoodState } from './state'

interface Job {
  outputId: string
  controller: AbortController
  cancelTimer: () => void
  validUntil: number
  generation: number
  modality?: 'speech' | 'visual' | 'record'
  watchRevision?: number
  memorySupport?: Array<Pick<MemoryItem, 'id' | 'updatedAt'>>
  screenSupport?: { key: string, capturedAt: number }
}

export const defaultConfiguration: DirectorConfiguration = {
  enabled: true,
  proactiveSpeech: false,
  quietMode: false,
  privateMode: false,
  reactionFrequency: 'low',
  reasoningEnabled: false,
  utcOffsetMinutes: 0,
  quietPeriods: [],
}

const systemClock: DirectorClock = {
  now: Date.now,
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs)
    timer.unref?.()
    return () => clearTimeout(timer)
  },
}

/**
 * Owns bounded, ephemeral cognition for one identity. Ports own wording, rendering, persistence, and routing.
 * Submit interrupts speech before queue admission. Flush and advance perform bounded local work.
 * Cancel aborts work and clears candidates. Dispose is terminal. Neither method disposes external services.
 * Non-cooperative ports keep one quarantined lane until their promise settles, preventing unbounded retries.
 */
export class Director {
  private readonly clock: DirectorClock
  private readonly options: DirectorOptions
  private configuration: DirectorConfiguration
  private readonly attention = new AttentionState()
  private readonly salience = new SalienceState()
  private readonly mood: MoodState
  private readonly energy: EnergyState
  private readonly queue: QueuedEvent[] = []
  private readonly seen = new Map<string, number>()
  private readonly history: Decision[] = []
  private readonly speechWindow: number[] = []
  private readonly visualWindow: number[] = []
  private readonly reasoningWindow: number[] = []
  private readonly metrics: DirectorMetrics = { accepted: 0, invalid: 0, stale: 0, duplicates: 0, overflow: 0, suppressed: 0, decisions: 0, speechAttempts: 0, visualAttempts: 0, recordAttempts: 0, reasoningAttempts: 0, recallAttempts: 0, failures: 0, cancellations: 0 }
  private lastSpeech = -Infinity
  private lastVisual = -Infinity
  private lastReasoning = -Infinity
  private lastNow: number
  private generation = 0
  private disposed = false
  private output?: Job
  private visualLease?: Job
  private recall?: Job
  private reasoning?: Job
  private memories: MemoryItem[] = []
  private memoryUntil = 0

  constructor(options: DirectorOptions) {
    const identity = v.parse(identitySchema, options.identity)
    this.options = { ...options, identity }
    this.clock = options.clock ?? systemClock
    this.lastNow = this.clock.now()
    if (!Number.isSafeInteger(this.lastNow) || this.lastNow < 0)
      throw new Error('Invalid Director clock')
    this.configuration = v.parse(configurationSchema, { ...defaultConfiguration, ...options.configuration, proactiveSpeech: false })
    this.mood = new MoodState(this.lastNow)
    this.energy = new EnergyState(this.lastNow)
  }

  /** Validates and projects before retention. Callers never send control commands through this evidence boundary. */
  submit(input: unknown): Admission {
    if (this.disposed || !this.configuration.enabled || this.configuration.privateMode)
      return 'disabled'
    const result = v.safeParse(eventSchema, input)
    if (!result.success) {
      this.metrics.invalid++
      return 'invalid'
    }
    const event = result.output
    if (event.identity.userId !== this.options.identity.userId || event.identity.characterId !== this.options.identity.characterId)
      return 'wrong-identity'
    const now = this.now()
    this.prune(now)
    if (!this.fresh(event, now)) {
      this.metrics.stale++
      return 'stale'
    }
    if (this.seen.has(event.id)) {
      this.metrics.duplicates++
      return 'duplicate'
    }
    this.seen.set(event.id, now + 300000)
    if (this.seen.size > directorLimits.eventIds)
      this.seen.delete(this.seen.keys().next().value!)
    if (event.type === 'speech') {
      if (!this.attention.accept(event)) {
        this.metrics.stale++
        return 'stale'
      }
      const ownedSpeech = event.speaker === 'companion' && this.output?.modality === 'speech'
        && this.live(this.output) && this.attention.ownsCompanionSpeech(this.output.outputId, now)
      if (event.active && !ownedSpeech) {
        this.abort(this.output)
        this.abort(this.reasoning)
        this.queue.length = 0
        this.salience.clear()
        this.cancelVisual()
      }
    }
    if (event.type === 'screen') {
      if (!this.attention.accept(event)) {
        this.metrics.stale++
        return 'stale'
      }
      this.salience.discardScreen()
      this.revalidateOutput(now)
    }
    if (event.type === 'memory-invalidated' || (event.type === 'record' && event.kind === 'correction'
      && event.provenance.attribution === 'user_said' && !event.provenance.invalidated && event.provenance.occurredAt <= now)) {
      this.invalidateMemory()
    }
    if (this.queue.length >= directorLimits.queue) {
      this.metrics.overflow++
      return 'overflow'
    }
    this.queue.push(event)
    this.metrics.accepted++
    return 'accepted'
  }

  /** Returns at most the requested hard-bounded batch of content-free decisions. */
  flush(limit = directorLimits.flush): Decision[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > directorLimits.queue)
      throw new Error('Invalid Director flush limit')
    const decisions: Decision[] = []
    for (let i = 0; i < limit && this.queue.length; i++) {
      const event = this.queue.shift()!
      const now = this.now()
      if (!this.fresh(event, now)) {
        this.metrics.stale++
        decisions.push(this.note('DO_NOTHING', 'stale-evidence', now, event.type))
        continue
      }
      if (event.type !== 'speech' && event.type !== 'screen' && !this.attention.accept(event)) {
        this.metrics.stale++
        decisions.push(this.note('DO_NOTHING', 'stale-evidence', now, event.type))
        continue
      }
      if (event.type === 'screen' && event.world.status === 'fresh'
        && !this.attention.screenCurrent({ key: event.observationKey, capturedAt: event.world.observation.captured_at }, now)) {
        decisions.push(this.note('DO_NOTHING', 'stale-evidence', now, event.type))
        continue
      }
      const offered = this.salience.offerEvent(event, now)
      if (offered !== 'suppressed' && (event.type === 'conversation' || offered === 'added'))
        this.mood.accept(event, now)
      else
        this.mood.advance(now)
      this.energy.current(this.attention.current(now), now)
      if (event.type === 'recall') {
        decisions.push(this.startRecall(event, now))
        continue
      }
      if (event.type === 'memory-invalidated') {
        decisions.push(this.note('DO_NOTHING', 'memory-invalidated', now, event.type))
        continue
      }
      if (offered === 'suppressed')
        this.metrics.suppressed++
      this.revalidateOutput(now)
      decisions.push(this.decide(now))
    }
    return decisions
  }

  /** Advances evidence expiry and at most one existing intention. Elapsed idle time creates no new intention. */
  advance(): Decision {
    const now = this.now()
    this.prune(now)
    this.mood.advance(now)
    this.energy.current(this.attention.current(now), now)
    this.revalidateOutput(now)
    return this.decide(now)
  }

  /** Only explicit user control can enable proactive speech. Configuration snapshots cannot mutate runtime state. */
  configure(patch: Partial<DirectorConfiguration>, authority: 'user' | 'system'): boolean {
    if (this.disposed || (patch.proactiveSpeech === true && authority !== 'user'))
      return false
    const result = v.safeParse(configurationSchema, { ...this.configuration, ...patch })
    if (!result.success)
      return false
    this.configuration = result.output
    this.abort(this.output)
    this.abort(this.reasoning)
    this.cancelVisual()
    if (!this.configuration.enabled || this.configuration.privateMode) {
      this.cancel()
      this.attention.clear()
      this.memories = []
      this.memoryUntil = 0
      this.note('DO_NOTHING', this.configuration.privateMode ? 'private-mode' : 'disabled', this.now())
    }
    return true
  }

  /** Cancels owned work and queues. New events are allowed unless disabled, private, or disposed. */
  cancel(): void {
    this.generation++
    this.metrics.cancellations++
    this.abort(this.output)
    this.abort(this.recall)
    this.abort(this.reasoning)
    this.cancelVisual()
    this.queue.length = 0
    this.salience.clear()
    this.note('DO_NOTHING', 'cancelled', this.now())
  }

  dispose(): void {
    if (this.disposed)
      return
    this.cancel()
    this.disposed = true
    this.attention.clear()
    this.memories = []
    this.seen.clear()
    this.note('DO_NOTHING', 'disposed', this.now())
  }

  /** Returns only current R4 evidence. No relationship, plan, promise, or experience is synthesized. */
  continuity(): Continuity {
    const now = this.now()
    if (now >= this.memoryUntil || this.configuration.privateMode || this.disposed)
      this.memories = []
    const items = this.memories.filter(item => isCurrentMemory(item, this.options.identity, now))
    return structuredClone({ items, openThreads: items.filter(item => ['promise', 'open_thread'].includes(item.category)), plans: items.filter(item => item.category === 'goal'), relationships: items.filter(item => item.kind === 'relationship' || item.category === 'relationship') })
  }

  status(): DirectorStatus {
    const now = this.now()
    this.prune(now)
    const continuity = this.continuity()
    const mood = this.mood.snapshot(now)
    const attention = this.attention.current(now)
    return {
      configuration: structuredClone(this.configuration),
      attention,
      ...mood,
      energy: this.energy.current(attention, now),
      continuity: { items: continuity.items.length, openThreads: continuity.openThreads.length, plans: continuity.plans.length, relationships: continuity.relationships.length },
      lastDecision: this.history.length ? { ...this.history[this.history.length - 1] } : undefined,
      metrics: { ...this.metrics },
      resources: { queue: this.queue.length, eventIds: this.seen.size, ...this.salience.resources(), history: this.history.length, activeOutput: this.output && !this.output.controller.signal.aborted ? 1 : 0, activeVisual: this.visualLease && !this.visualLease.controller.signal.aborted ? 1 : 0, activeRecall: this.recall && !this.recall.controller.signal.aborted ? 1 : 0, activeReasoning: this.reasoning && !this.reasoning.controller.signal.aborted ? 1 : 0, inFlightOutput: this.output ? 1 : 0, inFlightRecall: this.recall ? 1 : 0, inFlightReasoning: this.reasoning ? 1 : 0 },
    }
  }

  private now(): number {
    const value = this.clock.now()
    if (Number.isSafeInteger(value) && value >= this.lastNow)
      this.lastNow = value
    return this.lastNow
  }

  private fresh(event: QueuedEvent, now: number): boolean {
    if (event.observedAt > now || event.observedAt + 30000 <= now)
      return false
    if (event.type === 'screen' && event.world.status === 'fresh') {
      const observation = event.world.observation
      return observation.captured_at <= now && observation.captured_at + 30000 > now && observation.valid_until > now
    }
    if (event.type === 'watch' && event.snapshot.status === 'watching')
      return event.snapshot.valid_until !== undefined && event.snapshot.valid_until > now
    return true
  }

  private decide(now: number): Decision {
    if (this.disposed || !this.configuration.enabled || this.configuration.privateMode)
      return this.note('DO_NOTHING', this.disposed ? 'disposed' : this.configuration.privateMode ? 'private-mode' : 'disabled', now)
    const candidate = this.salience.best(now)
    if (!candidate)
      return this.note('DO_NOTHING', 'no-salient-event', now)
    if (candidate.screenSupport && !this.attention.screenCurrent(candidate.screenSupport, now)) {
      this.salience.remove(candidate)
      return this.note('DO_NOTHING', 'stale-evidence', now, candidate.origin, candidate.score)
    }
    if (candidate.mode === 'follow-up' && (!candidate.memorySupport?.length || !this.memoriesCurrent(candidate.memorySupport, now))) {
      this.salience.remove(candidate)
      return this.note('DO_NOTHING', 'stale-evidence', now, candidate.origin, candidate.score)
    }
    const wait = (reason: DecisionReason) => this.note('WAIT', reason, now, candidate.origin, candidate.score)
    if (candidate.mode === 'record') {
      if (this.output)
        return wait('output-busy')
      if (!this.options.record) {
        this.salience.remove(candidate)
        return wait('output-unavailable')
      }
      this.salience.remove(candidate)
      this.metrics.recordAttempts++
      this.startOutput(candidate, 'record', now)
      return this.note('REMEMBER', 'record-candidate', now, candidate.origin, candidate.score)
    }
    const blocked = this.blocked(candidate, now)
    if (blocked)
      return wait(blocked)
    if (candidate.mode === 'reason')
      return this.startReasoning(candidate, now)
    if (this.output)
      return wait('output-busy')
    let modality: 'speech' | 'visual' = candidate.mode === 'respond' || candidate.mode === 'continue' || candidate.mode === 'follow-up' ? 'speech' : 'visual'
    if (modality === 'speech' && candidate.mode !== 'respond' && !this.configuration.proactiveSpeech)
      modality = 'visual'
    const attention = this.attention.current(now)
    if (modality === 'speech') {
      if (attention.watching && attention.dialogue !== 'gap')
        return wait('media-dialogue')
      if (candidate.mode !== 'respond') {
        if (attention.working)
          return wait('working')
        if (now - this.lastSpeech < 180000)
          return wait('cooldown')
        if (this.speechWindow.length >= 4)
          return wait('hourly-limit')
      }
      if (!this.options.speech && !candidate.watch) {
        this.salience.remove(candidate)
        return wait('output-unavailable')
      }
    }
    else {
      if (this.configuration.reactionFrequency === 'off')
        return wait('frequency-off')
      const interval = this.configuration.reactionFrequency === 'low' ? 30000 : 15000
      if (now - this.lastVisual < interval)
        return wait('cooldown')
      if (this.visualWindow.length >= (this.configuration.reactionFrequency === 'low' ? 20 : 60))
        return wait('hourly-limit')
    }
    if (attention.watching || candidate.watch) {
      const watch = this.attention.currentWatch(now)
      if (!this.options.watch || !watch || watch.perception_blocked) {
        this.salience.remove(candidate)
        return wait('output-unavailable')
      }
      if (candidate.watch && candidate.watch.revision !== watch.revision) {
        this.salience.remove(candidate)
        return wait('stale-evidence')
      }
      candidate.watch ??= { kind: 'shared-moment', observation_key: candidate.key, observed_at: candidate.observedAt, revision: watch.revision, salience: Math.max(0.75, candidate.score) }
    }
    else if (modality === 'visual' && !this.options.visual) {
      this.salience.remove(candidate)
      return wait('output-unavailable')
    }
    this.salience.remove(candidate)
    if (modality === 'speech') {
      this.metrics.speechAttempts++
      if (candidate.mode !== 'respond') {
        this.speechWindow.push(now)
        this.lastSpeech = now
      }
    }
    else {
      this.metrics.visualAttempts++
      this.visualWindow.push(now)
      this.lastVisual = now
    }
    this.startOutput(candidate, modality, now)
    return this.note(modality === 'speech' ? 'SPEAK' : 'SILENT_VISUAL_REACTION', modality === 'visual' ? 'visual-reaction' : candidate.mode === 'respond' ? 'direct-request' : candidate.mode === 'follow-up' ? 'follow-up' : 'continuation', now, candidate.origin, candidate.score)
  }

  private blocked(candidate: Candidate, now: number, outputId?: string): DecisionReason | undefined {
    if (this.configuration.quietMode)
      return 'quiet-mode'
    if (this.quiet(now))
      return 'quiet-period'
    const attention = this.attention.current(now)
    if (attention.userSpeaking)
      return 'user-speaking'
    if (attention.companionSpeaking && !this.attention.ownsCompanionSpeech(outputId, now))
      return 'companion-speaking'
    if (attention.typing)
      return 'typing'
    if (attention.activity === 'absent')
      return 'absent'
    if (attention.activity === 'unknown' && candidate.mode !== 'respond')
      return 'presence-unknown'
    return undefined
  }

  private quiet(now: number): boolean {
    const minute = ((Math.floor(now / 60000) + this.configuration.utcOffsetMinutes) % 1440 + 1440) % 1440
    return this.configuration.quietPeriods.some(p => p.startMinute === p.endMinute || (p.startMinute < p.endMinute ? minute >= p.startMinute && minute < p.endMinute : minute >= p.startMinute || minute < p.endMinute))
  }

  private startOutput(candidate: Candidate, modality: 'speech' | 'visual' | 'record', now: number): void {
    const watch = candidate.watch && this.attention.currentWatch(now)
    const speechEvidence = modality === 'speech' ? this.continuity().items : []
    const memoryDeadline = speechEvidence.length ? Math.min(this.memoryUntil, ...speechEvidence.map(item => item.validTo ?? Infinity)) : Infinity
    const evidenceUntil = watch ? Math.min(watch.valid_until!, watch.playback!.valid_until, modality === 'speech' ? watch.dialogue_valid_until ?? now : candidate.validUntil) : candidate.validUntil
    const job = this.job(Math.min(memoryDeadline, evidenceUntil, candidate.validUntil, now + (modality === 'visual' && !candidate.watch ? 6000 : directorLimits.outputDeadlineMs)), () => {
      this.metrics.cancellations++
      this.note('WAIT', 'output-expired', this.now(), candidate.origin, candidate.score)
      this.cancelVisual()
    })
    job.modality = modality
    job.watchRevision = candidate.watch?.revision
    job.memorySupport = speechEvidence.length ? speechEvidence.map(({ id, updatedAt }) => ({ id, updatedAt })) : undefined
    job.screenSupport = candidate.screenSupport
    this.output = job
    const guard = (): boolean => {
      const attention = this.attention.current(this.now())
      const watch = this.attention.currentWatch(this.now())
      const owns = this.output === job || this.visualLease === job
      const mediaValid = candidate.watch ? watch?.revision === candidate.watch.revision : !attention.watching
      const memoryValid = (!candidate.memorySupport || this.memoriesCurrent(candidate.memorySupport, this.now())) && (!job.memorySupport || this.memoriesCurrent(job.memorySupport, this.now()))
      const screenValid = !candidate.screenSupport || this.attention.screenCurrent(candidate.screenSupport, this.now())
      return owns && this.live(job) && memoryValid && screenValid && (modality === 'record' || (mediaValid && !this.blocked(candidate, this.now(), modality === 'speech' ? job.outputId : undefined) && (modality !== 'speech' || !attention.watching || attention.dialogue === 'gap')))
    }
    const effect: EffectGuard = { signal: job.controller.signal, validUntil: job.validUntil, guard }
    void Promise.resolve().then(async () => {
      if (!guard())
        return 'cancelled'
      if (modality === 'record')
        return this.options.record!.offer({ ...candidate.record!, signal: effect.signal, guard })
      if (candidate.watch)
        return this.options.watch!.offerReaction({ ...effect, candidate: { ...candidate.watch }, modality, affect: candidate.affect, speech: modality === 'speech' ? this.speechIntent(candidate, job.outputId, speechEvidence) : undefined })
      if (modality === 'visual') {
        const result = this.options.visual!.request(this.visualIntent(candidate, effect))
        if (result === 'started')
          this.visualLease = job
        return result
      }
      return this.options.speech!.deliver({ ...effect, ...this.speechIntent(candidate, job.outputId, speechEvidence) })
    }).then((result) => {
      if (this.live(job) && ['declined', 'blocked', 'unsupported', 'cancelled'].includes(result))
        this.note('WAIT', 'output-declined', this.now(), candidate.origin, candidate.score)
    }).catch(() => {
      if (this.live(job)) {
        this.metrics.failures++
        this.note('WAIT', 'output-failed', this.now(), candidate.origin, candidate.score)
      }
    }).finally(() => {
      if (this.visualLease !== job)
        job.cancelTimer()
      if (this.output === job)
        this.output = undefined
    })
  }

  private speechIntent(candidate: Candidate, outputId: string, evidence: MemoryItem[]): Pick<SpeechIntent, 'outputId' | 'identity' | 'intent' | 'requestId' | 'tone' | 'evidence'> {
    return { outputId, identity: { ...this.options.identity }, intent: candidate.mode === 'respond' ? 'respond-user' : candidate.mode === 'follow-up' ? 'follow-up' : 'continue-conversation', requestId: candidate.requestId, tone: this.mood.snapshot(this.now()).mood.tone, evidence }
  }

  private memoriesCurrent(support: ReadonlyArray<Pick<MemoryItem, 'id' | 'updatedAt'>>, now: number): boolean {
    return now < this.memoryUntil && support.every(edge => this.memories.some(item => item.id === edge.id && item.updatedAt === edge.updatedAt && isCurrentMemory(item, this.options.identity, now)))
  }

  private visualIntent(candidate: Candidate, effect: EffectGuard): VisualIntent {
    const activity = this.attention.current(this.now())
    return { ...effect, behavior: candidate.affect, activity: activity.watching ? 'watching' : activity.activity === 'conversation' ? 'listening' : 'idle', intensity: this.configuration.reactionFrequency === 'normal' ? 'normal' : 'calm' }
  }

  private revalidateOutput(now: number): void {
    const activity = this.attention.current(now)
    if (this.visualLease && ((this.visualLease.screenSupport && !this.attention.screenCurrent(this.visualLease.screenSupport, now)) || activity.userSpeaking || activity.companionSpeaking || activity.typing || activity.watching || activity.activity === 'absent' || this.configuration.quietMode || this.quiet(now)))
      this.cancelVisual()
    if (!this.output || this.output.controller.signal.aborted)
      return
    if (this.output.modality === 'record')
      return
    if ((this.output.memorySupport && !this.memoriesCurrent(this.output.memorySupport, now))
      || (this.output.screenSupport && !this.attention.screenCurrent(this.output.screenSupport, now))) {
      this.abort(this.output)
      this.cancelVisual()
      return
    }
    const watch = this.attention.currentWatch(now)
    const changedWatch = this.output.watchRevision !== undefined ? watch?.revision !== this.output.watchRevision : activity.watching
    const companionBlocks = activity.companionSpeaking && (this.output.modality !== 'speech' || !this.attention.ownsCompanionSpeech(this.output.outputId, now))
    if (activity.userSpeaking || companionBlocks || activity.typing || activity.activity === 'absent' || changedWatch || (this.output.modality === 'speech' && activity.watching && activity.dialogue !== 'gap') || this.configuration.quietMode || this.quiet(now)) {
      this.abort(this.output)
      this.cancelVisual()
    }
  }

  private startRecall(event: Extract<QueuedEvent, { type: 'recall' }>, now: number): Decision {
    if (!this.options.memory || this.recall)
      return this.note('WAIT', 'memory-unavailable', now, event.type)
    this.metrics.recallAttempts++
    const job = this.job(now + directorLimits.recallDeadlineMs, () => this.note('WAIT', 'memory-unavailable', this.now(), event.type))
    this.recall = job
    void Promise.resolve().then(() => this.live(job) ? this.options.memory!.recall({ ...this.options.identity, query: event.query, maxItems: directorLimits.recallItems, maxBytes: directorLimits.recallBytes, deadlineMs: directorLimits.recallDeadlineMs, asOf: now }) : undefined).then((result) => {
      if (!result || !this.live(job) || result.timedOut)
        return
      const selected = selectMemories(result.items, this.options.identity, this.now())
      this.memories = selected
      this.memoryUntil = this.now() + 300000
      this.revalidateOutput(this.now())
      const supporting = selected.filter(item => ['promise', 'open_thread', 'goal'].includes(item.category))
      if (event.purpose === 'follow-up' && supporting.length) {
        const validUntil = Math.min(now + 30000, this.memoryUntil, ...supporting.map(item => item.validTo ?? Infinity))
        this.salience.add({ key: `memory:${event.requestId}`, score: 0.55, mode: 'follow-up', origin: 'memory', observedAt: now, validUntil, affect: 'curious', requestId: event.requestId, memorySupport: supporting.map(({ id, updatedAt }) => ({ id, updatedAt })) }, this.now())
      }
      this.note('DO_NOTHING', 'memory-refreshed', this.now(), event.type)
    }).catch(() => {
      if (this.live(job)) {
        this.metrics.failures++
        this.note('WAIT', 'memory-unavailable', this.now(), event.type)
      }
    }).finally(() => {
      job.cancelTimer()
      if (this.recall === job)
        this.recall = undefined
    })
    return this.note('WAIT', 'memory-unavailable', now, event.type)
  }

  private invalidateMemory(): void {
    this.generation++
    this.abort(this.recall)
    this.abort(this.output)
    this.abort(this.reasoning)
    this.memories = []
    this.memoryUntil = 0
    this.queue.length = 0
    this.salience.clear()
    this.cancelVisual()
  }

  private startReasoning(candidate: Candidate, now: number): Decision {
    const reason = !this.configuration.reasoningEnabled ? 'reasoning-disabled' : !this.options.reasoning || this.reasoning ? 'reasoning-unavailable' : this.reasoningWindow.length >= 4 || now - this.lastReasoning < 300000 ? 'reasoning-budget' : undefined
    this.salience.remove(candidate)
    if (reason)
      return this.note('WAIT', reason, now, candidate.origin, candidate.score)
    this.reasoningWindow.push(now)
    this.lastReasoning = now
    this.metrics.reasoningAttempts++
    const job = this.job(Math.min(candidate.validUntil, now + directorLimits.reasoningDeadlineMs), () => this.note('WAIT', 'reasoning-unavailable', this.now(), candidate.origin))
    this.reasoning = job
    void Promise.resolve().then(() => this.live(job) ? this.options.reasoning!.reason({ profile: this.options.profile, attention: this.attention.current(now).activity, mood: this.mood.snapshot(now).mood, affect: candidate.affect, salience: candidate.score, signal: job.controller.signal }) : undefined).then((raw) => {
      if (!this.live(job))
        return
      const result = v.safeParse(reasoningResultSchema, raw)
      if (!result.success) {
        this.metrics.failures++
        this.note('WAIT', 'reasoning-unavailable', this.now(), candidate.origin)
      }
      else if (result.output.action === 'visual') {
        this.salience.add({ ...candidate, key: `resolved:${candidate.key}`, mode: 'visual', affect: result.output.affect }, this.now())
      }
      else {
        this.note('WAIT', 'reasoning-wait', this.now(), candidate.origin)
      }
    }).catch(() => {
      if (this.live(job)) {
        this.metrics.failures++
        this.note('WAIT', 'reasoning-unavailable', this.now(), candidate.origin)
      }
    }).finally(() => {
      job.cancelTimer()
      if (this.reasoning === job)
        this.reasoning = undefined
    })
    return this.note('WAIT', 'reasoning-wait', now, candidate.origin, candidate.score)
  }

  private job(validUntil: number, onExpire: () => void): Job {
    const controller = new AbortController()
    const job: Job = { outputId: randomUUID(), controller, validUntil, generation: this.generation, cancelTimer: () => {} }
    job.cancelTimer = this.clock.schedule(Math.max(0, validUntil - this.now()), () => {
      controller.abort()
      onExpire()
    })
    return job
  }

  private live(job: Job): boolean {
    return !this.disposed && this.configuration.enabled && !this.configuration.privateMode && job.generation === this.generation && !job.controller.signal.aborted && job.validUntil > this.now()
  }

  private abort(job?: Job): void {
    if (job && !job.controller.signal.aborted) {
      job.controller.abort()
      job.cancelTimer()
    }
  }

  private cancelVisual(): void {
    this.abort(this.visualLease)
    this.visualLease = undefined
    try {
      this.options.visual?.cancel()
    }
    catch {
      this.metrics.failures++
    }
  }

  private prune(now: number): void {
    for (const [id, until] of this.seen) {
      if (until <= now)
        this.seen.delete(id)
    }
    this.salience.prune(now)
    for (const window of [this.speechWindow, this.visualWindow, this.reasoningWindow]) {
      while (window.length && window[0] + 3600000 <= now)
        window.shift()
    }
  }

  private note(action: DecisionAction, reason: DecisionReason, at: number, origin: Decision['origin'] = 'none', salience = 0): Decision {
    const decision = { action, reason, at, origin, salience }
    this.history.push(decision)
    if (this.history.length > directorLimits.history)
      this.history.shift()
    this.metrics.decisions++
    return { ...decision }
  }
}
