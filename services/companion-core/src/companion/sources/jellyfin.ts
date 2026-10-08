import type { CaptionTrack, MediaIdentity, PlayerKind, VideoUpdate } from '../../watch/contracts'
import type { AdapterStatus, CueRequest, MediaSourceAdapter, PlayerRef, SourceEvents } from '../../watch/sources'
import type { JellyfinFailure } from './jellyfin-client'
import type { HostLookup } from './network'

import * as v from 'valibot'

import { languageCodeOf } from '../../watch/subtitle-text'
import { guidOf, JellyfinClient } from './jellyfin-client'
import { JellyfinCueWindow } from './jellyfin-cues'

/** A position jump beyond this between two server reports counts as a seek. Server positions lag a little. */
const SEEK_THRESHOLD_S = 4
/** A playing session without a client report for this long is not current anymore. Clients report every 10 s. */
const STALE_CHECK_IN_MS = 45_000
/** Item types that a watch session can follow. */
const VIDEO_TYPES: ReadonlySet<string> = new Set(['Episode', 'Movie', 'Video', 'MusicVideo', 'TvChannel', 'Trailer'])

const text = v.optional(v.nullable(v.string()))
const number = v.optional(v.nullable(v.number()))
/** Only the fields the Core uses. Valibot drops the rest at parse, so plot text such as `Overview` never enters. */
const streamSchema = v.object({ Index: v.number(), Type: text, Codec: text, Language: text, IsTextSubtitleStream: v.optional(v.nullable(v.boolean())) })
const itemSchema = v.object({ Id: v.string(), Type: text, Name: text, SeriesName: text, ParentIndexNumber: number, IndexNumber: number, RunTimeTicks: number, MediaStreams: v.optional(v.nullable(v.array(streamSchema))) })
const sessionSchema = v.object({
  Id: v.pipe(v.string(), v.regex(/^[\w-]{1,80}$/)),
  UserId: text,
  Client: text,
  DeviceName: text,
  DeviceId: text,
  LastPlaybackCheckIn: text,
  NowPlayingItem: v.optional(v.nullable(itemSchema)),
  PlayState: v.optional(v.nullable(v.object({ PositionTicks: number, IsPaused: v.optional(v.nullable(v.boolean())), SubtitleStreamIndex: number, MediaSourceId: text }))),
})
const userSchema = v.object({ Id: v.string(), Name: text, Policy: v.optional(v.nullable(v.object({ IsAdministrator: v.optional(v.nullable(v.boolean())) }))) })
const publicInfoSchema = v.object({ Version: text, ServerName: text })

type Session = v.InferOutput<typeof sessionSchema>

export interface JellyfinAdapterOptions {
  /** Validated server base from {@link serverBase}. */
  base: URL
  /** Access token from the protected secret store. Without it the adapter does not ask the server. */
  token: string | undefined
  now: () => number
  /** This computer's name. Jellyfin Media Player sessions with this device name play here. */
  hostname: string
  lookup: HostLookup
  /** Follows Jellyfin Media Player sessions of this computer by itself. */
  followThisComputer: boolean
  /** Device ids or device names that the user chose to follow, for example a TV. */
  devices: readonly string[]
  /** Looks up the current cue of a text subtitle stream when no player reports subtitle text. */
  serverSubtitles: boolean
  report?: (message: string) => void
  /** Poll interval while a session of the user plays or pauses. @default 1500 */
  pollMs?: number
  /** Poll interval while no session of the user plays. A new session shows up within it. @default 3000 */
  idlePollMs?: number
  /** Unchanged playback is reported at least this often. @default 5000 */
  heartbeatMs?: number
  /** @default 2000 */
  retryMs?: number
  /** @default 30000 */
  maxRetryMs?: number
  /** @default 60000 */
  unauthorizedRetryMs?: number
}

interface Followed {
  connection: number
  timeline: number
  item: string
  mediaSource?: string
  subtitle?: number
  position: number
  playing: boolean
  at: number
  emittedAt: number
  device?: string
  name?: string
  client?: string
  eligible: boolean
}

function playerKindOf(client: string | null | undefined): PlayerKind {
  if (client === 'Jellyfin Media Player' || client === 'Jellyfin Desktop')
    return 'jellyfin-media-player'
  if (client === 'Jellyfin Web')
    return 'jellyfin-web'
  return 'jellyfin-client'
}

function bounded(value: string | null | undefined, limit: number): string | undefined {
  const cleaned = value?.replace(/\p{Cc}/gu, ' ').trim()
  return cleaned ? cleaned.slice(0, limit) : undefined
}

/**
 * A client device id as the server reports it. jellyfin-web ids are about 200 characters of base64 text, and the
 * extension sends the same full value, so the id is never shortened. Other characters give no id and no link.
 */
