import type { Observation, ObservationFacts, ScreenFrame } from '../../src/perception/ports/contracts'

/** Synthetic frames contain no desktop pixels or personal data. */
export function frame(overrides: Partial<ScreenFrame> = {}): ScreenFrame {
  return {
    capture_id: 'capture-1',
    captured_at: 100,
    width: 640,
    height: 360,
    source: { kind: 'window', id: 'source', generation: 1, display_id: 'display', window_id: 'window', foreground_app: 'editor', window_title: 'fixture' },
    safety: { private_context: false, locked: false, sensitive: false },
    samples: new Uint8Array(2304).fill(100),
    image: { mime_type: 'image/png', bytes: new Uint8Array([1, 2, 3]) },
    ...overrides,
  }
}

/** Only bounded visual facts cross the provider boundary. */
export function facts(overrides: Partial<ObservationFacts> = {}): ObservationFacts {
  return { confidence: 0.9, scene_type: 'code', activity: 'editing', visible_text_summary: '', notable_objects: [], media: { detected: false, playback: 'unknown', title_like_text: '', subtitle_like_text: '' }, warnings: [], concise_summary: 'An editor is visible.', ...overrides }
}

/** Capture timestamps determine expiry, independent of inference completion time. */
export function observation(overrides: Partial<Observation> = {}): Observation {
  return { ...facts(), observation_id: 'observation-1', captured_at: 100, valid_until: 1100, source: frame().source, ...overrides }
}
