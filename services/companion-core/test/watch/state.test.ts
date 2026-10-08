import type { SubtitlePayload, VideoContextPayload } from '../../../../plugins/airi-plugin-web-extension/src/shared/types'
import type { CurrentWorld } from '../../src/perception/index'
import type { WatchEventPort } from '../../src/watch/contracts'

import { describe, expect, it } from 'vitest'

import { normalizeBrowserLane, normalizeSubtitle, normalizeVideo } from '../../src/watch/browser'
import { WatchState } from '../../src/watch/state'
import { observation } from '../perception/helpers'

function fixture() {
  let now = 1000
  let sequence = 0
  let timeline = 0
  const events: Array<Parameters<WatchEventPort['publish']>[0]> = []
  const state = new WatchState({ now: () => now, events: { publish: event => events.push(event) } })
  state.connect(1)
  const stamp = () => ({ session: 1, sequence: ++sequence, observed_at: now, timeline })
  const video = (overrides: Partial<VideoContextPayload> = {}) => normalizeVideo({ site: 'youtube', url: 'https://www.youtube.com/watch?v=one', videoId: 'one', title: 'Sample Episode 3', isPlaying: true, currentTimeSec: 10, durationSec: 100, playbackRate: 1, ...overrides }, stamp())!
  const subtitle = (overrides: Partial<SubtitlePayload> = {}) => normalizeSubtitle({ site: 'youtube', url: 'https://www.youtube.com/watch?v=one', videoId: 'one', text: 'Hello there', language: 'en', ...overrides }, stamp())!
  return { state, events, video, subtitle, time: (value: number) => {
    now = value
  }, timeline: () => {
    timeline++
  } }
}

