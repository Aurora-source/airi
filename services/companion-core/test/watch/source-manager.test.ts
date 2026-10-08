import type { CaptionTrack, JellyfinRef, MediaIdentity, SubtitleUpdate, VideoUpdate } from '../../src/watch/contracts'
import type { ManagerOutput } from '../../src/watch/source-manager'
import type { PlayerRef } from '../../src/watch/sources'

import { beforeEach, describe, expect, it } from 'vitest'

import { MediaSourceManager } from '../../src/watch/source-manager'

let clock = 100_000
const now = () => clock

function evidence<T>(value: T, source: 'metadata' | 'player' | 'browser' | 'server', confidence: number) {
  return { value, source, confidence, observed_at: clock, valid_until: clock + 35_000 }
}

/** Plays one adapter's view of one player: its connection, sequence, and timeline. */
class Feed {
  session = 1
  sequence = 0
  timeline = 0
  media: MediaIdentity
  jellyfin?: JellyfinRef
  captions?: CaptionTrack

  constructor(readonly ref: PlayerRef, media: Partial<MediaIdentity> & { id: string }) {
    this.media = { site: 'local', ...media }
  }

  video(fields: Partial<Omit<VideoUpdate, 'kind' | 'stamp' | 'media'>> = {}) {
    return { player: this.ref, update: { kind: 'video' as const, stamp: this.stamp(), media: structuredClone(this.media), playing: true, position: 10, rate: 1, source: this.ref.reach === 'server' ? 'server' as const : 'player' as const, jellyfin: this.jellyfin, captions: this.captions, ...fields } }
  }

  subtitle(text: string, fields: Partial<Omit<SubtitleUpdate, 'kind' | 'stamp'>> = {}) {
    return { player: this.ref, update: { kind: 'subtitle' as const, stamp: this.stamp(), media_id: this.media.id, text, automatic: false, ...fields } }
  }

  private stamp() {
    return { session: this.session, sequence: ++this.sequence, observed_at: clock, timeline: this.timeline }
  }
}

function ref(key: string, fields: Partial<PlayerRef> = {}): PlayerRef {
  return { key, kind: 'mpv', reach: 'direct', eligible: true, links: [], ...fields }
}

function kinds(outputs: ManagerOutput[]): string[] {
  return outputs.map(output => output.kind === 'update' ? `update:${output.update.kind}` : output.kind)
}

/** Narrows a selection result. Selecting an unknown player is a test mistake here. */
function chosen(result: ManagerOutput[] | 'unknown-player'): ManagerOutput[] {
  if (result === 'unknown-player')
    throw new Error('unknown player')
  return result
}

function updates(outputs: ManagerOutput[]) {
  return outputs.flatMap(output => output.kind === 'update' ? [output.update] : [])
}

let manager: MediaSourceManager

beforeEach(() => {
  clock = 100_000
  manager = new MediaSourceManager({ now, staleMs: 120_000, takeoverMs: 35_000, settleMs: 3000 })
})

