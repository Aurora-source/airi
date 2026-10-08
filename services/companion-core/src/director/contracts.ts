import type { CompanionConfig } from '../config/config'
import type { MemoryItem, MemoryQueryPort, Provenance } from '../memory/ports'
import type { CurrentWorld } from '../perception/ports/contracts'
import type { WatchSnapshot } from '../watch/contracts'
import type { ReactionCandidate, ReactionPermit } from '../watch/reactions'

/** One instance owns one authenticated user and character pair. */
export interface DirectorIdentity { userId: string, characterId: string }

/** Deadlines are owned by active work. No repeating scheduler belongs to the Director. */
export interface DirectorClock {
  now: () => number
  schedule: (delayMs: number, callback: () => void) => () => void
}

export type Affect = 'amused' | 'curious' | 'surprised' | 'concerned' | 'focused'
export type AttentionActivity = 'conversation' | 'user-speaking' | 'companion-speaking' | 'watching-anime' | 'watching-media' | 'working' | 'idle' | 'absent' | 'unknown'
export type DecisionAction = 'SPEAK' | 'SILENT_VISUAL_REACTION' | 'REMEMBER' | 'WAIT' | 'DO_NOTHING'
export type DecisionReason
  = | 'direct-request' | 'continuation' | 'follow-up' | 'record-candidate' | 'visual-reaction'
    | 'no-salient-event' | 'proactive-disabled' | 'user-speaking' | 'companion-speaking' | 'media-dialogue'
    | 'working' | 'typing' | 'presence-unknown' | 'absent' | 'quiet-mode' | 'quiet-period' | 'private-mode'
    | 'disabled' | 'disposed' | 'cooldown' | 'frequency-off' | 'hourly-limit' | 'output-busy'
    | 'output-unavailable' | 'output-failed' | 'output-declined' | 'output-expired' | 'cancelled'
    | 'memory-refreshed' | 'memory-unavailable' | 'memory-invalidated' | 'reasoning-disabled'
    | 'reasoning-unavailable' | 'reasoning-budget' | 'reasoning-wait' | 'stale-evidence'

interface Envelope {
  id: string
  identity: DirectorIdentity
  observedAt: number
}

/**
 * Trusted host envelopes carry structured evidence. Metadata inside snapshots has no instruction authority.
 * Submit projects snapshots before retaining them. Conversation events contain no conversation text.
 */
export type DirectorEvent = Envelope & (
  | { type: 'conversation', requestId: string, addressed: boolean, significant: boolean, unresolved: boolean, affect?: Affect }
  | { type: 'speech', speaker: 'user' | 'companion', active: boolean, outputId?: string }
  | { type: 'activity', activity: 'working' | 'idle' | 'absent' | 'unknown', source: 'user-declared' | 'input-activity' | 'presence-signal', confidence: number }
  | { type: 'watch', snapshot: WatchSnapshot, observationKey?: string, kind?: ReactionCandidate['kind'], affect?: Affect, salience?: number, context?: 'anime' | 'media' }
  | { type: 'screen', world: CurrentWorld, observationKey: string, noteworthy: boolean, affect?: Affect }
  | { type: 'record', kind: 'preference' | 'correction' | 'plan' | 'promise', messageId: string, provenance: Provenance }
  | { type: 'recall', query: string, requestId: string, purpose: 'relevant-recall' | 'follow-up' }
  | { type: 'memory-invalidated', itemIds: string[] }
  | { type: 'reason', observationKey: string, affect?: Affect }
)

export type Admission = 'accepted' | 'duplicate' | 'stale' | 'invalid' | 'wrong-identity' | 'disabled' | 'overflow'

/** Control changes come from authenticated user settings, never from evidence text. */
export interface DirectorConfiguration {
  enabled: boolean
  proactiveSpeech: boolean
  quietMode: boolean
  privateMode: boolean
  reactionFrequency: 'off' | 'low' | 'normal'
  reasoningEnabled: boolean
  utcOffsetMinutes: number
  quietPeriods: Array<{ startMinute: number, endMinute: number }>
}

/** No data in this diagnostic record supplies wording, tool arguments, or memory content. */
export interface Decision {
  action: DecisionAction
  reason: DecisionReason
  at: number
  salience: number
  origin: DirectorEvent['type'] | 'memory' | 'none'
}

export interface MoodSnapshot {
  valence: number
  arousal: number
  warmth: number
  tone: 'neutral' | 'warm' | 'playful' | 'gentle' | 'focused'
}

export interface AttentionSnapshot {
  activity: AttentionActivity
  confidence: number
  source: 'conversation' | 'voice' | 'user-declared' | 'input-activity' | 'presence-signal' | 'screen' | 'watch' | 'none'
  tentative: boolean
  validUntil?: number
  userSpeaking: boolean
  companionSpeaking: boolean
  working: boolean
  typing: boolean
  watching: boolean
  watchEvidence: 'none' | 'fresh' | 'uncertain'
  dialogue: WatchSnapshot['dialogue_active']
}

/** This guard is checked immediately before output and during long-running speech. */
export interface EffectGuard {
  signal: AbortSignal
  validUntil: number
  guard: () => boolean
}

