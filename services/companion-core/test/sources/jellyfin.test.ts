import type { SubtitleUpdate, VideoUpdate } from '../../src/watch/contracts'
import type { CueRequest } from '../../src/watch/source-manager'
import type { PlayerEndReason, PlayerObservation } from '../../src/watch/sources'

import { afterEach, describe, expect, it } from 'vitest'

import { JellyfinAdapter } from '../../src/companion/sources/jellyfin'
import { serverBase } from '../../src/companion/sources/network'
import { FakeJellyfin, ITEM, OTHER_USER_ID, session, SOURCE, TOKEN } from '../support/fake-jellyfin'

let jellyfin: FakeJellyfin | undefined
let adapter: JellyfinAdapter | undefined

afterEach(async () => {
  await adapter?.stop()
  await jellyfin?.close()
  adapter = undefined
  jellyfin = undefined
})

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const noLookup = async () => []

async function start(options: { token?: string, devices?: string[], hostname?: string } = {}) {
  jellyfin = new FakeJellyfin()
  const base = await jellyfin.listen()
  const observations: PlayerObservation[] = []
  const gone: Array<{ key: string, reason: PlayerEndReason }> = []
  adapter = new JellyfinAdapter({ base: serverBase(base), token: 'token' in options ? options.token : TOKEN, now: Date.now, hostname: options.hostname ?? 'LIVING-PC', lookup: noLookup, followThisComputer: true, devices: options.devices ?? [], serverSubtitles: true, pollMs: 20, idlePollMs: 20, heartbeatMs: 60_000, retryMs: 20, maxRetryMs: 40 })
  adapter.start({ observe: observation => observations.push(observation), gone: (key, reason) => gone.push({ key, reason }) })
  const videos = () => observations.flatMap(observation => observation.update.kind === 'video' ? [{ player: observation.player, update: observation.update as VideoUpdate }] : [])
  const subtitles = () => observations.flatMap(observation => observation.update.kind === 'subtitle' ? [{ player: observation.player, update: observation.update as SubtitleUpdate }] : [])
  return { jellyfin, observations, gone, videos, subtitles }
}