function deviceIdOf(value: string | null | undefined): string | undefined {
  return value && /^[\w=+/.-]{1,256}$/.test(value) ? value : undefined
}

/** Jellyfin writes seven fractional digits. Three are enough and parse everywhere. */
function timeOf(value: string | null | undefined): number | undefined {
  const at = value ? Date.parse(value.replace(/(\.\d{3})\d+/, '$1')) : Number.NaN
  return Number.isFinite(at) ? at : undefined
}

/**
 * Follows the selected Jellyfin user's playback sessions through the authenticated Sessions API. It gives exact
 * library identity (series, season, episode, item id) and the server's view of playback. The server repeats client
 * reports, so playback and position are estimates. A direct player of the same playback outranks them.
 *
 * Privacy: only sessions of the token's user are kept. An administrator token also receives other users' sessions,
 * which are dropped at parse and never counted, logged, or shown. Sessions on other devices are reported as not
 * eligible, so the source manager follows them only after the user selects them.
 *
 * Lifecycle: `start` checks the user (`/Users/Me`) and then polls `/Sessions` with one request in flight, faster while
 * a session plays. A refused token stops fast polling. `stop` ends polling and the cue window.
 *
 * Call stack:
 *
 * CompanionWatch (../watch)
 *   -> {@link JellyfinAdapter.start} -> poll -> /Users/Me, /Sessions
 *     -> SourceEvents.observe (server playback per session)
 *   -> {@link JellyfinAdapter.followCues} -> JellyfinCueWindow (./jellyfin-cues)
 */
export class JellyfinAdapter implements MediaSourceAdapter {
  readonly kind = 'jellyfin'
  private readonly client: JellyfinClient
  private readonly cues: JellyfinCueWindow
  private readonly followed = new Map<string, Followed>()
  private events?: SourceEvents
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private polling = false
  private user?: { id: string, name?: string, admin: boolean }
  private server?: { version?: string, name?: string }
  private connection: AdapterStatus['connection'] = 'waiting'
  private error?: JellyfinFailure | 'no-token'
  private lastSyncAt?: number
  private lastPollAt = -Infinity
  private retryMs: number
  private nextConnection = 1
  private sequence = 0

  constructor(private readonly options: JellyfinAdapterOptions) {
    this.client = new JellyfinClient({ base: options.base, token: options.token, hostname: options.hostname, lookup: options.lookup })
    this.cues = new JellyfinCueWindow({ client: this.client, now: options.now, publish: observation => this.events?.observe(observation) })
    this.retryMs = options.retryMs ?? 2000
    if (!options.token) {
      this.connection = 'unauthorized'
      this.error = 'no-token'
    }
  }

  start(events: SourceEvents): void {
    this.events = events
    if (this.client.hasToken)
      this.schedule(0)
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    this.cues.follow(undefined)
  }

  /** Another source saw media that the server can identify, so the next poll runs now. */
  wake(): void {
    if (!this.stopped && this.client.hasToken && !this.polling && this.options.now() - this.lastPollAt > 500) {
      clearTimeout(this.timer)
      this.schedule(0)
    }
  }

  /** Follows the cue request of the active watch session, or stops cue lookups with `undefined`. */
  followCues(request: CueRequest | undefined): void {
    this.cues.follow(this.options.serverSubtitles ? request : undefined)
  }

  status(): AdapterStatus {
    const limitations = ['server-position-estimated', 'polling']
    if (this.user?.admin)
      limitations.push('administrator-token')
    if (!this.options.serverSubtitles)
      limitations.push('server-subtitles-off')
    const sessions = [...this.followed.values()]
    return {
      adapter: 'jellyfin',
      enabled: true,
      connection: this.connection,
      lastSyncAt: this.lastSyncAt,
      players: sessions.length,
      limitations,
      ...(this.error ? { error: this.error } : {}),
      details: {
        server: this.options.base.host,
        serverVersion: this.server?.version,
        user: this.user?.name,
        followedDevices: sessions.filter(session => session.eligible).map(session => `${session.name ?? '?'} (${session.client ?? '?'})`).join(', ') || undefined,
        otherDevices: sessions.filter(session => !session.eligible).map(session => `${session.name ?? '?'} (${session.client ?? '?'})`).join(', ') || undefined,
        cueLookups: this.cues.lookups,
      },
    }
  }

  private schedule(delay: number): void {
    if (this.stopped)
      return
    this.timer = setTimeout(() => void this.poll(), delay)
    this.timer.unref?.()
  }

