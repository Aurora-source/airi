import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createServer } from 'node:http'

export const TOKEN = '0123456789abcdef0123456789abcdef'
export const USER_ID = '11111111111111111111111111111111'
export const OTHER_USER_ID = '22222222222222222222222222222222'
export const ITEM = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export const SOURCE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

export interface FakeCue {
  Text: string
  StartPositionTicks: number
  EndPositionTicks: number
}

/**
 * Plays the parts of a Jellyfin server that the Core reads: public info, the token's user, the session list, and the
 * subtitle stream with Jellyfin's time filter. It records method, URL, and the Authorization header of each request.
 *
 * @example
 * const jellyfin = new FakeJellyfin()
 * const base = await jellyfin.listen()
 * jellyfin.sessions = [session()]
 */
export class FakeJellyfin {
  sessions: unknown[] = []
  cues: FakeCue[] = []
  admin = false
  /** Replaces the answer of every request, for example a redirect or an outage response. */
  override?: (req: IncomingMessage, res: ServerResponse) => boolean
  readonly requests: Array<{ method?: string, url: string, authorization?: string }> = []
  private server?: Server

  async listen(): Promise<string> {
    this.server = createServer((req, res) => this.answer(req, res))
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/`
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve())
  }

  private answer(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    this.requests.push({ method: req.method, url: req.url ?? '', authorization: req.headers.authorization })
    if (this.override?.(req, res))
      return
    const json = (status: number, body?: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(body === undefined ? '' : JSON.stringify(body))
    }
    if (url.pathname === '/System/Info/Public')
      return json(200, { Version: '12.2.0', ServerName: 'test-server', Id: 'server1' })
    if (!req.headers.authorization?.includes(`Token="${TOKEN}"`))
      return json(401)
    if (url.pathname === '/Users/Me')
      return json(200, { Id: USER_ID, Name: 'viewer', Policy: { IsAdministrator: this.admin } })
    if (url.pathname === '/Sessions') {
      // A non-administrator sees only own sessions. An administrator sees every session.
      const visible = this.admin ? this.sessions : this.sessions.filter(session => (session as { UserId?: string }).UserId === USER_ID)
      return json(200, visible)
    }
    const stream = /^\/Videos\/[0-9a-f]{32}\/[0-9a-f]{32}\/Subtitles\/\d+\/Stream\.js$/.test(url.pathname)
    if (stream) {
      const start = Number(url.searchParams.get('startPositionTicks') ?? 0)
      const end = Number(url.searchParams.get('endPositionTicks') ?? 0)
      // Jellyfin's FilterEvents: drop cues that fully elapsed before start, and cues that begin after end.
      const events = this.cues.filter(cue => (!(cue.StartPositionTicks < start) || !(cue.EndPositionTicks < start)) && (!(end > 0) || !(cue.StartPositionTicks > end)))
      return json(200, { TrackEvents: events })
    }
    json(404)
  }
}

/** One session as Jellyfin's `/Sessions` returns it, with an episode playing. */
export function session(fields: Record<string, unknown> = {}, item: Record<string, unknown> = {}, state: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: 'session1',
    UserId: USER_ID,
    UserName: 'viewer',
    Client: 'Jellyfin Media Player',
    DeviceName: 'LIVING-PC',
    DeviceId: 'device-jmp',
    LastPlaybackCheckIn: new Date(Date.now() - 2000).toISOString().replace('Z', '0000Z'),
    LastActivityDate: new Date().toISOString(),
    NowPlayingItem: {
      Id: ITEM,
      Type: 'Episode',
      Name: 'The Hero\'s Funeral',
      SeriesName: 'Sousou no Frieren',
      ParentIndexNumber: 1,
      IndexNumber: 13,
      RunTimeTicks: 14_200_000_000,
      Overview: 'SECRET PLOT SUMMARY',
      MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'h264' },
        { Index: 2, Type: 'Subtitle', Codec: 'ass', Language: 'eng', IsTextSubtitleStream: true },
        { Index: 3, Type: 'Subtitle', Codec: 'PGSSUB', Language: 'jpn', IsTextSubtitleStream: false },
      ],
      ...item,
    },
    PlayState: { PositionTicks: 600_000_000, IsPaused: false, SubtitleStreamIndex: 2, MediaSourceId: SOURCE, ...state },
    ...fields,
  }
}
