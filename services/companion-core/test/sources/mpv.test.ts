import type { SubtitleUpdate, VideoUpdate } from '../../src/watch/contracts'
import type { PlayerEndReason, PlayerObservation } from '../../src/watch/sources'

import { Buffer } from 'node:buffer'

import { afterEach, describe, expect, it } from 'vitest'

import { MpvAdapter } from '../../src/companion/sources/mpv'
import { FakeMpv } from '../support/fake-mpv'

const ITEM = '0123456789abcdef0123456789abcdef'

let mpv: FakeMpv | undefined
let adapter: MpvAdapter | undefined

afterEach(async () => {
  await adapter?.stop()
  await mpv?.close()
  adapter = undefined
  mpv = undefined
})

/** Waits for a condition that real pipe I/O makes true. */
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function playing(properties: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'pause': false,
    'speed': 1,
    'duration': 1420.5,
    'time-pos': 61.25,
    'sid': 1,
    'secondary-sid': false,
    'track-list': [
      { id: 1, type: 'video', codec: 'h264', selected: true },
      { 'id': 1, 'type': 'sub', 'codec': 'ass', 'lang': 'eng', 'selected': true, 'main-selection': 0 },
      { id: 2, type: 'sub', codec: 'hdmv_pgs_subtitle', lang: 'jpn', selected: false },
    ],
    'sub-text': '',
    'sub-delay': 0,
    'sub-speed': 1,
    'mpv-version': 'mpv v0.41.0-244-gaf9c81fa1',
    ...properties,
  }
}

const LOCAL_FILE = { 'path': 'D:\\Anime\\Frieren\\[SubsPlease] Sousou no Frieren - 13 (1080p) [A1B2C3D4].mkv', 'media-title': '[SubsPlease] Sousou no Frieren - 13 (1080p) [A1B2C3D4].mkv' }

/** Opens a file the way mpv announces it: path and title change, then `file-loaded`. */
function load(fake: FakeMpv, properties: Record<string, unknown> = LOCAL_FILE): void {
  for (const [name, value] of Object.entries(properties))
    fake.set(name, value)
  fake.event('file-loaded')
}

async function start(properties: Record<string, unknown> = playing(), player: 'mpv' | 'jellyfin-media-player' = 'mpv') {
  mpv = new FakeMpv(properties)
  await mpv.listen()
  const observations: PlayerObservation[] = []
  const gone: Array<{ player: string, reason: PlayerEndReason }> = []
  adapter = new MpvAdapter({ endpoints: [{ pipe: mpv.pipe, player }], now: Date.now, heartbeatMs: 60_000, retryMs: 50, maxRetryMs: 100 })
  adapter.start({ observe: observation => observations.push(observation), gone: (key, reason) => gone.push({ player: key, reason }) })
  await until(() => adapter!.status().connection === 'connected')
  const videos = () => observations.flatMap(observation => observation.update.kind === 'video' ? [observation.update] : [])
  const subtitles = () => observations.flatMap(observation => observation.update.kind === 'subtitle' ? [observation.update as SubtitleUpdate] : [])
  return { mpv, observations, gone, videos, subtitles }
}