  private async poll(): Promise<void> {
    if (this.polling)
      return
    this.polling = true
    this.lastPollAt = this.options.now()
    try {
      await this.pollOnce()
    }
    finally {
      this.polling = false
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.user) {
      const info = await this.client.get<unknown>('System/Info/Public')
      const parsedInfo = info.ok ? v.safeParse(publicInfoSchema, info.data) : undefined
      if (parsedInfo?.success)
        this.server = { version: bounded(parsedInfo.output.Version, 32), name: bounded(parsedInfo.output.ServerName, 64) }
      const me = await this.client.get<unknown>('Users/Me')
      if (!me.ok)
        return this.failed(me.failure)
      const parsed = v.safeParse(userSchema, me.data)
      const id = parsed.success ? guidOf(parsed.output.Id) : undefined
      if (!parsed.success || !id)
        return this.failed('invalid-json')
      this.user = { id, name: bounded(parsed.output.Name, 64), admin: parsed.output.Policy?.IsAdministrator === true }
    }
    // The server filters sessions for non-administrators. activeWithinSeconds drops long idle devices.
    const reply = await this.client.get<unknown>('Sessions', { activeWithinSeconds: 900 })
    if (!reply.ok)
      return this.failed(reply.failure)
    if (this.stopped)
      return
    this.connection = 'connected'
    this.error = undefined
    this.retryMs = this.options.retryMs ?? 2000
    const receivedAt = this.options.now()
    this.lastSyncAt = receivedAt
    this.read(Array.isArray(reply.data) ? reply.data : [], receivedAt, reply.serverDate)
    const active = [...this.followed.values()].length > 0
    this.schedule(active ? this.options.pollMs ?? 1500 : this.options.idlePollMs ?? 3000)
  }

  private failed(failure: JellyfinFailure): void {
    if (this.stopped)
      return
    this.error = failure
    if (failure === 'unauthorized') {
      this.connection = 'unauthorized'
      this.user = undefined
      this.endAll('disconnected')
      this.schedule(this.options.unauthorizedRetryMs ?? 60_000)
      return
    }
    this.connection = failure === 'unreachable' || failure === 'timeout' || failure === 'unresolved' ? 'waiting' : 'error'
    if (this.connection === 'error')
      this.options.report?.(`jellyfin: ${failure}`)
    this.endAll('disconnected')
    this.schedule(this.retryMs)
    this.retryMs = Math.min(this.retryMs * 2, this.options.maxRetryMs ?? 30_000)
  }

  /** Applies one session list. Sessions of other users never pass the user filter. */
  private read(list: unknown[], receivedAt: number, serverDate: number | undefined): void {
    const seen = new Set<string>()
    for (const raw of list) {
      const parsed = v.safeParse(sessionSchema, raw)
      if (!parsed.success || guidOf(parsed.output.UserId) !== this.user?.id || parsed.output.DeviceId === this.client.deviceId)
        continue
      const session = parsed.output
      const item = session.NowPlayingItem
      const itemId = guidOf(item?.Id)
      if (!item || !itemId || !session.PlayState || !VIDEO_TYPES.has(item.Type ?? ''))
        continue
      const checkIn = timeOf(session.LastPlaybackCheckIn)
      // Clock offset from the Date header. When both clocks agree, the local clock gives millisecond precision.
      const skew = serverDate !== undefined ? serverDate - receivedAt : 0
      const age = checkIn !== undefined ? Math.max(0, Math.abs(skew) < 2000 ? receivedAt - checkIn : (serverDate ?? receivedAt) - checkIn) : 0
      const playing = session.PlayState.IsPaused !== true
      if (playing && age > STALE_CHECK_IN_MS)
        continue
      seen.add(session.Id)
      this.observe(session, itemId, playing, Math.min(age, STALE_CHECK_IN_MS), receivedAt)
    }
    for (const [id] of this.followed) {
      if (!seen.has(id))
        this.end(id, 'stopped')
    }
  }