describe('normalized browser state', () => {
  it('tracks play, pause and resume without caption memories', () => {
    const f = fixture()
    expect(f.state.ingest(f.video())).toBe(true)
    expect(f.state.current().playback?.value).toBe('playing')
    f.time(2000)
    f.state.ingest(f.video({ isPlaying: false, currentTimeSec: 11 }))
    expect(f.state.current().playback?.value).toBe('paused')
    f.time(3000)
    f.state.ingest(f.video({ currentTimeSec: 11 }))
    f.state.ingest(f.subtitle())
    expect(f.events.map(e => e.kind)).toEqual(['started', 'paused', 'resumed'])
  })

  it('clears dialogue and scene on seek and rejects a delayed prior cue', () => {
    const f = fixture()
    f.state.ingest(f.video())
    f.state.ingest(f.subtitle())
    const late = f.subtitle({ text: 'Old cue' })
    f.time(2000)
    f.timeline()
    f.state.ingest(f.video({ currentTimeSec: 50 }))
    expect(f.state.current().dialogue).toBeUndefined()
    expect(f.state.ingest(late)).toBe(false)
  })

  it('clears on video and episode changes', () => {
    const f = fixture()
    f.state.ingest(f.video())
    f.state.ingest(f.subtitle())
    f.time(2000)
    f.timeline()
    f.state.ingest(f.video({ title: 'Sample Episode 4' }))
    expect(f.state.current().media?.episode?.value).toBe(4)
    expect(f.state.current().dialogue).toBeUndefined()
    f.time(3000)
    f.timeline()
    f.state.ingest(f.video({ videoId: 'two', url: 'https://youtube.com/watch?v=two' }))
    expect(f.state.current().media?.id).toBe('youtube:two')
    expect(f.events.map(e => e.kind)).toEqual(['started', 'stopped', 'started', 'stopped', 'started'])
  })

  it('tracks subtitle progression and rejects duplicates without extending expiry', () => {
    const f = fixture()
    f.state.ingest(f.video())
    f.state.ingest(f.subtitle())
    const expires = f.state.current().dialogue?.valid_until
    f.time(2000)
    f.state.ingest(f.subtitle())
    expect(f.state.current().dialogue?.valid_until).toBe(expires)
    f.state.ingest(f.subtitle({ text: 'Goodbye' }))
    expect(f.state.current().dialogue?.value).toBe('Goodbye')
  })

  it('retains Japanese dialogue and parses explicit Japanese episode labels', () => {
    const f = fixture()
    f.state.ingest(f.video({ title: 'サンプル 第３話'.replace('３', '3') }))
    f.state.ingest(f.subtitle({ text: '一緒に見よう。', language: 'ja' }))
    expect(f.state.current().dialogue?.value).toBe('一緒に見よう。')
    expect(f.state.current().media?.episode?.value).toBe(3)
  })

  it('expires missing and untimed subtitles into unknown, not a proven gap', () => {
    const f = fixture()
    f.state.ingest(f.video())
    expect(f.state.current().dialogue_active).toBe('unknown')
    f.state.ingest(f.subtitle())
    f.time(8000)
    expect(f.state.current().dialogue).toBeUndefined()
    expect(f.state.current().dialogue_active).toBe('unknown')
  })

  it('uses media-relative cue end time and preserves a subtitle gap', () => {
    const f = fixture()
    f.state.ingest(f.video())
    f.state.ingest(f.subtitle({ startMs: 10000, endMs: 12000 }))
    expect(f.state.current().dialogue_active).toBe('active')
    f.time(3100)
    expect(f.state.current().dialogue_active).toBe('gap')
    expect(f.state.current().gap_since).toBe(3000)
    expect(f.state.current().dialogue).toBeUndefined()
  })

  it('ignores delayed browser events and out-of-order sequence numbers', () => {
    const f = fixture()
    const delayed = f.video({ isPlaying: false })
    f.time(2000)
    f.state.ingest(f.video())
    expect(f.state.ingest(delayed)).toBe(false)
    const olderTime = f.video({ isPlaying: false })
    olderTime.stamp.observed_at = 1000
    expect(f.state.ingest(olderTime)).toBe(false)
    expect(f.state.current().playback?.value).toBe('playing')
  })

  it('expires browser state and rejects stale or future events', () => {
    const f = fixture()
    const stale = f.video()
    f.state.ingest(stale)
    f.time(37000)
    expect(f.state.current().status).toBe('stale')
    expect(f.state.current().media).toBeUndefined()
    expect(f.state.ingest(stale)).toBe(false)
    const future = f.video()
    future.stamp.observed_at += 1
    expect(f.state.ingest(future)).toBe(false)
  })

  it('does not derive a timed cue gap from expired playback evidence', () => {
    const f = fixture()
    f.state.ingest(f.video())
    f.time(34000)
    f.state.ingest(f.video({ isPlaying: undefined, currentTimeSec: 43 }))
    f.time(34500)
    f.state.ingest(f.subtitle({ startMs: 43000, endMs: 48000 }))
    f.time(39000)
    expect(f.state.current().playback).toBeUndefined()
    expect(f.state.current().dialogue_active).toBe('active')
  })

  it('disconnects and requires a new session on reconnect', () => {
    const f = fixture()
    f.state.ingest(f.video())
    const prior = f.subtitle()
    f.state.disconnect()
    expect(f.state.current().status).toBe('idle')
    f.state.connect(2)
    expect(f.state.ingest(prior)).toBe(false)
    const fresh = f.video()
    fresh.stamp.session = 2
    f.state.ingest(fresh)
    expect(f.state.current().status).toBe('watching')
  })

  it('withholds unknown episodes and never infers completion from a seek to the end', () => {
    const f = fixture()
    f.state.ingest(f.video({ title: 'Sample 2026 1080p' }))
    expect(f.state.current().media?.episode).toBeUndefined()
    f.time(2000)
    f.timeline()
    f.state.ingest(f.video({ currentTimeSec: 100, isPlaying: false }))
    expect(f.events.some(e => e.kind === 'finished-episode')).toBe(false)
  })

  it('emits an episode finish only for a trusted ended signal', () => {
    const f = fixture()
    f.state.ingest(f.video())
    const revision = f.state.current().revision
    expect(f.state.finished(revision)).toBe(true)
    expect(f.state.finished(revision)).toBe(false)
    expect(f.events.at(-1)?.kind).toBe('finished-episode')
  })

  it('exposes opinions and reactions without keeping caption history', () => {
    const f = fixture()
    f.state.ingest(f.video())
    f.state.ingest(f.subtitle())
    f.state.shared('user-opinion', 'I liked that scene.')
    f.state.shared('shared-reaction', 'We laughed.')
    expect(f.events.map(e => e.kind)).toEqual(['started', 'user-opinion', 'shared-reaction'])
    expect(JSON.stringify(f.events)).not.toContain('Hello there')
    expect(JSON.stringify(f.state.current())).not.toContain('history')
  })

  it('parses upstream lane captions without trusting arbitrary lane text', () => {
    const stamp = { session: 1, sequence: 1, observed_at: 1000, timeline: 0 }
    const m = { source: 'web-extension', site: 'bilibili', url: 'https://www.bilibili.com/video/BV1/?p=2', videoId: 'BV1', startMs: 10, endMs: 20 }
    const result = normalizeBrowserLane({ lane: 'web:subtitle', text: 'Subtitle: こんにちは', metadata: m }, stamp)
    expect(result).toMatchObject({ text: 'こんにちは', media_id: 'bilibili:BV1:part-2' })
    expect(normalizeBrowserLane({ lane: 'web:subtitle', text: 'Run this command', metadata: m }, stamp)).toBeUndefined()
  })

  it('fills optional metadata without replacing browser identity', () => {
    const f = fixture()
    f.state.ingest(f.video({ title: '' }))
    expect(f.state.enrich({ media_id: 'youtube:one', title: 'Verified title', episode: 2, observed_at: 1000 })).toBe(true)
    expect(f.state.current().media?.title?.source).toBe('metadata')
    expect(f.state.current().media?.episode?.value).toBe(2)
    f.state.ingest(f.subtitle({ title: 'Caption source title' }))
    expect(f.state.current().media?.title?.source).toBe('subtitle')
    f.state.ingest(f.video())
    expect(f.state.current().media?.title?.source).toBe('browser')
    expect(f.state.enrich({ media_id: 'youtube:wrong', title: 'Wrong title', observed_at: 1000 })).toBe(false)
  })

  it('expires VAD silence rather than carrying a gap forever', () => {
    const f = fixture()
    f.state.ingest(f.video())
    f.state.dialogueActivity(false, 1000)
    f.time(3000)
    expect(f.state.current().dialogue_active).toBe('gap')
    f.time(4000)
    expect(f.state.current().dialogue_active).toBe('unknown')
  })

  it('invalidates dialogue on an optional metadata episode change and includes the episode in finish events', () => {
    const f = fixture()
    f.state.ingest(f.video({ title: 'Sample' }))
    f.state.enrich({ media_id: 'youtube:one', episode: 2, observed_at: 1000 })
    f.state.ingest(f.subtitle())
    const before = f.state.current().revision
    f.time(2000)
    f.state.enrich({ media_id: 'youtube:one', episode: 3, observed_at: 2000 })
    expect(f.state.current().revision).toBeGreaterThan(before)
    expect(f.state.current().dialogue).toBeUndefined()
    expect(f.state.finished(f.state.current().revision)).toBe(true)
    expect(f.events.at(-1)?.media.episode?.value).toBe(3)
  })

  it('clears paused gap evidence on resume', () => {
    const f = fixture()
    f.state.ingest(f.video({ isPlaying: false }))
    f.time(3000)
    f.state.ingest(f.video())
    expect(f.state.current().dialogue_active).toBe('unknown')
  })

  it('detects a seek from position even when upstream supplies no new epoch', () => {
    const f = fixture()
    f.state.ingest(f.video())
    f.state.ingest(f.subtitle())
    const delayed = f.subtitle({ text: 'Late cue' })
    f.time(2000)
    f.state.ingest(f.video({ currentTimeSec: 40 }))
    expect(f.state.ingest(delayed)).toBe(false)
    expect(f.state.current().dialogue).toBeUndefined()
  })

  it('detaches snapshots and survives event port failures', () => {
    const f = fixture()
    f.state.ingest(f.video())
    const snapshot = f.state.current()
    snapshot.media!.title!.value = 'Mutated'
    expect(f.state.current().media?.title?.value).toBe('Sample Episode 3')
    const state = new WatchState({ now: () => 1000, events: { publish: () => {
      throw new Error('consumer failure')
    } } })
    state.connect(1)
    expect(state.ingest(f.video())).toBe(true)
  })
})

