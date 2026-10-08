import type { CurrentWorld } from '../perception/index'

/** The channel bridge stamps acquisition time and ordering before asynchronous delivery. */
export interface BrowserStamp {
  session: number
  sequence: number
  observed_at: number
  /** Increment on navigation, episode changes and seeks. Never reuse a prior playback epoch. */
  timeline: number
}

export type Source = 'browser' | 'subtitle' | 'visual' | 'system-audio' | 'metadata'

/** Consumers use provenance and expiry when wording a claim. Confidence is evidence strength, not certainty. */
export interface Evidence<T> {
  value: T
  source: Source
  confidence: number
  observed_at: number
  valid_until: number
}

export interface MediaIdentity {
  id: string
  site: 'youtube' | 'bilibili' | 'unknown'
  title?: Evidence<string>
  episode?: Evidence<number>
}

export interface VideoUpdate {
  kind: 'video'
  stamp: BrowserStamp
  media: MediaIdentity
  playing?: boolean
  position?: number
  duration?: number
  rate?: number
  /** The media element reported `ended` for this source. The host confirms completion only with this signal. */
  ended?: boolean
}

export interface SubtitleUpdate {
  kind: 'subtitle'
  stamp: BrowserStamp
  media_id: string
  text: string
  title?: string
  language?: string
  start_ms?: number
  end_ms?: number
  automatic: boolean
  /** An on-screen caption disappeared without a cue end. Dialogue becomes unknown, never a proven gap. */
  cleared?: boolean
}

export type BrowserUpdate = VideoUpdate | SubtitleUpdate

export interface Dialogue extends Evidence<string> {
  language?: string
  start_ms?: number
  end_ms?: number
}

/** Snapshots contain current bounded text only. No frame, audio, subtitle history or storage handle exists. */
export interface WatchSnapshot {
  status: 'idle' | 'watching' | 'stale' | 'cancelled'
  revision: number
  valid_until?: number
  media?: MediaIdentity
  playback?: Evidence<'playing' | 'paused'>
  position?: Evidence<number>
  dialogue?: Dialogue
  dialogue_active: 'active' | 'gap' | 'unknown'
  gap_since?: number
  dialogue_valid_until?: number
  scene?: Evidence<string>
  visual_title?: Evidence<string>
  conflicts: Array<'title-conflict'>
  confidence: number
  perception_blocked: boolean
}

export type WatchEventKind = 'started' | 'paused' | 'resumed' | 'stopped' | 'finished-episode' | 'shared-reaction' | 'user-opinion'

/** R4 chooses persistence. Routine captions and scenes never reach this port. */
export interface WatchEventPort {
  publish: (event: { kind: WatchEventKind, media: MediaIdentity, at: number, detail?: string }) => void
}

/** Read-only R5 boundary. A non-fresh result invalidates visual hints immediately. */
export interface FreshPerceptionPort {
  current: () => CurrentWorld
}

/** Owns one short system-output segment. No microphone behavior is changed by this port. */
export interface SystemAudioPort {
  /** captured_at marks acquisition end. The entire segment must be acquired after the request begins, without cached lookback audio. */
  capture: (input: { max_duration_ms: number, signal: AbortSignal }) => Promise<{ bytes: Uint8Array, mime_type: 'audio/wav' | 'audio/webm', captured_at: number, duration_ms: number }>
}

/** Adapts the existing speech-recognition capability. R6 owns admission, never provider routing or model selection. */
export interface SpeechRecognitionPort {
  transcribe: (input: { bytes: Uint8Array, mime_type: 'audio/wav' | 'audio/webm', language: 'en' | 'ja', signal: AbortSignal }) => Promise<string>
}

export interface WatchOptions {
  /** Polling upstream sends video positions every 15 seconds. Expiry allows one missed poll. */
  browser_ttl_ms: number
  subtitle_ttl_ms: number
  dialogue_gap_ms: number
  reaction_cooldown_ms: number
  audio_interval_ms: number
  audio_timeout_ms: number
}

/** Limits are grouped by policy. Hosts can tighten them without changing runtime assembly. */
export const watchDefaults: WatchOptions = {
  browser_ttl_ms: 35000,
  subtitle_ttl_ms: 6000,
  dialogue_gap_ms: 1500,
  reaction_cooldown_ms: 180000,
  audio_interval_ms: 30000,
  audio_timeout_ms: 12000,
}