  private observe(session: Session, itemId: string, playing: boolean, age: number, now: number): void {
    const item = session.NowPlayingItem!
    const state = session.PlayState!
    const ticks = state.PositionTicks ?? 0
    const position = Math.max(0, ticks / 10_000_000 + (playing ? age / 1000 : 0))
    const mediaSource = guidOf(state.MediaSourceId)
    const subtitle = typeof state.SubtitleStreamIndex === 'number' && state.SubtitleStreamIndex >= 0 ? state.SubtitleStreamIndex : undefined
    const deviceId = deviceIdOf(session.DeviceId)
    const deviceName = bounded(session.DeviceName, 64)
    const client = bounded(session.Client, 64)
    const kind = playerKindOf(session.Client)
    const thisComputer = this.options.followThisComputer && kind === 'jellyfin-media-player' && deviceName?.toLowerCase() === this.options.hostname.toLowerCase()
    const chosen = this.options.devices.some(device => device === deviceId || device.toLowerCase() === deviceName?.toLowerCase())
    const eligible = thisComputer || chosen

    let followed = this.followed.get(session.Id)
    let changed = false
    if (!followed) {
      followed = { connection: this.nextConnection++, timeline: 0, item: itemId, mediaSource, subtitle, position, playing, at: now, emittedAt: -Infinity, device: deviceId, name: deviceName, client, eligible }
      this.followed.set(session.Id, followed)
      changed = true
    }
    else {
      const expected = followed.position + (followed.playing ? (now - followed.at) / 1000 : 0)
      // Another item, media source, or subtitle stream is other media or other text. A large jump is a seek.
      if (followed.item !== itemId || followed.mediaSource !== mediaSource || followed.subtitle !== subtitle || Math.abs(position - expected) > SEEK_THRESHOLD_S) {
        followed.timeline++
        changed = true
      }
      if (followed.playing !== playing || followed.eligible !== eligible)
        changed = true
      Object.assign(followed, { item: itemId, mediaSource, subtitle, position, playing, at: now, eligible })
    }
    if (!changed && now - followed.emittedAt < (this.options.heartbeatMs ?? 5000))
      return
    followed.emittedAt = now
    const update: VideoUpdate = {
      kind: 'video',
      stamp: { session: followed.connection, sequence: ++this.sequence, observed_at: now, timeline: followed.timeline },
      media: this.identity(item, itemId, kind, now),
      playing,
      position,
      ...(item.RunTimeTicks && item.RunTimeTicks > 0 ? { duration: item.RunTimeTicks / 10_000_000 } : {}),
      rate: 1,
      source: 'server',
      captions: this.captions(item.MediaStreams ?? [], subtitle),
      jellyfin: { ...(deviceId ? { device: deviceId } : {}), item: itemId, ...(mediaSource ? { media_source: mediaSource } : {}), ...(subtitle !== undefined ? { subtitle_stream: subtitle } : {}) },
    }
    // Item links only for eligible sessions: another device that plays the same episode must not join a local playback.
    const links = [...(deviceId ? [`jf-device:${deviceId}`] : []), ...(eligible ? [`jf-item:${itemId}`] : [])]
    const player: PlayerRef = { key: `jellyfin:${session.Id}`, kind, reach: 'server', eligible, links }
    this.events?.observe({ player, update })
  }

  /** Library identity: the series for an episode, the item for anything else. Plot fields were dropped at parse. */
  private identity(item: NonNullable<Session['NowPlayingItem']>, itemId: string, kind: PlayerKind, now: number): MediaIdentity {
    const evidence = <T>(value: T) => ({ value, source: 'metadata' as const, confidence: 0.95, observed_at: now, valid_until: now + 35_000 })
    const episode = item.Type === 'Episode'
    const title = bounded(episode ? item.SeriesName ?? item.Name : item.Name, 160)
    const number = episode && typeof item.IndexNumber === 'number' && Number.isSafeInteger(item.IndexNumber) && item.IndexNumber > 0 ? item.IndexNumber : undefined
    const season = episode && typeof item.ParentIndexNumber === 'number' && Number.isSafeInteger(item.ParentIndexNumber) && item.ParentIndexNumber >= 0 ? item.ParentIndexNumber : undefined
    return {
      id: `jellyfin:${itemId}`,
      site: 'jellyfin',
      player: kind,
      ...(title ? { title: evidence(title) } : {}),
      ...(number ? { episode: evidence(number) } : {}),
      ...(season !== undefined ? { season: evidence(season) } : {}),
    }
  }

  private captions(streams: ReadonlyArray<v.InferOutput<typeof streamSchema>>, index: number | undefined): CaptionTrack {
    const stream = index === undefined ? undefined : streams.find(entry => entry.Index === index && entry.Type === 'Subtitle')
    if (!stream)
      return { form: index === undefined ? 'none' : 'unknown' }
    const language = languageCodeOf(bounded(stream.Language, 16))
    const codec = bounded(stream.Codec, 32)?.toLowerCase()
    return { form: stream.IsTextSubtitleStream ? 'text' : 'image', ...(language ? { language } : {}), ...(codec && /^[\w.-]+$/.test(codec) ? { codec } : {}) }
  }

  private end(sessionId: string, reason: 'stopped' | 'disconnected'): void {
    if (!this.followed.delete(sessionId))
      return
    this.events?.gone(`jellyfin:${sessionId}`, reason)
  }

  private endAll(reason: 'disconnected'): void {
    for (const id of [...this.followed.keys()])
      this.end(id, reason)
  }
}
