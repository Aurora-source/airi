import type { Affect, AttentionSnapshot, MoodSnapshot } from './contracts'
import type { QueuedEvent } from './ingress'

interface Evidence {
  activity: AttentionSnapshot['activity']
  confidence: number
  source: AttentionSnapshot['source']
  at: number
  until: number
  tentative: boolean
  outputId?: string
}

/** Fixed evidence slots have acquisition-based leases. Expiry produces unknown, never inferred absence. */
export class AttentionState {
  private userSpeech?: Evidence
  private companionSpeech?: Evidence
  private conversation?: Evidence
  private activity?: Evidence
  private screen?: Evidence
  private screenObservation?: { key: string, capturedAt: number, until: number, confidence: number }
  private watch?: Extract<QueuedEvent, { type: 'watch' }>
  private userEdge = -Infinity
  private companionEdge = -Infinity
  private activityEdge = -Infinity
  private screenEdge = -Infinity
  private watchEdge = -Infinity

  accept(event: QueuedEvent): boolean {
    const at = event.observedAt
    switch (event.type) {
      case 'speech': {
        const previous = event.speaker === 'user' ? this.userEdge : this.companionEdge
        if (at < previous)
          return false
        const evidence: Evidence | undefined = event.active ? { activity: event.speaker === 'user' ? 'user-speaking' : 'companion-speaking', confidence: 1, source: 'voice', at, until: at + 10000, tentative: false, outputId: event.speaker === 'companion' ? event.outputId : undefined } : undefined
        if (event.speaker === 'user') {
          this.userEdge = at
          this.userSpeech = evidence
        }
        else {
          this.companionEdge = at
          this.companionSpeech = evidence
        }
        break
      }
      case 'conversation':
        if (at < (this.conversation?.at ?? -Infinity))
          return false
        this.conversation = { activity: 'conversation', confidence: 1, source: 'conversation', at, until: at + 120000, tentative: false }
        break
      case 'activity':
        if (at < this.activityEdge)
          return false
        this.activityEdge = at
        this.activity = { activity: event.activity, confidence: event.confidence, source: event.source, at, until: at + (event.source === 'user-declared' ? 600000 : event.source === 'input-activity' ? 5000 : 30000), tentative: event.source !== 'user-declared' }
        break
      case 'screen':
        if (at < this.screenEdge)
          return false
        this.screenEdge = at
        this.screenObservation = event.world.status === 'fresh'
          ? { key: event.observationKey, capturedAt: event.world.observation.captured_at, until: Math.min(event.world.observation.captured_at + 30000, event.world.observation.valid_until), confidence: event.world.observation.confidence }
          : undefined
        this.screen = event.world.status === 'fresh' && ['working', 'coding', 'reading'].includes(event.world.observation.activity)
          ? { activity: 'working', confidence: Math.min(0.7, event.world.observation.confidence), source: 'screen', at: event.world.observation.captured_at, until: Math.min(event.world.observation.captured_at + 30000, event.world.observation.valid_until), tentative: true }
          : undefined
        break
      case 'watch':
        if (at < this.watchEdge || (this.watch && event.snapshot.revision < this.watch.snapshot.revision))
          return false
        this.watchEdge = at
        this.watch = event
        break
    }
    return true
  }

  current(now: number): AttentionSnapshot {
    const fresh = (e?: Evidence) => e && e.until > now && e.confidence >= 0.5 ? e : undefined
    const user = fresh(this.userSpeech)
    const companion = fresh(this.companionSpeech)
    const declared = fresh(this.activity)
    const conversation = fresh(this.conversation)
    const screen = fresh(this.screen)
    const watch = this.currentWatch(now)
    const knownMedia = this.watch && ['watching', 'stale'].includes(this.watch.snapshot.status)
    const watching: Evidence | undefined = watch
      ? {
          activity: this.watch?.context === 'anime' ? 'watching-anime' : 'watching-media',
          source: 'watch',
          confidence: Math.min(0.95, watch.confidence),
          at: this.watch!.observedAt,
          until: Math.min(watch.valid_until!, watch.playback!.valid_until),
          tentative: true,
        }
      : undefined
    const absent = declared?.activity === 'absent' && (!conversation || declared.at >= conversation.at) ? declared : undefined
    const explicit = declared?.source === 'user-declared' && (!conversation || declared.at >= conversation.at) ? declared : undefined
    const selected = user ?? companion ?? absent ?? watching ?? explicit ?? conversation ?? declared ?? screen
    return {
      activity: selected?.activity ?? 'unknown',
      confidence: selected?.confidence ?? 0,
      source: selected?.source ?? 'none',
      tentative: selected?.tentative ?? true,
      validUntil: selected?.until,
      userSpeaking: !!user,
      companionSpeaking: !!companion,
      working: declared?.activity === 'working' || screen?.activity === 'working',
      typing: declared?.source === 'input-activity' && declared.activity === 'working',
      watching: !!knownMedia,
      watchEvidence: watch ? 'fresh' : knownMedia ? 'uncertain' : 'none',
      dialogue: watch?.dialogue_active === 'gap'
        ? watch.dialogue_valid_until !== undefined && watch.dialogue_valid_until > now && watch.gap_since !== undefined && watch.gap_since <= now ? 'gap' : 'unknown'
        : watch?.dialogue_active ?? 'unknown',
    }
  }