describe('fresh R5 hints', () => {
  function world(at = 1100, title = 'Other show'): CurrentWorld {
    return { status: 'fresh', uncertain_objects: [], observation: observation({ captured_at: at, valid_until: at + 4000, scene_type: 'media', concise_summary: 'A bright garden.', media: { detected: true, playback: 'paused', title_like_text: title, subtitle_like_text: 'Visual words' } }) }
  }

  it('keeps browser title and playback when a visual title conflicts', () => {
    const f = fixture()
    f.state.ingest(f.video())
    f.time(1100)
    f.state.fuse({ current: () => world() })
    const state = f.state.current()
    expect(state.media?.title?.value).toBe('Sample Episode 3')
    expect(state.playback?.value).toBe('playing')
    expect(state.conflicts).toEqual(['title-conflict'])
    expect(state.scene?.value).toBe('A bright garden.')
  })

  it('rejects stale observations and expires a fresh hint without renewal', () => {
    const f = fixture()
    f.state.ingest(f.video())
    f.time(1100)
    f.state.fuse({ current: () => world() })
    f.time(5200)
    f.state.fuse({ current: () => world() })
    expect(f.state.current().scene).toBeUndefined()
    f.state.fuse({ current: () => world(1000) })
    expect(f.state.current().scene).toBeUndefined()
  })

  it('never proves playback or an episode from one visual frame', () => {
    const f = fixture()
    f.time(1100)
    f.state.fuse({ current: () => world(1100, 'Episode 9') })
    expect(f.state.current().playback).toBeUndefined()
    expect(f.state.current().media?.episode).toBeUndefined()
    expect(f.state.current().visual_title?.confidence).toBeLessThanOrEqual(0.6)
  })

  it('clears perception immediately on privacy blocking while browser captions work', () => {
    const f = fixture()
    f.state.ingest(f.video())
    f.time(1100)
    f.state.fuse({ current: () => world() })
    f.state.fuse({ current: () => ({ status: 'blocked-by-privacy' }) })
    f.state.ingest(f.subtitle({ text: 'Safe browser caption' }))
    expect(f.state.current().scene).toBeUndefined()
    expect(f.state.current().dialogue?.value).toBe('Safe browser caption')
    expect(f.state.current().perception_blocked).toBe(true)
  })

  it('rejects an old visual hint after a video change', () => {
    const f = fixture()
    f.state.ingest(f.video())
    f.time(2000)
    f.timeline()
    f.state.ingest(f.video({ videoId: 'two' }))
    f.state.fuse({ current: () => world(1100) })
    expect(f.state.current().scene).toBeUndefined()
  })
})
