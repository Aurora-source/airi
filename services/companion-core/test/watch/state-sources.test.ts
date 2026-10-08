import type { SubtitleUpdate, VideoUpdate, WatchEventPort } from '../../src/watch/contracts'

import { describe, expect, it } from 'vitest'

import { normalizeBrowserLane } from '../../src/watch/browser'
import { WatchState } from '../../src/watch/state'

describe('jellyfin web lanes', () => {
  const stamp = { session: 1, sequence: 1, observed_at: 1000, timeline: 0 }
  const meta = { source: 'web-extension', site: 'jellyfin', url: 'https://media.example.com/web/', videoId: '0123456789abcdef0123456789abcdef', title: 'Frieren' }

  it('keeps the validated Jellyfin ids of a page', () => {
    const update = normalizeBrowserLane({ lane: 'web:video', metadata: { ...meta, isPlaying: true, jellyfin: { deviceId: 'TW96aWxsYQ11', itemId: '0123456789ABCDEF0123456789ABCDEF' } } }, stamp)
    expect(update).toMatchObject({ kind: 'video', media: { id: 'jellyfin:0123456789abcdef0123456789abcdef', site: 'jellyfin' }, jellyfin: { device: 'TW96aWxsYQ11', item: '0123456789abcdef0123456789abcdef' } })
  })

  it('drops malformed ids instead of repairing them', () => {
    const update = normalizeBrowserLane({ lane: 'web:video', metadata: { ...meta, jellyfin: { deviceId: 'bad"id', itemId: 'not-an-id' } } }, stamp)
    expect(update).toMatchObject({ kind: 'video' })
    expect((update as { jellyfin?: unknown }).jellyfin).toBeUndefined()
  })

  it('reads Japanese from kana when a caption names no language', () => {
    const update = normalizeBrowserLane({ lane: 'web:subtitle', text: 'Subtitle: ‎どこへ行くの？', metadata: { ...meta } }, stamp)
    expect(update).toMatchObject({ kind: 'subtitle', text: 'どこへ行くの？', language: 'ja' })
  })

  it('keeps multi-line and secondary captions', () => {
    const update = normalizeBrowserLane({ lane: 'web:subtitle', text: 'Subtitle: フリーレン様、\n行きましょう。', metadata: { ...meta, secondary: { text: 'Let us go,\nFrieren.', language: 'en' } } }, stamp)
    expect(update).toMatchObject({ kind: 'subtitle', text: 'フリーレン様、\n行きましょう。', secondary: { text: 'Let us go,\nFrieren.', language: 'en' } })
  })
})

/** Updates as a player source composes them: library identity, direct player playback, and player subtitles. */
function fixture() {
  let now = 10_000
  let sequence = 0
  let timeline = 0
  const events: Array<Parameters<WatchEventPort['publish']>[0]> = []
  const state = new WatchState({ now: () => now, events: { publish: event => events.push(event) } })
  state.connect(1)
  const stamp = () => ({ session: 1, sequence: ++sequence, observed_at: now, timeline })
  const video = (fields: Partial<Omit<VideoUpdate, 'kind' | 'stamp'>> & { title?: string, episode?: number, season?: number } = {}): VideoUpdate => {
    const at = now
    const { title = 'Sousou no Frieren', episode, season, ...rest } = fields
    const evidence = <T>(value: T) => ({ value, source: 'metadata' as const, confidence: 0.95, observed_at: at, valid_until: at + 35_000 })
    return {
      kind: 'video',
      stamp: stamp(),
      media: { id: 'jellyfin:item13', site: 'jellyfin', player: 'jellyfin-media-player', title: evidence(title), episode: episode === undefined ? undefined : evidence(episode), season: season === undefined ? undefined : evidence(season) },
      playing: true,
      position: 100,
      rate: 1,
      source: 'player',
      ...rest,
    }
  }
  const subtitle = (fields: Partial<Omit<SubtitleUpdate, 'kind' | 'stamp'>> = {}): SubtitleUpdate => ({ kind: 'subtitle', stamp: stamp(), media_id: 'jellyfin:item13', text: 'Where are we going?', language: 'en', automatic: false, ...fields })
  return { state, events, video, subtitle, time: (value: number) => {
    now = value
  }, timeline: () => {
    timeline++
  } }
}

describe('watch state with player sources', () => {
  it('names the player source of playback evidence', () => {
    const f = fixture()
    expect(f.state.ingest(f.video())).toBe(true)
    expect(f.state.current().playback).toMatchObject({ value: 'playing', source: 'player', confidence: 0.95 })
    expect(f.state.current().position).toMatchObject({ value: 100, source: 'player' })
  })

  it('gives server-reported playback a lower confidence', () => {
    const f = fixture()
    f.state.ingest(f.video({ source: 'server' }))
    expect(f.state.current().playback).toMatchObject({ source: 'server', confidence: 0.7 })
    expect(f.state.current().position).toMatchObject({ source: 'server', confidence: 0.6 })
  })

  it('treats a newly known episode of the same media as enrichment, not a new watch', () => {
    const f = fixture()
    f.state.ingest(f.video())
    f.state.ingest(f.subtitle())
    f.time(11_000)
    f.state.ingest(f.video({ episode: 13, season: 1, position: 101 }))
    expect(f.state.current().media?.episode?.value).toBe(13)
    expect(f.state.current().media?.season?.value).toBe(1)
    expect(f.state.current().dialogue?.value).toBe('Where are we going?')
    expect(f.events.map(event => event.kind)).toEqual(['started'])
  })

  it('still starts a new watch when a known episode changes', () => {
    const f = fixture()
    f.state.ingest(f.video({ episode: 13 }))
    f.time(11_000)
    f.timeline()
    f.state.ingest(f.video({ episode: 14, position: 0 }))
    expect(f.events.map(event => event.kind)).toEqual(['started', 'stopped', 'started'])
  })

  it('keeps a secondary subtitle line beside the primary one', () => {
    const f = fixture()
    f.state.ingest(f.video())
    f.state.ingest(f.subtitle({ text: 'Where are we going?', secondary: { text: 'どこへ行くの？', language: 'ja' } }))
    expect(f.state.current().dialogue).toMatchObject({ value: 'Where are we going?', language: 'en', secondary: { text: 'どこへ行くの？', language: 'ja' } })
  })

  it('gives subtitles with estimated timing a lower confidence', () => {
    const f = fixture()
    f.state.ingest(f.video())
    f.state.ingest(f.subtitle({ sync: 'estimated' }))
    expect(f.state.current().dialogue?.confidence).toBe(0.6)
  })
})