describe('one player', () => {
  it('starts a session at the first video and restamps updates into one ordered stream', () => {
    const mpv = new Feed(ref('mpv:airi'), { id: 'local:abc', title: evidence('Frieren', 'player', 0.6) })
    const first = manager.observe(mpv.video())
    expect(kinds(first)).toEqual(['start', 'update:video'])
    const start = first[0] as Extract<ManagerOutput, { kind: 'start' }>
    clock += 500
    const second = updates(manager.observe(mpv.subtitle('Hello')))[0]
    expect(updates(first)[0].stamp).toEqual({ session: start.session, sequence: 1, observed_at: 100_000, timeline: 0 })
    expect(second.stamp).toEqual({ session: start.session, sequence: 2, observed_at: 100_500, timeline: 0 })
  })

  it('refuses old connections, repeated sequences, earlier reads, and subtitles of an older timeline', () => {
    const mpv = new Feed(ref('mpv:airi'), { id: 'local:abc' })
    manager.observe(mpv.video())
    const stale = mpv.subtitle('Before the seek')
    clock += 1000
    mpv.timeline++
    expect(updates(manager.observe(mpv.video({ position: 300 })))[0].stamp.timeline).toBe(1)
    expect(manager.observe(stale)).toEqual([])
    const replay = mpv.video()
    replay.update.stamp.sequence = 1
    expect(manager.observe(replay)).toEqual([])
    mpv.session = 0
    expect(manager.observe(mpv.video())).toEqual([])
  })

  it('starts a new playback timeline when the player reconnects', () => {
    const mpv = new Feed(ref('mpv:airi'), { id: 'local:abc' })
    manager.observe(mpv.video())
    clock += 1000
    mpv.session = 2
    mpv.sequence = 0
    const after = updates(manager.observe(mpv.video()))
    expect(after[0].stamp.timeline).toBe(1)
  })

  it('ends the session when the player exits', () => {
    const mpv = new Feed(ref('mpv:airi'), { id: 'local:abc' })
    const start = manager.observe(mpv.video())[0] as Extract<ManagerOutput, { kind: 'start' }>
    expect(manager.gone('mpv:airi', 'player-exited')).toEqual([{ kind: 'end', key: start.key, reason: 'player-exited' }])
    expect(manager.active).toBeUndefined()
  })

  it('never follows a player that is not eligible until the user selects it', () => {
    const phone = new Feed(ref('jellyfin:phone', { kind: 'jellyfin-client', reach: 'server', eligible: false }), { id: 'jellyfin:item9', site: 'jellyfin' })
    expect(manager.observe(phone.video())).toEqual([])
    expect(kinds(chosen(manager.select('jellyfin:phone')))).toEqual(['start', 'update:video'])
  })
})

