import type { MediaIdentity, VideoUpdate } from '../../watch/contracts'
import type { AdapterStatus, MediaSourceAdapter, PlayerRef, SourceEvents } from '../../watch/sources'

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { mediaTitleOf } from '../../watch/media-title'
import { readBounded } from './network'

/** status.json of one VLC is a few kilobytes. A larger body is refused. */
const MAX_BODY_BYTES = 256 * 1024
const REQUEST_TIMEOUT_MS = 2000
/** VLC reports whole seconds, so a jump counts as a seek only beyond this. */
const SEEK_THRESHOLD_S = 3
/** What VLC's HTTP interface cannot say. Ops shows them, and caption coverage falls back to R6 rules. */
const LIMITATIONS = ['no-subtitle-text', 'no-end-signal', 'whole-second-position'] as const

export interface VlcAdapterOptions {
  /** Port of VLC's HTTP interface. The adapter only ever asks `127.0.0.1` on this port. */
  port: number
  /** The HTTP interface password from the protected secret store. Without it the adapter does not ask. */
  password: string | undefined
  now: () => number
  /** Receives one line per unexpected failure, with a code only. */
  report?: (message: string) => void
  /**
   * Poll interval while a file is open, playing or paused. A paused player counts as a dialogue gap, so a resume must
   * show up fast. @default 1000
   */
  pollMs?: number
  /** Poll interval while VLC runs without an open file. @default 3000 */
  idlePollMs?: number
  /** Unchanged playback is reported at least this often, so the watch state stays fresh. @default 5000 */
  heartbeatMs?: number
  /** First wait after VLC did not answer. It doubles up to `maxRetryMs`. @default 2000 */
  retryMs?: number
  /** @default 10000 */
  maxRetryMs?: number
  /** Wait after VLC refused the password. The stored password does not change while the Core runs. @default 60000 */
  unauthorizedRetryMs?: number
}

interface Playback {
  id: string
  playing: boolean
  position: number
  rate: number
  at: number
  emittedAt: number
}