describe('jellyfin adapter', () => {
  it('asks nothing without a stored token', async () => {
    const f = await start({ token: undefined })
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(f.jellyfin.requests).toHaveLength(0)
    expect(adapter!.status()).toMatchObject({ connection: 'unauthorized', error: 'no-token' })
  })

  it('sends the token only in the Authorization header of read requests', async () => {
    const f = await start()
    f.jellyfin.sessions = [session()]
    await until(() => f.videos().length > 0)
    expect(f.jellyfin.requests.every(request => request.method === 'GET')).toBe(true)
    expect(f.jellyfin.requests.every(request => !request.url.includes(TOKEN) && !/api_?key/i.test(request.url))).toBe(true)
    expect(f.jellyfin.requests.find(request => request.url.startsWith('/Users/Me'))?.authorization).toMatch(/^MediaBrowser Client="AIRI Companion", Device="LIVING-PC", DeviceId="airi-[0-9a-f]{32}", Version="[\d.]+", Token="0123456789abcdef0123456789abcdef"$/)
  })

  it('reports library identity and estimated server playback without plot text', async () => {
    const f = await start()
    f.jellyfin.sessions = [session()]
    await until(() => f.videos().length > 0)
    const { player, update } = f.videos()[0]
    expect(player).toEqual({ key: 'jellyfin:session1', kind: 'jellyfin-media-player', reach: 'server', eligible: true, links: ['jf-device:device-jmp', `jf-item:${ITEM}`] })
    expect(update.media).toMatchObject({ id: `jellyfin:${ITEM}`, site: 'jellyfin', player: 'jellyfin-media-player', title: { value: 'Sousou no Frieren', source: 'metadata', confidence: 0.95 }, episode: { value: 13 }, season: { value: 1 } })
    expect(update).toMatchObject({ playing: true, source: 'server', rate: 1, duration: 1420, captions: { form: 'text', language: 'en', codec: 'ass' }, jellyfin: { device: 'device-jmp', item: ITEM, media_source: SOURCE, subtitle_stream: 2 } })
    // 60 s reported 2 s ago while playing.
    expect(update.position).toBeGreaterThan(61.5)
    expect(update.position).toBeLessThan(63)
    expect(JSON.stringify(f.observations)).not.toContain('SECRET PLOT')
    expect(JSON.stringify(f.observations)).not.toContain('Hero\'s Funeral')
  })

  it('drops sessions of other users even with an administrator token', async () => {
    const f = await start()
    f.jellyfin.admin = true
    f.jellyfin.sessions = [session({ Id: 'theirs', UserId: OTHER_USER_ID, DeviceId: 'their-tv' }), session()]
    await until(() => f.videos().length > 0)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(f.observations.every(observation => observation.player.key === 'jellyfin:session1')).toBe(true)
    expect(JSON.stringify(adapter!.status())).not.toContain('their-tv')
    expect(adapter!.status().limitations).toContain('administrator-token')
  })

  it('marks other devices as not eligible and keeps item links for followed devices only', async () => {
    const f = await start()
    f.jellyfin.sessions = [session({ Id: 'web', Client: 'Jellyfin Web', DeviceName: 'Chrome', DeviceId: 'web-device' }), session({ Id: 'tv', Client: 'Jellyfin Android TV', DeviceName: 'Living Room TV', DeviceId: 'tv-device' })]
    await until(() => f.videos().length >= 2)
    const byKey = Object.fromEntries(f.videos().map(entry => [entry.player.key, entry.player]))
    expect(byKey['jellyfin:web']).toEqual({ key: 'jellyfin:web', kind: 'jellyfin-web', reach: 'server', eligible: false, links: ['jf-device:web-device'] })
    expect(byKey['jellyfin:tv']).toMatchObject({ kind: 'jellyfin-client', eligible: false })
  })

  it('follows a device that the user configured', async () => {
    const f = await start({ devices: ['Living Room TV'] })
    f.jellyfin.sessions = [session({ Id: 'tv', Client: 'Jellyfin Android TV', DeviceName: 'Living Room TV', DeviceId: 'tv-device' })]
    await until(() => f.videos().length > 0)
    expect(f.videos()[0].player).toMatchObject({ eligible: true, links: ['jf-device:tv-device', `jf-item:${ITEM}`] })
  })

  it('reports pause, an item change as a new timeline, and the end of a session', async () => {
    const f = await start()
    f.jellyfin.sessions = [session()]
    await until(() => f.videos().length === 1)
    f.jellyfin.sessions = [session({}, {}, { IsPaused: true })]
    await until(() => f.videos().length === 2)
    expect(f.videos()[1].update.playing).toBe(false)
    f.jellyfin.sessions = [session({}, { Id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', IndexNumber: 14 }, { IsPaused: false, PositionTicks: 0, MediaSourceId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })]
    await until(() => f.videos().length === 3)
    expect(f.videos()[2].update.stamp.timeline).toBe(f.videos()[1].update.stamp.timeline + 1)
    expect(f.videos()[2].update.media.episode?.value).toBe(14)
    f.jellyfin.sessions = []
    await until(() => f.gone.length === 1)
    expect(f.gone[0]).toEqual({ key: 'jellyfin:session1', reason: 'stopped' })
  })

  it('treats a playing session without a recent client report as not current', async () => {
    const f = await start()
    f.jellyfin.sessions = [session({ LastPlaybackCheckIn: new Date(Date.now() - 120_000).toISOString() })]
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(f.observations).toHaveLength(0)
  })

  it('ignores its own device session', async () => {
    const f = await start()
    await until(() => adapter!.status().connection === 'connected')
    const own = f.jellyfin.requests[1].authorization!.match(/DeviceId="([^"]+)"/)![1]
    f.jellyfin.sessions = [session({ DeviceId: own, Id: 'self' })]
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(f.observations).toHaveLength(0)
  })

  it('reports a refused token and ends followed sessions', async () => {
    const f = await start()
    f.jellyfin.sessions = [session()]
    await until(() => f.videos().length === 1)
    f.jellyfin.override = (_req, res) => {
      res.writeHead(401).end()
      return true
    }
    await until(() => adapter!.status().connection === 'unauthorized')
    expect(f.gone).toEqual([{ key: 'jellyfin:session1', reason: 'disconnected' }])
  })

  it('refuses redirects and waits through an outage', async () => {
    const f = await start()
    f.jellyfin.override = (_req, res) => {
      res.writeHead(302, { Location: 'https://elsewhere.example/' }).end()
      return true
    }
    await until(() => adapter!.status().error === 'redirect-refused')
    expect(f.jellyfin.requests.filter(request => request.url.includes('elsewhere'))).toHaveLength(0)
    f.jellyfin.override = (req, _res) => {
      req.socket.destroy()
      return true
    }
    await until(() => adapter!.status().connection === 'waiting')
    f.jellyfin.override = undefined
    f.jellyfin.sessions = [session()]
    await until(() => f.videos().length === 1)
  })

  it('never sends a token over plain http to a public address', async () => {
    const observations: PlayerObservation[] = []
    adapter = new JellyfinAdapter({ base: serverBase('http://8.8.8.8:8096'), token: TOKEN, now: Date.now, hostname: 'LIVING-PC', lookup: noLookup, followThisComputer: true, devices: [], serverSubtitles: true, retryMs: 20, maxRetryMs: 40 })
    adapter.start({ observe: observation => observations.push(observation), gone: () => {} })
    await until(() => adapter!.status().error === 'insecure-http')
    expect(adapter.status().connection).toBe('error')
  })
})

describe('jellyfin cue window', () => {
  function request(position: () => number, fields: Partial<CueRequest> = {}): CueRequest {
    return { player: 'jellyfin:session1', item: ITEM, media_source: SOURCE, index: 2, sync: 'exact', session: 1, timeline: 0, playing: true, position, language: 'en', ...fields }
  }

  it('asks for one instant only and reports the cue that shows now', async () => {
    const f = await start()
    f.jellyfin.cues = [
      { Text: 'Where are we going?', StartPositionTicks: 10_000_000, EndPositionTicks: 30_000_000 },
      { Text: 'FUTURE LINE', StartPositionTicks: 50_000_000, EndPositionTicks: 70_000_000 },
    ]
    const startedAt = Date.now()
    adapter!.followCues(request(() => 1.5 + (Date.now() - startedAt) / 1000))
    await until(() => f.subtitles().length === 1)
    const cue = f.subtitles()[0]
    expect(cue.update).toMatchObject({ text: 'Where are we going?', start_ms: 1000, end_ms: 3000, language: 'en', sync: 'exact', automatic: false })
    expect(cue.player).toEqual({ key: 'jellyfin-cues:jellyfin:session1', kind: 'jellyfin-client', reach: 'server', eligible: true, links: [`jf-item:${ITEM}`] })
    const lookups = f.jellyfin.requests.filter(entry => entry.url.includes('/Stream.js'))
    for (const lookup of lookups) {
      const url = new URL(lookup.url, 'http://x')
      expect(url.searchParams.get('startPositionTicks')).toBe(url.searchParams.get('endPositionTicks'))
      expect(url.searchParams.get('copyTimestamps')).toBe('true')
    }
    expect(JSON.stringify(f.observations)).not.toContain('FUTURE')
  })

  it('reports a timed gap after the cue ends and adds a margin to estimated timing', async () => {
    const f = await start()
    f.jellyfin.cues = [{ Text: '{\\pos(10,10)}Sign{\\N}', StartPositionTicks: 0, EndPositionTicks: 900_000_000 }, { Text: 'Short line', StartPositionTicks: 10_000_000, EndPositionTicks: 10_300_000 }]
    const startedAt = Date.now()
    adapter!.followCues(request(() => 1.01 + (Date.now() - startedAt) / 1000, { sync: 'estimated' }))
    await until(() => f.subtitles().length === 2)
    expect(f.subtitles()[0].update).toMatchObject({ text: 'Short line', end_ms: 1030 + 600, sync: 'estimated' })
    expect(f.subtitles()[1].update.text).toBe('')
    expect(f.subtitles()[1].update.cleared).toBeUndefined()
  })

  it('stops looking up when the request ends', async () => {
    const f = await start()
    adapter!.followCues(request(() => 5))
    await until(() => f.jellyfin.requests.some(entry => entry.url.includes('/Stream.js')))
    adapter!.followCues(undefined)
    const count = f.jellyfin.requests.filter(entry => entry.url.includes('/Stream.js')).length
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(f.jellyfin.requests.filter(entry => entry.url.includes('/Stream.js')).length).toBe(count)
  })
})