describe('jellyfin correlation', () => {
  function jmp() {
    const mpv = new Feed(ref('mpv:jmp', { kind: 'jellyfin-media-player', links: ['jf-item:aaaa'] }), { id: 'jellyfin:aaaa', site: 'jellyfin', player: 'jellyfin-media-player', title: evidence('stream', 'player', 0.3) })
    mpv.jellyfin = { item: 'aaaa' }
    const server = new Feed(ref('jellyfin:s1', { kind: 'jellyfin-media-player', reach: 'server', links: ['jf-item:aaaa', 'jf-device:dev1'] }), { id: 'jellyfin:aaaa', site: 'jellyfin', player: 'jellyfin-media-player', title: evidence('Sousou no Frieren', 'metadata', 0.95), episode: evidence(13, 'metadata', 0.95), season: evidence(1, 'metadata', 0.95) })
    server.jellyfin = { item: 'aaaa', device: 'dev1', media_source: 'ms1', subtitle_stream: 3 }
    server.captions = { form: 'text', codec: 'ass', language: 'eng' }
    return { mpv, server }
  }

  it('holds a correlated player until library identity arrives, then uses it with the player clock', () => {
    const { mpv, server } = jmp()
    expect(manager.observe(mpv.video({ position: 50 }))).toEqual([])
    clock += 800
    const out = manager.observe(server.video({ position: 45 }))
    expect(kinds(out)).toEqual(['start', 'update:video'])
    const video = updates(out)[0] as VideoUpdate
    expect(video.media.title?.value).toBe('Sousou no Frieren')
    expect(video.media.episode?.value).toBe(13)
    expect(video.source).toBe('player')
    // The player observation is newer than the server report, so it keeps the clock.
    expect(video.position).toBe(50)
    expect(video.stamp.observed_at).toBe(100_000)
  })

  it('starts with what it has when library identity does not arrive in time', () => {
    const { mpv } = jmp()
    manager.observe(mpv.video())
    clock += 2999
    expect(manager.tick()).toEqual([])
    clock += 1
    mpv.sequence++
    expect(kinds(manager.tick())).toEqual(['start', 'update:video'])
  })

  it('keeps one session and revokes evidence when the playback source switches to the server', () => {
    const { mpv, server } = jmp()
    manager.observe(mpv.video())
    manager.observe(server.video())
    clock += 1000
    manager.observe(mpv.subtitle('Hello'))
    clock += 1000
    const out = manager.gone('mpv:jmp', 'disconnected')
    expect(kinds(out)).toEqual([])
    clock += 1000
    const next = manager.observe(server.video({ position: 13 }))
    expect(kinds(next)).toEqual(['update:video'])
    expect(updates(next)[0].stamp.timeline).toBe(1)
    expect((updates(next)[0] as VideoUpdate).source).toBe('server')
  })

  it('joins a Jellyfin Web page and the server session through the device id', () => {
    const page = new Feed(ref('browser:tab1', { kind: 'jellyfin-web', links: ['jf-device:web1'] }), { id: 'jellyfin:t:Frieren', site: 'jellyfin', title: evidence('Frieren', 'browser', 0.9) })
    const session = new Feed(ref('jellyfin:s2', { kind: 'jellyfin-web', reach: 'server', eligible: false, links: ['jf-device:web1', 'jf-item:bbbb'] }), { id: 'jellyfin:bbbb', site: 'jellyfin', title: evidence('Sousou no Frieren', 'metadata', 0.95), episode: evidence(5, 'metadata', 0.95) })
    session.jellyfin = { item: 'bbbb', device: 'web1' }
    expect(manager.observe(page.video())).toEqual([])
    const out = manager.observe(session.video())
    const video = updates(out)[0] as VideoUpdate
    expect(video.media.id).toBe('jellyfin:bbbb')
    expect(video.media.episode?.value).toBe(5)
    expect(video.source).toBe('player')
    expect(manager.players().filter(player => player.group === manager.active)).toHaveLength(2)
  })

  it('reports no new session when the same episode appears from a second source', () => {
    const { mpv, server } = jmp()
    const out = [...manager.observe(mpv.video()), ...manager.observe(server.video()), ...manager.observe(server.video()), ...manager.observe(mpv.video())]
    expect(kinds(out).filter(kind => kind === 'start')).toHaveLength(1)
  })

  it('forwards server cue subtitles only while no direct subtitle flows', () => {
    const { mpv, server } = jmp()
    const cues = new Feed(ref('jellyfin-cues:s1', { kind: 'jellyfin-media-player', reach: 'server', links: ['jf-item:aaaa'] }), { id: 'jellyfin:aaaa' })
    manager.observe(mpv.video())
    manager.observe(server.video())
    clock += 100
    expect(kinds(manager.observe(cues.subtitle('From the server', { sync: 'estimated' })))).toEqual(['update:subtitle'])
    clock += 100
    const direct = manager.observe(mpv.subtitle('From the player'))
    expect(kinds(direct)).toEqual(['update:video', 'update:subtitle'])
    clock += 100
    expect(manager.observe(cues.subtitle('Late server cue', { sync: 'estimated' }))).toEqual([])
  })

  it('lets server cues join a Jellyfin Web group whose server session has only a device link', () => {
    const page = new Feed(ref('browser:tab1', { kind: 'jellyfin-web', links: ['jf-device:web1'] }), { id: 'jellyfin:bbbb', site: 'jellyfin', title: evidence('Frieren', 'browser', 0.9) })
    const session = new Feed(ref('jellyfin:s2', { kind: 'jellyfin-web', reach: 'server', eligible: false, links: ['jf-device:web1'] }), { id: 'jellyfin:bbbb', site: 'jellyfin', title: evidence('Sousou no Frieren', 'metadata', 0.95) })
    session.jellyfin = { item: 'bbbb', device: 'web1', media_source: 'ms', subtitle_stream: 2 }
    session.captions = { form: 'text', codec: 'ass' }
    manager.observe(page.video({ position: 30 }))
    manager.observe(session.video())
    const request = manager.cueRequest()!
    expect(request.links).toEqual(['jf-device:web1'])
    const cues = new Feed(ref('jellyfin-cues:jellyfin:s2', { kind: 'jellyfin-client', reach: 'server', links: request.links }), { id: 'jellyfin:bbbb' })
    expect(kinds(manager.observe(cues.subtitle('From the server', { sync: 'exact' })))).toEqual(['update:subtitle'])
  })

  it('ends the session as stopped when the page leaves, even while server cues remain', () => {
    const page = new Feed(ref('browser:tab1', { kind: 'jellyfin-web', links: ['jf-device:web1'] }), { id: 'jellyfin:bbbb', site: 'jellyfin' })
    const session = new Feed(ref('jellyfin:s2', { kind: 'jellyfin-web', reach: 'server', eligible: false, links: ['jf-device:web1'] }), { id: 'jellyfin:bbbb', site: 'jellyfin', title: evidence('Sousou no Frieren', 'metadata', 0.95) })
    session.jellyfin = { item: 'bbbb', device: 'web1' }
    const cues = new Feed(ref('jellyfin-cues:jellyfin:s2', { kind: 'jellyfin-client', reach: 'server', eligible: false, links: ['jf-device:web1'] }), { id: 'jellyfin:bbbb' })
    manager.observe(page.video())
    const start = manager.observe(session.video())[0]
    manager.observe(cues.subtitle('Line'))
    expect(manager.gone('browser:tab1', 'stopped')).toEqual([{ kind: 'end', key: (start as Extract<ManagerOutput, { kind: 'start' }>).key, reason: 'stopped' }])
  })

  it('keeps the cue clock when a page update carries no position', () => {
    const { mpv, server } = jmp()
    manager.observe(mpv.video({ position: 50 }))
    manager.observe(server.video())
    clock += 2000
    // A title poll of a page reports state without a position.
    manager.observe(mpv.video({ position: undefined }))
    clock += 1000
    expect(manager.cueRequest()!.position()).toBeCloseTo(53, 5)
  })

  it('asks for server cues only while the player reports no subtitle text', () => {
    const { mpv, server } = jmp()
    manager.observe(mpv.video())
    manager.observe(server.video())
    expect(manager.cueRequest()).toMatchObject({ player: 'jellyfin:s1', item: 'aaaa', media_source: 'ms1', index: 3, sync: 'exact' })
    clock += 100
    manager.observe(mpv.subtitle('From the player'))
    expect(manager.cueRequest()).toBeUndefined()
  })
})

