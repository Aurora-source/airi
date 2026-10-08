import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { VideoUpdate } from '../../src/watch/contracts'
import type { PlayerEndReason, PlayerObservation } from '../../src/watch/sources'

import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { VlcAdapter } from '../../src/companion/sources/vlc'

const PASSWORD = 'test-password'

/** Plays VLC's Lua HTTP interface: `/requests/status.json` behind Basic authentication with an empty user name. */
class FakeVlc {
  status: Record<string, unknown> = { state: 'stopped' }
  readonly requests: Array<{ url?: string, method?: string }> = []
  body?: string
  private server?: Server

  async listen(): Promise<number> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      this.requests.push({ url: req.url, method: req.method })
      if (req.headers.authorization !== `Basic ${Buffer.from(`:${PASSWORD}`).toString('base64')}`) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="VLC stream"' }).end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(this.body ?? JSON.stringify(this.status))
    })
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve))
    return (this.server!.address() as AddressInfo).port
  }

  async close(): Promise<void> {
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve())
    this.server?.closeAllConnections()
  }
}

function playing(fields: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'playing',
    time: 61,
    length: 1420,
    position: 0.043,
    rate: 1,
    subtitledelay: 0,
    version: '3.0.23 Vetinari',
    apiversion: 3,
    information: { category: {
      'meta': { filename: '[SubsPlease] Sousou no Frieren - 13 (1080p) [A1B2C3D4].mkv', ...meta },
      'Stream 0': { Type: 'Video', Codec: 'H264 - MPEG-4 AVC (part 10) (avc1)' },
      'Stream 2': { Type: 'Subtitle', Codec: 'Advanced Sub Station Alpha subtitles (ssa)', Language: 'English' },
    } },
    ...fields,
  }
}

let vlc: FakeVlc | undefined
let adapter: VlcAdapter | undefined

afterEach(async () => {
  await adapter?.stop()
  await vlc?.close()
  adapter = undefined
  vlc = undefined
})

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function start(password: string | undefined = PASSWORD) {
  vlc = new FakeVlc()
  const port = await vlc.listen()
  const observations: PlayerObservation[] = []
  const gone: Array<{ key: string, reason: PlayerEndReason }> = []
  adapter = new VlcAdapter({ port, password, now: Date.now, pollMs: 20, idlePollMs: 20, heartbeatMs: 60_000, retryMs: 20, maxRetryMs: 40 })
  adapter.start({ observe: observation => observations.push(observation), gone: (key, reason) => gone.push({ key, reason }) })
  const videos = () => observations.map(observation => observation.update as VideoUpdate)
  return { vlc, port, observations, gone, videos }
}

describe('vlc adapter', () => {
  it('reports playback with identity from the file name and no subtitle text', async () => {
    const f = await start()
    f.vlc.status = playing()
    await until(() => f.videos().length === 1)
    const video = f.videos()[0]
    expect(video.media).toMatchObject({ site: 'local', player: 'vlc', title: { value: 'Sousou no Frieren', source: 'player' }, episode: { value: 13 } })
    expect(video.media.id).toMatch(/^local:[0-9a-f]{16}$/)
    expect(video).toMatchObject({ playing: true, position: 61, duration: 1420, rate: 1, source: 'player', captions: { form: 'unknown' } })
    expect(f.observations[0].player).toMatchObject({ key: `vlc:${f.port}`, kind: 'vlc', reach: 'direct', eligible: true, links: [] })
    expect(adapter!.status().limitations).toContain('no-subtitle-text')
  })

  it('prefers show and episode tags over the file name', async () => {
    const f = await start()
    f.vlc.status = playing({}, { showName: 'Frieren: Beyond Journey\'s End', episodeNumber: '14', seasonNumber: '1' })
    await until(() => f.videos().length === 1)
    expect(f.videos()[0].media).toMatchObject({ title: { value: 'Frieren: Beyond Journey\'s End', confidence: 0.7 }, episode: { value: 14 }, season: { value: 1 } })
  })

  it('reports pause at once and a position jump as a new timeline', async () => {
    const f = await start()
    f.vlc.status = playing()
    await until(() => f.videos().length === 1)
    f.vlc.status = playing({ state: 'paused' })
    await until(() => f.videos().length === 2)
    expect(f.videos()[1].playing).toBe(false)
    f.vlc.status = playing({ state: 'paused', time: 600 })
    await until(() => f.videos().length === 3)
    expect(f.videos()[2].stamp.timeline).toBe(f.videos()[1].stamp.timeline + 1)
  })

  it('reports a stop as gone and the next file under a larger session', async () => {
    const f = await start()
    f.vlc.status = playing()
    await until(() => f.videos().length === 1)
    f.vlc.status = { state: 'stopped' }
    await until(() => f.gone.length === 1)
    expect(f.gone[0].reason).toBe('stopped')
    f.vlc.status = playing({}, { filename: 'Other Show - 02.mkv' })
    await until(() => f.videos().length === 2)
    expect(f.videos()[1].stamp.session).toBeGreaterThan(f.videos()[0].stamp.session)
    expect(f.videos()[1].media.title?.value).toBe('Other Show')
    expect(f.videos().some(video => video.ended)).toBe(false)
  })

  it('stops asking quickly after a refused password and never puts it in the URL', async () => {
    const f = await start('wrong')
    await until(() => adapter!.status().connection === 'unauthorized')
    const count = f.vlc.requests.length
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(f.vlc.requests.length).toBe(count)
    expect(f.vlc.requests.every(request => request.url === '/requests/status.json' && request.method === 'GET')).toBe(true)
    expect(f.observations).toHaveLength(0)
  })

  it('waits while VLC is not running and follows it when it starts', async () => {
    const probe = new FakeVlc()
    const port = await probe.listen()
    await probe.close()
    const observations: PlayerObservation[] = []
    adapter = new VlcAdapter({ port, password: PASSWORD, now: Date.now, pollMs: 20, idlePollMs: 20, retryMs: 20, maxRetryMs: 40 })
    adapter.start({ observe: observation => observations.push(observation), gone: () => {} })
    await until(() => adapter!.status().connection === 'waiting' && adapter!.status().error === undefined)
    expect(observations).toHaveLength(0)
  })

  it('treats a broken response as an error without reporting playback', async () => {
    const f = await start()
    f.vlc.body = '{"state": "playing", "time": '
    await until(() => adapter!.status().connection === 'error')
    expect(f.observations).toHaveLength(0)
  })

  it('warns once when the HTTP interface listens beyond loopback', async () => {
    vlc = new FakeVlc()
    const port = await vlc.listen()
    vlc.status = playing()
    const reports: string[] = []
    const asked: number[] = []
    adapter = new VlcAdapter({ port, password: PASSWORD, now: Date.now, pollMs: 20, idlePollMs: 20, report: message => reports.push(message), listening: async (asked_port) => {
      asked.push(asked_port)
      return ['0.0.0.0', '::']
    } })
    adapter.start({ observe: () => {}, gone: () => {} })
    await until(() => adapter!.status().limitations.includes('http-open-to-network'))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(asked).toEqual([port])
    expect(reports).toEqual([`vlc ${port}: HTTP interface listens beyond 127.0.0.1. Start VLC with --http-host=127.0.0.1.`])
  })

  it('needs a stored password and a valid port', () => {
    expect(() => new VlcAdapter({ port: 0, password: PASSWORD, now: Date.now })).toThrow(/port/i)
    const missing = new VlcAdapter({ port: 8080, password: undefined, now: Date.now })
    expect(missing.status()).toMatchObject({ connection: 'unauthorized', error: 'no-password' })
  })
})