  currentWatch(now: number): Extract<QueuedEvent, { type: 'watch' }>['snapshot'] | undefined {
    const snapshot = this.watch?.snapshot
    if (!snapshot || snapshot.status !== 'watching' || snapshot.confidence < 0.5
      || !snapshot.valid_until || snapshot.valid_until <= now || !snapshot.playback
      || snapshot.playback.observed_at > now || snapshot.playback.valid_until <= now) {
      return undefined
    }
    return snapshot
  }

  ownsCompanionSpeech(outputId: string | undefined, now: number): boolean {
    return !!outputId && this.companionSpeech?.outputId === outputId && this.companionSpeech.until > now
  }

  screenCurrent(support: { key: string, capturedAt: number }, now: number): boolean {
    const observation = this.screenObservation
    return !!observation && observation.key === support.key && observation.capturedAt >= support.capturedAt && observation.confidence >= 0.65 && observation.until > now
  }

  clear(): void {
    this.userSpeech = undefined
    this.companionSpeech = undefined
    this.conversation = undefined
    this.activity = undefined
    this.screen = undefined
    this.screenObservation = undefined
    this.watch = undefined
  }
}

/** A gradual activity score, independent of emotional tone. It makes no claim about fatigue or subjective energy. */
export class EnergyState {
  private value = 0.5
  private target = 0.5
  private until = 0
  private at: number

  constructor(now: number) { this.at = now }

  current(attention: AttentionSnapshot, now: number): number {
    const evidenceElapsed = Math.max(0, Math.min(now, this.until) - this.at)
    this.value = this.target + (this.value - this.target) * 2 ** (-evidenceElapsed / 120000)
    const unknownElapsed = Math.max(0, now - Math.max(this.at, this.until))
    this.value = 0.5 + (this.value - 0.5) * 2 ** (-unknownElapsed / 120000)
    this.at = now
    const targets: Record<AttentionSnapshot['activity'], number> = {
      'user-speaking': 0.65,
      'companion-speaking': 0.6,
      'conversation': 0.65,
      'watching-anime': 0.55,
      'watching-media': 0.55,
      'working': 0.45,
      'idle': 0.3,
      'absent': 0.25,
      'unknown': 0.5,
    }
    this.target = targets[attention.activity]
    this.until = attention.validUntil ?? now
    return this.value
  }
}

/** Short reactions and gradual conversational mood have independent lifetimes and never claim subjective feelings. */
export class MoodState {
  private valence = 0.1
  private arousal = 0.25
  private warmth = 0.5
  private at: number
  private lastChange = -Infinity
  private reaction?: { affect: NonNullable<Extract<QueuedEvent, { type: 'conversation' }>['affect']>, validUntil: number }

  constructor(now: number) { this.at = now }

  advance(now: number): void {
    const elapsed = Math.max(0, now - this.at)
    const decay = 2 ** (-elapsed / 1800000)
    this.valence = 0.1 + (this.valence - 0.1) * decay
    this.arousal = 0.25 + (this.arousal - 0.25) * decay
    this.warmth = 0.5 + (this.warmth - 0.5) * decay
    this.at = now
    if (this.reaction && this.reaction.validUntil <= now)
      this.reaction = undefined
  }

  accept(event: QueuedEvent, now: number): void {
    this.advance(now)
    if (!('affect' in event) || !event.affect)
      return
    this.reaction = { affect: event.affect, validUntil: Math.min(now + 6000, event.observedAt + 30000) }
    if (now - this.lastChange < 30000)
      return
    this.lastChange = now
    const pleasant = event.affect === 'amused'
    const concerned = event.affect === 'concerned'
    this.valence = Math.max(-1, Math.min(1, this.valence + (pleasant ? 0.035 : concerned ? -0.025 : 0.005)))
    this.arousal = Math.max(0, Math.min(1, this.arousal + (event.affect === 'surprised' ? 0.03 : 0.01)))
    this.warmth = Math.max(0, Math.min(1, this.warmth + (pleasant ? 0.01 : 0)))
  }

  snapshot(now: number): { mood: MoodSnapshot, reaction?: { affect: Affect, validUntil: number } } {
    this.advance(now)
    const tone: MoodSnapshot['tone'] = this.valence < 0 ? 'gentle' : this.valence > 0.4 ? 'playful' : this.warmth > 0.55 ? 'warm' : this.arousal > 0.5 ? 'focused' : 'neutral'
    return { mood: { valence: this.valence, arousal: this.arousal, warmth: this.warmth, tone }, reaction: this.reaction && { ...this.reaction } }
  }
}