/** Wording belongs to existing conversation routing. Evidence is data, never a personal-experience claim. */
export interface SpeechIntent extends EffectGuard {
  /** Opaque correlation for this live output. The host echoes it on companion voice activity. */
  outputId: string
  identity: DirectorIdentity
  intent: 'respond-user' | 'continue-conversation' | 'follow-up'
  requestId?: string
  tone: MoodSnapshot['tone']
  evidence: MemoryItem[]
}

export interface SpeechIntentPort {
  deliver: (input: SpeechIntent) => Promise<'delivered' | 'declined' | 'cancelled'>
}

/** The future host maps these domain intents to VisualBehaviorPort after the visual branch is integrated. */
export interface VisualIntent extends EffectGuard {
  behavior: Affect
  activity: 'listening' | 'thinking' | 'waiting' | 'watching' | 'idle'
  intensity: 'still' | 'calm' | 'normal'
}

export interface VisualIntentPort {
  request: (input: VisualIntent) => 'started' | 'blocked' | 'unsupported'
  /** Cancels only requests owned by this Director. */
  cancel: () => void
}

/** R6 alone admits both visual and spoken reactions. An offer is never a speech permit. */
export interface WatchReactionRequest extends EffectGuard {
  candidate: ReactionCandidate
  modality: 'visual' | 'speech'
  affect: Affect
  /** Present only for spoken requests. The host retains the canonical request through R6 admission. */
  speech?: Pick<SpeechIntent, 'outputId' | 'identity' | 'intent' | 'requestId' | 'tone' | 'evidence'>
}

export interface WatchReactionPort {
  offerReaction: (input: WatchReactionRequest) => Promise<'delivered' | 'declined' | 'cancelled'>
}

/** The relay delivers only a matching R6 permit. The host honors both signals and revalidates the guard. */
export interface AdmittedWatchReaction extends WatchReactionRequest {
  permit: ReactionPermit
}

/** R4 or the host retrieves the canonical turn and decides persistence. R7 supplies no invented text or claims. */
export interface RecordCandidate {
  identity: DirectorIdentity
  kind: 'preference' | 'correction' | 'plan' | 'promise'
  messageId: string
  provenance: Provenance
  signal: AbortSignal
  guard: () => boolean
}

export interface RecordCandidatePort {
  offer: (input: RecordCandidate) => Promise<'accepted' | 'declined'>
}

/** Only text-free, bounded state crosses optional model reasoning. Models cannot authorize speech. */
export interface ReasoningInput {
  profile: CompanionConfig['profile']
  attention: AttentionActivity
  mood: MoodSnapshot
  affect?: Affect
  salience: number
  signal: AbortSignal
}

export interface ReasoningResult { action: 'wait' | 'visual', affect: Affect }
export interface ReasoningPort { reason: (input: ReasoningInput) => Promise<unknown> }

/** Continuity remains ephemeral R4 evidence. Diagnostics expose counts only. */
export interface Continuity {
  items: MemoryItem[]
  openThreads: MemoryItem[]
  plans: MemoryItem[]
  relationships: MemoryItem[]
}

export interface DirectorMetrics {
  accepted: number
  invalid: number
  stale: number
  duplicates: number
  overflow: number
  suppressed: number
  decisions: number
  speechAttempts: number
  visualAttempts: number
  recordAttempts: number
  reasoningAttempts: number
  recallAttempts: number
  failures: number
  cancellations: number
}

/** Detached Ops snapshot. It excludes identity, queries, request IDs, captions, and memory text. */
export interface DirectorStatus {
  configuration: DirectorConfiguration
  attention: AttentionSnapshot
  mood: MoodSnapshot
  reaction?: { affect: Affect, validUntil: number }
  energy: number
  continuity: { items: number, openThreads: number, plans: number, relationships: number }
  lastDecision?: Decision
  metrics: DirectorMetrics
  resources: { queue: number, eventIds: number, candidates: number, fingerprints: number, history: number, activeOutput: number, activeVisual: number, activeRecall: number, activeReasoning: number, inFlightOutput: number, inFlightRecall: number, inFlightReasoning: number }
}

/** Ports belong to external boundaries. The Director neither creates nor disposes their underlying services. */
export interface DirectorOptions {
  identity: DirectorIdentity
  profile: CompanionConfig['profile']
  clock?: DirectorClock
  configuration?: Partial<Omit<DirectorConfiguration, 'proactiveSpeech'>>
  speech?: SpeechIntentPort
  visual?: VisualIntentPort
  watch?: WatchReactionPort
  memory?: MemoryQueryPort
  record?: RecordCandidatePort
  reasoning?: ReasoningPort
}

/** Bounds apply independently to every character instance. */
export const directorLimits = Object.freeze({
  queue: 128,
  flush: 32,
  eventIds: 256,
  candidates: 16,
  fingerprints: 128,
  history: 64,
  recallItems: 8,
  recallBytes: 2400,
  recallDeadlineMs: 150,
  reasoningDeadlineMs: 5000,
  outputDeadlineMs: 30000,
})