describe('mpv adapter', () => {
  it('asks only read-only property commands of the allowlist', async () => {
    const f = await start()
    load(f.mpv)
    await until(() => f.videos().length > 0)
    const names = new Set(['observe_property', 'get_property'])
    expect(f.mpv.commands.every(command => names.has(command[0] as string))).toBe(true)
    expect(f.mpv.commands.some(command => command[0] === 'get_property' && command[1] === 'time-pos')).toBe(true)
  })

  it('reports a loaded file with parsed identity and without its path', async () => {
    const f = await start()
    load(f.mpv)
    await until(() => f.videos().length > 0)
    const video = f.videos()[0] as VideoUpdate
    expect(video.media).toMatchObject({ site: 'local', player: 'mpv', title: { value: 'Sousou no Frieren', source: 'player' }, episode: { value: 13 } })
    expect(video.media.id).toMatch(/^local:[0-9a-f]{16}$/)
    expect(video).toMatchObject({ playing: true, position: 61.25, duration: 1420.5, rate: 1, source: 'player', captions: { form: 'text', codec: 'ass', language: 'en' } })
    expect(JSON.stringify(f.observations)).not.toContain('Anime\\\\Frieren')
    expect(f.observations[0].player).toMatchObject({ key: `mpv:${f.mpv.pipe}`, kind: 'mpv', reach: 'direct', eligible: true, links: [] })
  })

  it('reports pause, and a seek as a new timeline', async () => {
    const f = await start()
    load(f.mpv)
    await until(() => f.videos().length === 1)
    f.mpv.set('time-pos', 62)
    f.mpv.set('pause', true)
    await until(() => f.videos().length === 2)
    expect(f.videos()[1]).toMatchObject({ playing: false, position: 62 })
    f.mpv.event('seek')
    f.mpv.set('time-pos', 600)
    f.mpv.event('playback-restart')
    await until(() => f.videos().length === 3)
    expect(f.videos()[2].stamp.timeline).toBe(f.videos()[1].stamp.timeline + 1)
    expect(f.videos()[2].position).toBe(600)
  })

  it('reports the current dialogue with playback cue times and keeps signs out', async () => {
    const f = await start()
    load(f.mpv)
    await until(() => f.videos().length === 1)
    f.mpv.set('sub-delay', 0.5)
    f.mpv.properties['sub-start'] = 60
    f.mpv.properties['sub-end'] = 62.5
    f.mpv.properties['sub-text/ass-full'] = [
      'Dialogue: 0,0:01:00.00,0:01:02.50,Default,,0000,0000,0000,,フリーレン様、\\N行きましょう。',
      'Dialogue: 0,0:01:00.00,0:01:02.50,Sign_Shop,,0000,0000,0000,,{\\pos(320,80)}Bakery',
    ].join('\n')
    f.mpv.set('sub-text', 'フリーレン様、\n行きましょう。\nBakery')
    await until(() => f.subtitles().length === 1)
    expect(f.subtitles()[0]).toMatchObject({ text: 'フリーレン様、\n行きましょう。', language: 'en', start_ms: 60_500, end_ms: 63_000, automatic: false })
    expect(f.subtitles()[0].stamp.timeline).toBe(f.videos()[0].stamp.timeline)
  })

  it('reports a timed gap after a cue with a known end, and an unknown state otherwise', async () => {
    const f = await start()
    load(f.mpv)
    await until(() => f.videos().length === 1)
    f.mpv.properties['sub-start'] = 60
    f.mpv.properties['sub-end'] = 62
    f.mpv.properties['sub-text/ass-full'] = 'Dialogue: 0,0:01:00.00,0:01:02.00,Default,,0000,0000,0000,,Hello'
    f.mpv.set('sub-text', 'Hello')
    await until(() => f.subtitles().length === 1)
    f.mpv.properties['sub-text/ass-full'] = ''
    f.mpv.properties['sub-start'] = undefined
    f.mpv.properties['sub-end'] = undefined
    f.mpv.set('sub-text', '')
    await until(() => f.subtitles().length === 2)
    expect(f.subtitles()[1]).toMatchObject({ text: '' })
    expect(f.subtitles()[1].cleared).toBeUndefined()
    f.mpv.properties['sub-text/ass-full'] = 'Dialogue: 0,0:01:05.00,0:00:00.00,Default,,0000,0000,0000,,Unknown end'
    f.mpv.properties['sub-start'] = 65
    f.mpv.set('sub-text', 'Unknown end')
    await until(() => f.subtitles().length === 3)
    f.mpv.properties['sub-text/ass-full'] = ''
    f.mpv.set('sub-text', '')
    await until(() => f.subtitles().length === 4)
    expect(f.subtitles()[3]).toMatchObject({ text: '', cleared: true })
  })

  it('uses full ASS events on a build whose version names no release', async () => {
    const f = await start(playing({ 'mpv-version': 'mpv 9f8e7d6' }))
    load(f.mpv)
    await until(() => f.videos().length === 1)
    // A sign style without placement tags: only the style name tells it apart from dialogue.
    f.mpv.properties['sub-text/ass-full'] = ['Dialogue: 0,0:01:00.00,0:01:02.00,Signs,,0000,0000,0000,,Bakery', 'Dialogue: 0,0:01:00.00,0:01:02.00,Default,,0000,0000,0000,,Where are we going?'].join('\n')
    f.mpv.properties['sub-end'] = 62
    f.mpv.set('sub-text', 'Bakery\nWhere are we going?')
    await until(() => f.subtitles().length === 1)
    expect(f.subtitles()[0].text).toBe('Where are we going?')
    expect(adapter!.status().limitations).not.toContain('ass-styles-unavailable')
  })

  it('falls back to event text tags when this mpv has no full ASS events', async () => {
    const f = await start(playing({ 'mpv-version': 'mpv 1c9c2f5' }))
    f.mpv.unknownProperties.add('sub-text/ass-full')
    load(f.mpv)
    await until(() => f.videos().length === 1)
    f.mpv.properties['sub-text-ass'] = '{\\pos(320,80)}Bakery\nWhere are we going?'
    f.mpv.properties['sub-end'] = 62
    f.mpv.set('sub-text', 'Bakery\nWhere are we going?')
    await until(() => f.subtitles().length === 1)
    expect(f.subtitles()[0].text).toBe('Where are we going?')
    expect(adapter!.status().limitations).toContain('ass-styles-unavailable')
  })

  it('keeps a secondary subtitle beside the primary one', async () => {
    const f = await start(playing({ 'secondary-sid': 2, 'track-list': [
      { 'id': 1, 'type': 'sub', 'codec': 'subrip', 'lang': 'eng', 'selected': true, 'main-selection': 0 },
      { 'id': 2, 'type': 'sub', 'codec': 'subrip', 'lang': 'jpn', 'selected': true, 'main-selection': 1 },
    ] }))
    load(f.mpv)
    await until(() => f.videos().length === 1)
    f.mpv.properties['sub-text/ass-full'] = 'Dialogue: 0,0:01:00.00,0:01:02.00,Default,,0000,0000,0000,,Where to?'
    f.mpv.properties['secondary-sub-text'] = 'どこへ？'
    f.mpv.properties['sub-end'] = 62
    f.mpv.set('sub-text', 'Where to?')
    await until(() => f.subtitles().length === 1)
    expect(f.subtitles()[0]).toMatchObject({ text: 'Where to?', language: 'en', secondary: { text: 'どこへ？', language: 'ja' } })
    expect(f.videos()[0].captions).toMatchObject({ form: 'text', secondary: { form: 'text', language: 'ja' } })
  })

  it('reports image subtitles without text and starts a new timeline on a track switch', async () => {
    const f = await start()
    load(f.mpv)
    await until(() => f.videos().length === 1)
    f.mpv.set('track-list', [
      { id: 1, type: 'sub', codec: 'ass', lang: 'eng', selected: false },
      { 'id': 2, 'type': 'sub', 'codec': 'hdmv_pgs_subtitle', 'lang': 'jpn', 'selected': true, 'main-selection': 0 },
    ])
    f.mpv.set('sid', 2)
    await until(() => f.videos().length === 2)
    expect(f.videos()[1].captions).toMatchObject({ form: 'image', language: 'ja' })
    expect(f.videos()[1].stamp.timeline).toBe(f.videos()[0].stamp.timeline + 1)
    f.mpv.set('sub-text', '')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(f.subtitles()).toHaveLength(0)
    expect(adapter!.status().limitations).toContain('image-subtitles')
  })

  it('links a Jellyfin Media Player stream to its library item and keeps the URL and token out', async () => {
    const f = await start(playing(), 'jellyfin-media-player')
    load(f.mpv, { 'path': `https://jf.example/Videos/${ITEM}/stream.mkv?Static=true&api_key=secret-token`, 'media-title': 'stream.mkv' })
    await until(() => f.videos().length === 1)
    const video = f.videos()[0]
    expect(video.media).toMatchObject({ id: `jellyfin:${ITEM}`, site: 'jellyfin', player: 'jellyfin-media-player' })
    expect(video.media.title).toBeUndefined()
    expect(video.jellyfin).toEqual({ item: ITEM })
    expect(f.observations[0].player.links).toEqual([`jf-item:${ITEM}`])
    expect(JSON.stringify(f.observations)).not.toContain('secret-token')
    expect(JSON.stringify(f.observations)).not.toContain('jf.example')
  })

  it('confirms an episode end only from a natural end of file', async () => {
    const f = await start()
    load(f.mpv)
    await until(() => f.videos().length === 1)
    f.mpv.event('end-file', { reason: 'eof' })
    await until(() => f.gone.length === 1)
    expect(f.videos().at(-1)).toMatchObject({ ended: true, playing: false })
    expect(f.gone[0].reason).toBe('stopped')
    const session = f.videos()[0].stamp.session
    load(f.mpv)
    await until(() => f.videos().length === 3)
    expect(f.videos()[2].stamp.session).toBeGreaterThan(session)
    f.mpv.event('end-file', { reason: 'stop' })
    await until(() => f.gone.length === 2)
    expect(f.videos().filter(video => video.ended)).toHaveLength(1)
  })

  it('reports a player exit and follows the player again when it comes back', async () => {
    const f = await start()
    load(f.mpv)
    await until(() => f.videos().length === 1)
    const session = f.videos()[0].stamp.session
    f.mpv.dropClients()
    await until(() => f.gone.length === 1)
    expect(f.gone[0].reason).toBe('player-exited')
    // The file still plays after the reconnect, so the adapter reports it without a new file-loaded event.
    await until(() => f.videos().length === 2)
    expect(f.videos()[1].stamp.session).toBeGreaterThan(session)
    expect(f.videos()[1].media.title?.value).toBe('Sousou no Frieren')
  })

  it('reports a file that already plays when it connects, once', async () => {
    const f = await start(playing(LOCAL_FILE))
    await until(() => f.videos().length === 1)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(f.videos()).toHaveLength(1)
    expect(f.videos()[0].position).toBe(61.25)
  })

  it('waits quietly while no player has the pipe open', async () => {
    adapter = new MpvAdapter({ endpoints: [{ pipe: 'airi-test-missing', player: 'mpv' }], now: Date.now, retryMs: 20, maxRetryMs: 40 })
    adapter.start({ observe: () => {}, gone: () => {} })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(adapter.status()).toMatchObject({ adapter: 'mpv', connection: 'waiting', players: 0 })
  })

  it('ignores broken lines and replaces invalid UTF-8', async () => {
    const f = await start()
    load(f.mpv)
    await until(() => f.videos().length === 1)
    f.mpv.raw('{not json\n')
    f.mpv.raw(Buffer.concat([Buffer.from('{"event":"property-change","id":7,"name":"media-title","data":"Bad '), Buffer.from([0xFF, 0xFE]), Buffer.from(' title.mkv"}\n')]))
    f.mpv.event('playback-restart')
    await until(() => f.videos().length >= 2)
    expect(adapter!.status().connection).toBe('connected')
  })

  it('refuses a pipe name that leaves the local pipe namespace', () => {
    expect(() => new MpvAdapter({ endpoints: [{ pipe: '..\\..\\server\\pipe\\x', player: 'mpv' }], now: Date.now })).toThrow(/pipe name/i)
  })
})