function text(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.replace(/\p{Cc}/gu, ' ').trim().slice(0, limit) : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Follows VLC through its Lua HTTP interface (`/requests/status.json`). It only reads status and never sends a command
 * parameter, so it cannot control the player. VLC reports no subtitle text and no end-of-file signal over HTTP, so
 * captions stay unknown and an episode end is never confirmed from VLC.
 *
 * State: `playback` is the runtime copy of the newest status. `session` grows after a stop or a lost connection, and
 * `timeline` grows on a file change and on a position jump.
 *
 * Lifecycle: `start` begins one poll loop with one request in flight. A refused connection means VLC does not run, so
 * polling slows down. A refused password stops fast polling. `stop` ends the loop.
 */
export class VlcAdapter implements MediaSourceAdapter {
  readonly kind = 'vlc'
  private readonly key: string
  private readonly url: string
  private events?: SourceEvents
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private connection: AdapterStatus['connection'] = 'waiting'
  private error?: string
  private retryMs: number
  private lastSyncAt?: number
  private version?: string
  private subtitleStreams = 0
  private playback?: Playback
  private session = 1
  private sequence = 0
  private timeline = 0

  constructor(private readonly options: VlcAdapterOptions) {
    if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535)
      throw new Error('VLC port must be between 1 and 65535.')
    this.key = `vlc:${options.port}`
    this.url = `http://127.0.0.1:${options.port}/requests/status.json`
    this.retryMs = options.retryMs ?? 2000
    if (!options.password) {
      this.connection = 'unauthorized'
      this.error = 'no-password'
    }
  }

  start(events: SourceEvents): void {
    this.events = events
    if (this.options.password)
      this.schedule(0)
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
  }

  status(): AdapterStatus {
    return {
      adapter: 'vlc',
      enabled: true,
      connection: this.connection,
      lastSyncAt: this.lastSyncAt,
      players: this.playback ? 1 : 0,
      limitations: [...LIMITATIONS],
      ...(this.error ? { error: this.error } : {}),
      details: { endpoint: `127.0.0.1:${this.options.port}`, version: this.version, subtitleStreams: this.subtitleStreams },
    }
  }

  private schedule(delay: number): void {
    if (this.stopped)
      return
    this.timer = setTimeout(() => void this.poll(), delay)
    this.timer.unref?.()
  }

  private async poll(): Promise<void> {
    let status: Record<string, unknown>
    try {
      const response = await fetch(this.url, {
        headers: { Authorization: `Basic ${Buffer.from(`:${this.options.password}`).toString('base64')}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel()
        this.connection = 'unauthorized'
        this.error = `http-${response.status}`
        this.lost('player-exited')
        this.schedule(this.options.unauthorizedRetryMs ?? 60_000)
        return
      }
      if (response.status !== 200) {
        await response.body?.cancel()
        throw new Error(`http-${response.status}`)
      }
      const parsed: unknown = JSON.parse(await readBounded(response, MAX_BODY_BYTES))
      if (!parsed || typeof parsed !== 'object')
        throw new Error('invalid-status')
      status = parsed as Record<string, unknown>
    }
    catch (error) {
      if (this.stopped)
        return
      const code = (error as { cause?: { code?: string } }).cause?.code ?? (error instanceof SyntaxError ? 'invalid-json' : (error as Error).message)
      // A refused connection only means that VLC is closed or its HTTP interface is off.
      this.connection = code === 'ECONNREFUSED' ? 'waiting' : 'error'
      this.error = code === 'ECONNREFUSED' ? undefined : String(code).slice(0, 40)
      if (this.connection === 'error' && code !== 'invalid-json')
        this.options.report?.(`vlc ${this.options.port}: ${this.error}`)
      this.lost('player-exited')
      this.schedule(this.retryMs)
      this.retryMs = Math.min(this.retryMs * 2, this.options.maxRetryMs ?? 10_000)
      return
    }
    if (this.stopped)
      return
    this.connection = 'connected'
    this.error = undefined
    this.retryMs = this.options.retryMs ?? 2000
    this.lastSyncAt = this.options.now()
    this.read(status)
    this.schedule(this.playback ? this.options.pollMs ?? 1000 : this.options.idlePollMs ?? 3000)
  }

  /** Applies one status. Stopped VLC ends the player. A new file or a position jump starts a new timeline. */
  private read(status: Record<string, unknown>): void {
    this.version = text(status.version, 40)
    const state = status.state
    const category = (status.information as { category?: Record<string, Record<string, unknown>> } | undefined)?.category
    const meta = category?.meta
    const filename = text(meta?.filename, 512)
    if ((state !== 'playing' && state !== 'paused') || !filename) {
      this.lost('stopped')
      return
    }
    this.subtitleStreams = Object.values(category ?? {}).filter(stream => stream?.Type === 'Subtitle').length
    const now = this.options.now()
    const length = finite(status.length)
    const media = this.identity(meta!, filename, length, now)
    const playing = state === 'playing'
    const position = Math.max(0, finite(status.time) ?? 0)
    const rate = finite(status.rate) && status.rate as number > 0 ? status.rate as number : 1
    const previous = this.playback
    let changed = !previous || previous.playing !== playing || previous.rate !== rate
    if (previous && previous.id !== media.id) {
      this.timeline++
      changed = true
    }
    else if (previous) {
      const expected = previous.position + (previous.playing ? (now - previous.at) / 1000 * previous.rate : 0)
      if (Math.abs(position - expected) > SEEK_THRESHOLD_S) {
        this.timeline++
        changed = true
      }
    }
    const due = !previous || now - previous.emittedAt >= (this.options.heartbeatMs ?? 5000)
    this.playback = { id: media.id, playing, position, rate, at: now, emittedAt: changed || due ? now : previous!.emittedAt }
    if (!changed && !due)
      return
    const update: VideoUpdate = {
      kind: 'video',
      stamp: { session: this.session, sequence: ++this.sequence, observed_at: now, timeline: this.timeline },
      media,
      playing,
      position,
      ...(length !== undefined && length > 0 ? { duration: length } : {}),
      rate,
      source: 'player',
      captions: { form: 'unknown' },
    }
    const player: PlayerRef = { key: this.key, kind: 'vlc', reach: 'direct', eligible: true, links: [] }
    this.events?.observe({ player, update })
  }

  /**
   * Identity from tags first, then the file name. The id hashes the file name and length, so no name or path is
   * stored with it.
   */
  private identity(meta: Record<string, unknown>, filename: string, length: number | undefined, now: number): MediaIdentity {
    const id = `local:${createHash('sha256').update(`${filename}|${length ?? ''}`).digest('hex').slice(0, 16)}`
    const evidence = <T>(value: T, confidence: number) => ({ value, source: 'player' as const, confidence, observed_at: now, valid_until: now + 35_000 })
    const show = text(meta.showName, 160)
    if (show) {
      const episode = positiveInteger(meta.episodeNumber)
      const season = positiveInteger(meta.seasonNumber)
      return { id, site: 'local', player: 'vlc', title: evidence(show, 0.7), ...(episode ? { episode: evidence(episode, 0.7) } : {}), ...(season ? { season: evidence(season, 0.7) } : {}) }
    }
    const tagTitle = text(meta.title, 320)
    const parsed = tagTitle && tagTitle !== filename ? mediaTitleOf(tagTitle, 'tags') : mediaTitleOf(filename, 'filename')
    const confidence = tagTitle && tagTitle !== filename ? 0.7 : 0.6
    return {
      id,
      site: 'local',
      player: 'vlc',
      ...(parsed.title ? { title: evidence(parsed.title, confidence) } : {}),
      ...(parsed.episode ? { episode: evidence(parsed.episode, 0.6) } : {}),
      ...(parsed.season ? { season: evidence(parsed.season, 0.6) } : {}),
    }
  }

  /** The followed file ended or VLC went away. Late data of it stays refused because the session grows. */
  private lost(reason: 'stopped' | 'player-exited'): void {
    if (!this.playback)
      return
    this.playback = undefined
    this.session++
    this.events?.gone(this.key, reason)
  }
}