describe('arbitration', () => {
  it('keeps the playing selection and lets another player take over only when it stops playing', () => {
    const a = new Feed(ref('mpv:a'), { id: 'local:a' })
    const b = new Feed(ref('vlc:b', { kind: 'vlc' }), { id: 'local:b' })
    const startA = manager.observe(a.video())[0] as Extract<ManagerOutput, { kind: 'start' }>
    clock += 1000
    expect(manager.observe(b.video())).toEqual([])
    clock += 1000
    const out = manager.observe(a.video({ playing: false }))
    expect(kinds(out)).toEqual(['end', 'start', 'update:video'])
    expect(out[0]).toEqual({ kind: 'end', key: startA.key, reason: 'replaced' })
    expect((updates(out)[0] as VideoUpdate).media.id).toBe('local:b')
  })

  it('follows a manual selection and returns to automatic selection on request', () => {
    const a = new Feed(ref('mpv:a'), { id: 'local:a' })
    const b = new Feed(ref('vlc:b', { kind: 'vlc' }), { id: 'local:b' })
    manager.observe(a.video())
    manager.observe(b.video())
    const out = chosen(manager.select('vlc:b'))
    expect(kinds(out)).toEqual(['end', 'start', 'update:video'])
    expect(out[0]).toMatchObject({ kind: 'end', reason: 'selected' })
    expect(manager.select('unknown:x')).toBe('unknown-player')
    expect(manager.select(undefined)).toEqual([])
  })

  it('merges two players that report the same title, episode, and position as one playback', () => {
    const a = new Feed(ref('mpv:a'), { id: 'local:a', title: evidence('Frieren', 'player', 0.6), episode: evidence(3, 'player', 0.6) })
    const b = new Feed(ref('vlc:b', { kind: 'vlc' }), { id: 'local:b', title: evidence('frieren', 'player', 0.6), episode: evidence(3, 'player', 0.6) })
    manager.observe(a.video({ position: 100 }))
    manager.observe(b.video({ position: 102 }))
    expect(manager.players().every(player => player.group === manager.active)).toBe(true)
  })

  it('drops a silent player after the stale time', () => {
    const a = new Feed(ref('mpv:a'), { id: 'local:a' })
    manager.observe(a.video())
    clock += 120_001
    expect(kinds(manager.tick())).toEqual(['end'])
    expect(manager.players()).toEqual([])
  })
})
