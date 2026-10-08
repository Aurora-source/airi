/** Source generations change whenever the backend loses or replaces its capture target. */
export interface CaptureSource {
  kind: 'window' | 'display' | 'reference'
  id: string
  generation: number
  display_id?: string
  window_id?: string
  foreground_app?: string
  window_title?: string
}

/** Unknown safety signals must stay absent. A backend cannot infer safety from missing metadata. */
export interface ScreenFrame {
  capture_id: string
  captured_at: number
  source: CaptureSource
  width: number
  height: number
  /** A fixed 64 by 36 luminance grid, produced locally before inference. */
  samples: Uint8Array
  image: { mime_type: 'image/png' | 'image/jpeg' | 'image/webp', bytes: Uint8Array }
  safety: { private_context?: boolean, locked?: boolean, sensitive?: boolean }
  media_hint?: 'video'
}

/** The capture owner emits source loss and target replacement independently of pending captures. */
export interface ScreenCapturePort {
  isAvailable: () => boolean
  capture: (signal: AbortSignal) => Promise<ScreenFrame>
  subscribe: (listener: () => void) => () => void
  shutdown: () => Promise<void>
}

export interface ObservationFacts {
  confidence: number
  scene_type: 'code' | 'browser' | 'terminal' | 'desktop' | 'media' | 'other' | 'unknown'
  activity: string
  visible_text_summary: string
  notable_objects: string[]
  people_count?: number
  media: { detected: boolean, playback: 'playing' | 'paused' | 'unknown', title_like_text: string, subtitle_like_text: string }
  warnings: string[]
  concise_summary: string
}

/** Metadata and expiry come from capture, never from provider-generated timestamps. */
export interface Observation extends ObservationFacts {
  observation_id: string
  captured_at: number
  valid_until: number
  source: CaptureSource
}

/** Adapters advertise capabilities. Selection never launches an inference server. */
export interface VisionObservationPort {
  readonly id: string
  readonly locality: 'cloud' | 'local'
  readonly capabilities: { vision: boolean, structured_output: boolean }
  /**
   * `guard` throws when privacy or ownership changed. An adapter that tries several models itself calls it before
   * each upload, so a failover never sends a frame that the policy revoked.
   */
  observe: (input: { frame: ScreenFrame, signal: AbortSignal, guard?: () => void }) => Promise<unknown>
}

export type FailureStatus = 'unavailable' | 'blocked-by-privacy' | 'capture-failed' | 'vlm-failed'

export type CurrentWorld
  = | { status: 'fresh', observation: Observation, uncertain_objects: string[] }
    | { status: 'stale' | FailureStatus }

/** Future consumers select durable memories. Events contain facts, never image bytes or OCR dumps. */
export interface PerceptionEventPort {
  publish: (event: { type: 'current-world', world: CurrentWorld }) => void
}

/** Only numeric counters and timings belong in perception diagnostics. */
export interface Metrics {
  captures: number
  vision_requests: number
  observations: number
  privacy_blocks: number
  duplicates: number
  capture_ms: number
  detection_ms: number
  observation_ms: number
  event_failures: number
}
