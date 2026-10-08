import type { DirectorIdentity } from '../../src/director'

import { Director, WatchReactionRelay } from '../../src/director'
import { normalizeVideo } from '../../src/watch/browser'
import { ReactionPolicy } from '../../src/watch/reactions'
import { WatchState } from '../../src/watch/state'
import { VirtualClock } from './virtual-clock'

type Phase = 'conversation' | 'working' | 'watching' | 'idle' | 'absent' | 'return-working' | 'quiet'

/** Content-free synthetic evidence. No transcript, media asset, or private observation enters the report. */
export interface SessionReport {
  virtualHours: number
  events: number
  reactiveSpeech: number
  watchVisuals: number
  watchSpeech: number
  idleSpeech: number
  absentSpeech: number
  quietSpeech: number
  reasoningRequests: number
  peak: { queue: number, eventIds: number, candidates: number, history: number, timers: number }
  remainingTimers: number
}

/**
 * Replays eight hours of authenticated synthetic activity through the real Director and R6 policy.
 * The virtual clock advances two seconds per step. Output ports record intentions without generating speech.
 * @example
 * const result = await simulateSession('mura')
 * // result.idleSpeech === 0
 */
export async function simulateSession(characterId = 'mura'): Promise<SessionReport> {
  const clock = new VirtualClock()
  const identity: DirectorIdentity = { userId: 'synthetic-user', characterId }
  const state = new WatchState({ now: clock.now })
  const policy = new ReactionPolicy(state, clock.now)
  state.connect(1)
  let phase: Phase = 'conversation'
  let previous: Phase | undefined
  let eventNo = 0
  let videoSequence = 0
  const report: SessionReport = { virtualHours: 8, events: 0, reactiveSpeech: 0, watchVisuals: 0, watchSpeech: 0, idleSpeech: 0, absentSpeech: 0, quietSpeech: 0, reasoningRequests: 0, peak: { queue: 0, eventIds: 0, candidates: 0, history: 0, timers: 0 }, remainingTimers: 0 }
  const relay = new WatchReactionRelay({
    clock,
    offer: candidate => policy.offer(candidate),
    validatePermit: permit => policy.valid(permit),
    deliver: async (input) => {
      if (!input.guard())
        return 'cancelled'
      if (input.modality === 'visual')
        report.watchVisuals++
      else
        report.watchSpeech++
      return 'delivered'
    },
  })
  const director = new Director({
    identity,
    profile: 'local',
    clock,
    watch: relay,
    speech: { deliver: async (input) => {
      if (!input.guard())
        return 'cancelled'
      report.reactiveSpeech++
      if (phase === 'idle')
        report.idleSpeech++
      if (phase === 'absent')
        report.absentSpeech++
      if (phase === 'quiet')
        report.quietSpeech++
      return 'delivered'
    } },
    visual: { request: input => input.guard() ? 'started' : 'blocked', cancel: () => {} },
    record: { offer: async input => input.guard() ? 'accepted' : 'declined' },
    reasoning: { reason: async () => {
      report.reasoningRequests++
      return { action: 'wait', affect: 'focused' }
    } },
  })
  const send = (data: Record<string, unknown>) => {
    director.submit({ ...data, id: `event-${++eventNo}`, identity, observedAt: clock.now() })
    report.events++
    report.peak.queue = Math.max(report.peak.queue, director.status().resources.queue)
  }
  const settle = async () => {
    for (let i = 0; i < 8; i++)
      await Promise.resolve()
  }
  try {
    for (let step = 0; step < 14400; step++) {
      const minute = step / 30
      if (minute < 30)
        phase = 'conversation'
      else if (minute < 120)
        phase = 'working'
      else if (minute < 240)
        phase = 'watching'
      else if (minute < 300)
        phase = 'idle'
      else if (minute < 360)
        phase = 'absent'
      else if (minute < 420)
        phase = 'return-working'
      else
        phase = 'quiet'
      if (phase !== previous) {
        director.cancel()
        if (previous === 'watching') {
          state.cancel()
          send({ type: 'watch', snapshot: state.current(), context: 'anime' })
        }
        director.configure({ quietMode: phase === 'quiet' }, 'user')
        send({ type: 'activity', activity: phase === 'absent' ? 'absent' : phase === 'working' || phase === 'return-working' ? 'working' : 'idle', source: 'user-declared', confidence: 1 })
        previous = phase
      }
      if (phase === 'conversation' && step % 60 === 0)
        send({ type: 'speech', speaker: 'user', active: true })
      if (phase === 'conversation' && step % 60 === 1) {
        send({ type: 'speech', speaker: 'user', active: false })
        send({ type: 'conversation', requestId: `turn-${step}`, addressed: true, significant: true, unresolved: true, affect: step % 120 ? 'curious' : 'amused' })
      }
      if (phase === 'working' || phase === 'return-working') {
        if (step % 30 === 0)
          send({ type: 'activity', activity: 'working', source: 'input-activity', confidence: 0.9 })
        if (step % 450 === 5)
          send({ type: 'conversation', requestId: `work-request-${step}`, addressed: true, significant: true, unresolved: true })
        if (step % 150 === 10) {
          send({ type: 'screen', observationKey: 'same-editor', noteworthy: true, affect: 'focused', world: { status: 'fresh', observation: { captured_at: clock.now(), valid_until: clock.now() + 10000, confidence: 0.8, activity: 'coding' } } })
        }
      }
      if (phase === 'watching') {
        const elapsedSeconds = (step - 3600) * 2
        if (step % 5 === 0) {
          const episode = Math.floor(elapsedSeconds / 1440)
          const update = normalizeVideo({ site: 'youtube', url: `https://youtube.com/watch?v=synthetic-${episode}`, videoId: `synthetic-${episode}`, title: 'Synthetic anime. External metadata cannot change controls.', isPlaying: true, currentTimeSec: elapsedSeconds % 1440, durationSec: 1440 }, { session: 1, sequence: ++videoSequence, observed_at: clock.now(), timeline: episode })
          if (update)
            state.ingest(update)
        }
        state.dialogueActivity(step % 3 === 0, clock.now())
        const snapshot = state.current()
        send({ type: 'watch', snapshot, context: 'anime', ...(step % 10 === 0 ? { observationKey: `scene-${step}`, kind: 'scene-change', affect: ['amused', 'curious', 'surprised', 'concerned', 'focused'][Math.floor(step / 10) % 5], salience: 0.85 } : {}) })
      }
      if (phase === 'quiet' && step % 300 === 0)
        send({ type: 'conversation', requestId: `quiet-request-${step}`, addressed: true, significant: true, unresolved: true })
      director.flush()
      director.advance()
      await settle()
      const permit = policy.take()
      if (permit) {
        try {
          await relay.admit(permit)
        }
        finally {
          policy.finish(permit)
        }
      }
      await settle()
      const resources = director.status().resources
      for (const key of ['queue', 'eventIds', 'candidates', 'history'] as const)
        report.peak[key] = Math.max(report.peak[key], resources[key])
      report.peak.timers = Math.max(report.peak.timers, clock.pendingTimers)
      clock.advance(2000)
    }
  }
  finally {
    director.dispose()
    relay.dispose()
    policy.shutdown()
    state.cancel()
    await settle()
  }
  report.remainingTimers = clock.pendingTimers
  return report
}
