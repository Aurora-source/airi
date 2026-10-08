import type { Socket } from 'node:net'

import type { CaptionTrack, MediaIdentity, SubtitleUpdate, VideoUpdate } from '../../watch/contracts'
import type { AdapterStatus, MediaSourceAdapter, PlayerRef, SourceEvents } from '../../watch/sources'

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { connect } from 'node:net'

import { mediaTitleOf } from '../../watch/media-title'
import { assLinesOf, dialogueOf, languageCodeOf, subtitleTextOf } from '../../watch/subtitle-text'

/** A pipe name stays inside the local `\\.\pipe\` namespace. Separators, server names, and paths are refused. */
const PIPE_NAME = /^[\w.-]{1,64}$/

/**
 * The only properties that the Core observes or reads. The adapter sends no other command, so nothing that it
 * receives, and nothing a model writes, can make mpv run a command, load a file, or change playback.
 */
const OBSERVED = ['pause', 'speed', 'duration', 'media-title', 'path', 'sid', 'secondary-sid', 'track-list', 'sub-text', 'secondary-sub-text', 'sub-delay', 'sub-speed'] as const
const READ_ONLY = [...OBSERVED, 'time-pos', 'sub-start', 'sub-end', 'sub-text/ass-full', 'sub-text-ass', 'mpv-version'] as const
type Observed = typeof OBSERVED[number]
type Property = typeof READ_ONLY[number]
const ALLOWED: ReadonlySet<string> = new Set(READ_ONLY)

/** Read when a connection opens, so the initial observation events change nothing. */
const INITIAL: readonly Property[] = ['mpv-version', 'path', 'media-title', 'pause', 'speed', 'duration', 'sid', 'secondary-sid', 'track-list', 'sub-text', 'secondary-sub-text', 'sub-delay', 'sub-speed']

/** A longer line is not an mpv reply that the adapter needs. It is dropped. */
const MAX_LINE_BYTES = 1024 * 1024
const MAX_PENDING = 64
const REQUEST_TIMEOUT_MS = 3000
/** Bitmap subtitle codecs. mpv reports an empty `sub-text` for them. */
const IMAGE_CODECS: ReadonlySet<string> = new Set(['hdmv_pgs_subtitle', 'pgssub', 'dvd_subtitle', 'dvdsub', 'dvb_subtitle', 'dvbsub', 'xsub', 'vobsub'])
/** File names that a streaming URL gives as the title. They name no show. */
const URL_TITLE = /^(?:stream|master|main|index|playlist|video)(?:\.[a-z0-9]{2,5})?$/i
/** A Jellyfin stream URL names its library item in the path. Only the id is kept. */
const JELLYFIN_ITEM = /\/videos\/([0-9a-f]{32})\//i

export interface MpvEndpoint {
  /** Pipe name without the `\\.\pipe\` prefix, the same value as `input-ipc-server=\\.\pipe\<name>`. */
  pipe: string
  /**
   * The program that owns the pipe. `jellyfin-media-player` plays Jellyfin streams, so the path names the library item
   * and the identity comes from the server.
   */
  player: 'mpv' | 'jellyfin-media-player'
}

export interface MpvAdapterOptions {
  endpoints: readonly MpvEndpoint[]
  now: () => number
  /** Receives one line per unexpected failure. Lines hold the pipe name and a code, never titles, paths, or captions. */
  report?: (message: string) => void
  /** Position refresh while a file plays or pauses. It keeps the watch state fresh. @default 5000 */
  heartbeatMs?: number
  /** First wait before the next connection attempt. It doubles up to `maxRetryMs`. @default 2000 */
  retryMs?: number
  /** @default 15000 */
  maxRetryMs?: number
}

type Reply = { ok: true, data: unknown } | { ok: false, error: string }

interface TrackEntry {
  id?: unknown
  type?: unknown
  codec?: unknown
  lang?: unknown
}

function label(value: unknown, limit = 32): string | undefined {
  return typeof value === 'string' && /^[\w.+-]{1,64}$/.test(value) ? value.slice(0, limit).toLowerCase() : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/** mpv's version string, for example `mpv v0.41.0-244-g...`. `sub-text/ass-full` exists since 0.38. */
function hasFullAss(version: unknown): boolean {
  const match = typeof version === 'string' ? /\bv?(\d+)\.(\d+)/.exec(version) : null
  return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) >= 38))
}

/**
 * Follows mpv players through their JSON IPC pipes. Each endpoint is one pipe that the user enabled with
 * `input-ipc-server`. The adapter never starts, configures, or controls a player.
 *
 * Call stack:
 *
 * CompanionWatch (../watch)
 *   -> {@link MpvAdapter.start}
 *     -> MpvConnection.connect -> property-change and file events
 *       -> SourceEvents.observe (video and subtitle observations)
 */
export class MpvAdapter implements MediaSourceAdapter {
  readonly kind = 'mpv'
  private readonly connections: MpvConnection[]

  constructor(options: MpvAdapterOptions) {
    for (const endpoint of options.endpoints) {
      if (!PIPE_NAME.test(endpoint.pipe))
        throw new Error(`Invalid mpv pipe name "${endpoint.pipe.slice(0, 80)}". Use letters, digits, dot, dash, or underscore.`)
    }
    this.connections = options.endpoints.map(endpoint => new MpvConnection(endpoint, options))
  }

  start(events: SourceEvents): void {
    for (const connection of this.connections)
      connection.start(events)
  }

  async stop(): Promise<void> {
    for (const connection of this.connections)
      connection.stop()
  }

  status(): AdapterStatus {
    const states = this.connections.map(connection => connection.state())
    const limitations = [...new Set(states.flatMap(state => state.limitations))]
    const error = states.find(state => state.error)?.error
    let connection: AdapterStatus['connection'] = 'waiting'
    if (states.some(state => state.connected))
      connection = 'connected'
    else if (error && error !== 'ENOENT')
      connection = 'error'
    const synced = states.map(state => state.lastSyncAt).filter((at): at is number => at !== undefined)
    return {
      adapter: 'mpv',
      enabled: true,
      connection,
      lastSyncAt: synced.length > 0 ? Math.max(...synced) : undefined,
      players: states.filter(state => state.loaded).length,
      limitations,
      ...(error && error !== 'ENOENT' ? { error } : {}),
      details: { pipes: this.connections.map(item => item.pipe).join(', '), versions: [...new Set(states.map(state => state.version).filter(Boolean))].join(', ') || undefined },
    }
  }
}

/**
 * One pipe of one player.
 *
 * State: `props` is the runtime-loaded copy of the observed properties. `loaded` is true from `file-loaded` (or a
 * path seen at connect) until `end-file`. `session` grows on every connection and after every finished file, so the
 * source manager refuses late data of an old file. `timeline` grows on a new file, a seek, and a subtitle track switch.
 *
 * Lifecycle: `start` connects. A missing pipe means no player runs yet, so the connection retries with a growing
 * delay. A closed pipe reports the player as gone and retries. `stop` ends retries and closes the pipe.
 */
class MpvConnection {
  readonly pipe: string
  private readonly key: string
  private events?: SourceEvents
  private socket?: Socket
  private stopped = false
  private connected = false
  private ready = false
  private loaded = false
  private seeking = false
  private retryMs: number
  private retryTimer?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private buffer = Buffer.alloc(0)
  private nextRequest = 1
  private readonly pending = new Map<number, { resolve: (reply: Reply) => void, timer: ReturnType<typeof setTimeout> }>()
  private props: Partial<Record<Property, unknown>> = {}
  private session = 0
  private sequence = 0
  private timeline = 0
  private subtitleRequest = 0
  /** The last shown dialogue cue. Its end decides whether an empty subtitle is a timed gap or unknown. */
  private lastCue?: { end_ms?: number }
  private assForm: 'ass-full' | 'ass' = 'ass'
  private lastSyncAt?: number
  private error?: string
  private readonly decoder = new TextDecoder('utf-8')

  constructor(private readonly endpoint: MpvEndpoint, private readonly options: MpvAdapterOptions) {
    this.pipe = endpoint.pipe
    this.key = `mpv:${endpoint.pipe}`
    this.retryMs = options.retryMs ?? 2000
  }

  start(events: SourceEvents): void {
    this.events = events
    this.connect()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.retryTimer)
    clearInterval(this.heartbeat)
    this.socket?.destroy()
    this.socket = undefined
    this.failPending()
  }

  state() {
    const captions = this.loaded ? this.captions() : undefined
    const limitations: string[] = []
    if (captions?.form === 'image')
      limitations.push('image-subtitles')
    if (captions?.form === 'none')
      limitations.push('subtitles-off')
    if (this.connected && this.assForm === 'ass')
      limitations.push('ass-styles-unavailable')
    return { connected: this.connected, loaded: this.loaded, lastSyncAt: this.lastSyncAt, error: this.error, limitations, version: label(String(this.props['mpv-version'] ?? '').replace(/^mpv\s+/, '').split(/\s/)[0], 40) }
  }

  private connect(): void {
    if (this.stopped)
      return
    const socket = connect(`\\\\.\\pipe\\${this.pipe}`)
    this.socket = socket
    socket.on('connect', () => void this.opened())
    // No encoding is set on the socket, so chunks are buffers. A split UTF-8 sequence stays intact until the newline.
    socket.on('data', chunk => this.receive(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
    socket.on('error', (error: NodeJS.ErrnoException) => {
      this.error = error.code ?? 'pipe-error'
    })
    socket.on('close', () => this.closed(socket))
  }

  private async opened(): Promise<void> {
    this.connected = true
    this.error = undefined
    this.retryMs = this.options.retryMs ?? 2000
    this.session++
    const values = await Promise.all(INITIAL.map(name => this.read(name)))
    if (!this.connected)
      return
    INITIAL.forEach((name, index) => {
      const reply = values[index]
      this.props[name] = reply.ok ? reply.data : undefined
    })
    this.assForm = hasFullAss(this.props['mpv-version']) ? 'ass-full' : 'ass'
    OBSERVED.forEach((name, index) => void this.request(['observe_property', index + 1, name]))
    this.ready = true
    // The player already plays a file. It counts as loaded from now on.
    if (typeof this.props.path === 'string' && this.props.path)
      await this.begin()
  }

  private closed(socket: Socket): void {
    if (this.socket !== socket)
      return
    const wasConnected = this.connected
    this.connected = false
    this.ready = false
    this.socket = undefined
    this.buffer = Buffer.alloc(0)
    this.failPending()
    if (this.loaded) {
      this.loaded = false
      clearInterval(this.heartbeat)
      this.events?.gone(this.key, 'player-exited')
    }
    if (this.stopped)
      return
    // A player that was connected comes back soon. A pipe that never opened waits longer each time.
    const delay = wasConnected ? (this.options.retryMs ?? 2000) : this.retryMs
    this.retryMs = Math.min(this.retryMs * 2, this.options.maxRetryMs ?? 15_000)
    this.retryTimer = setTimeout(() => this.connect(), delay)
    this.retryTimer.unref?.()
  }

  /** Splits mpv's newline-delimited JSON. Invalid UTF-8 becomes U+FFFD, and broken or oversized lines are dropped. */
  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    let newline = this.buffer.indexOf(0x0A)
    while (newline >= 0) {
      const line = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (line.length > 0 && line.length <= MAX_LINE_BYTES) {
        let message: unknown
        try {
          message = JSON.parse(this.decoder.decode(line))
        }
        catch {
          message = undefined
        }
        if (message && typeof message === 'object')
          this.handle(message as Record<string, unknown>)
      }
      newline = this.buffer.indexOf(0x0A)
    }
    if (this.buffer.length > MAX_LINE_BYTES)
      this.buffer = Buffer.alloc(0)
  }

  private handle(message: Record<string, unknown>): void {
    if (typeof message.request_id === 'number' && message.request_id > 0 && !('event' in message)) {
      const pending = this.pending.get(message.request_id)
      if (!pending)
        return
      this.pending.delete(message.request_id)
      clearTimeout(pending.timer)
      pending.resolve(message.error === 'success' ? { ok: true, data: message.data } : { ok: false, error: String(message.error).slice(0, 40) })
      return
    }
    switch (message.event) {
      case 'property-change':
        if (typeof message.name === 'string' && (OBSERVED as readonly string[]).includes(message.name))
          this.changed(message.name as Observed, message.data)
        return
      case 'file-loaded':
        void this.begin()
        return
      case 'end-file':
        this.finish(message.reason)
        return
      case 'seek':
        // Data from before the jump never passes as current. The video of the new timeline comes at playback-restart.
        if (this.loaded) {
          this.seeking = true
          this.timeline++
          this.lastCue = undefined
        }
        return
      case 'playback-restart':
        this.seeking = false
        if (this.loaded)
          void this.refresh()
    }
  }

  private changed(name: Observed, value: unknown): void {
    const before = this.props[name]
    if (same(before, value))
      return
    const captionsBefore = JSON.stringify(this.captions())
    this.props[name] = value
    if (!this.ready || !this.loaded)
      return
    switch (name) {
      case 'pause':
      case 'speed':
      case 'duration':
      case 'media-title':
        void this.refresh()
        return
      case 'sid':
      case 'secondary-sid':
        // Another track shows other text. Cues and gaps of the old track are revoked.
        this.timeline++
        this.lastCue = undefined
        void this.refresh()
        return
      case 'track-list':
        if (JSON.stringify(this.captions()) !== captionsBefore)
          void this.refresh()
        return
      case 'sub-text':
      case 'secondary-sub-text':
        void this.subtitle()
    }
  }

  private async begin(): Promise<void> {
    if (this.loaded)
      this.events?.gone(this.key, 'stopped')
    this.loaded = true
    this.seeking = false
    this.lastCue = undefined
    this.timeline++
    clearInterval(this.heartbeat)
    this.heartbeat = setInterval(() => {
      if (this.loaded && !this.seeking)
        void this.refresh()
    }, this.options.heartbeatMs ?? 5000)
    this.heartbeat.unref?.()
    await this.refresh()
    if (typeof this.props['sub-text'] === 'string' && this.props['sub-text'])
      await this.subtitle()
  }

  /** Only a natural end of file confirms that the episode finished. A stop, quit, or error does not. */
  private finish(reason: unknown): void {
    if (!this.loaded)
      return
    if (reason === 'eof')
      this.emitVideo({ ended: true })
    this.loaded = false
    this.lastCue = undefined
    clearInterval(this.heartbeat)
    this.events?.gone(this.key, 'stopped')
    // The next file is new media. Late data of this one stays refused.
    this.session++
  }

  private async refresh(): Promise<void> {
    const session = this.session
    const timeline = this.timeline
    const position = await this.read('time-pos')
    if (!this.loaded || session !== this.session || timeline !== this.timeline || this.seeking)
      return
    this.emitVideo({ position: position.ok ? finite(position.data) : undefined })
  }

  private emitVideo(fields: { position?: number, ended?: boolean }): void {
    const { media, item } = this.media()
    const speed = finite(this.props.speed)
    const update: VideoUpdate = {
      kind: 'video',
      stamp: this.stamp(),
      media,
      playing: fields.ended ? false : this.props.pause === false,
      ...(fields.position !== undefined && fields.position >= 0 ? { position: fields.position } : {}),
      ...(finite(this.props.duration) !== undefined ? { duration: finite(this.props.duration) } : {}),
      ...(speed !== undefined && speed > 0 ? { rate: speed } : {}),
      ...(fields.ended ? { ended: true } : {}),
      source: 'player',
      captions: this.captions(),
      ...(item ? { jellyfin: { item } } : {}),
    }
    this.publish(update, item)
  }

  /**
   * Reads the current subtitle when `sub-text` changed. A request that a newer change overtook is dropped, so an old
   * cue never replaces a new one.
   */
  private async subtitle(): Promise<void> {
    if (!this.loaded || this.seeking || this.captions().form !== 'text')
      return
    const request = ++this.subtitleRequest
    const session = this.session
    const timeline = this.timeline
    const secondarySelected = typeof this.props['secondary-sid'] === 'number'
    const [start, end, ass, secondary] = await Promise.all([
      this.read('sub-start'),
      this.read('sub-end'),
      this.read(this.assForm === 'ass-full' ? 'sub-text/ass-full' : 'sub-text-ass'),
      secondarySelected ? this.read('secondary-sub-text') : Promise.resolve<Reply>({ ok: false, error: 'not selected' }),
    ])
    if (request !== this.subtitleRequest || session !== this.session || timeline !== this.timeline || !this.loaded || this.seeking)
      return
    const plain = typeof this.props['sub-text'] === 'string' ? this.props['sub-text'] : ''
    const text = ass.ok && typeof ass.data === 'string'
      ? dialogueOf(assLinesOf(ass.data, this.assForm))
      : subtitleTextOf(plain)
    const captions = this.captions()
    const { media, item } = this.media()
    if (!text) {
      if (!this.lastCue)
        return
      // A cue with a known end that is gone now ended on time: a timed gap. Without a known end the state is unknown.
      const cleared = this.lastCue.end_ms === undefined
      this.lastCue = undefined
      this.publish({ kind: 'subtitle', stamp: this.stamp(), media_id: media.id, text: '', automatic: false, ...(cleared ? { cleared: true } : {}) }, item)
      return
    }
    // mpv reports cue times on the subtitle clock: subtitle time = (playback time - delay) / speed.
    const delay = finite(this.props['sub-delay']) ?? 0
    const subSpeed = finite(this.props['sub-speed']) ?? 1
    const toPlayback = (reply: Reply) => reply.ok && finite(reply.data) !== undefined ? Math.round((finite(reply.data)! * subSpeed + delay) * 1000) : undefined
    const start_ms = toPlayback(start)
    let end_ms = toPlayback(end)
    if (start_ms !== undefined && end_ms !== undefined && end_ms <= start_ms)
      end_ms = undefined
    const secondaryText = secondary.ok && typeof secondary.data === 'string' ? subtitleTextOf(secondary.data) : ''
    this.lastCue = { end_ms }
    const update: SubtitleUpdate = {
      kind: 'subtitle',
      stamp: this.stamp(),
      media_id: media.id,
      text,
      language: captions.language ?? languageCodeOf(undefined, text),
      ...(start_ms !== undefined && start_ms >= 0 ? { start_ms } : {}),
      ...(end_ms !== undefined && end_ms >= 0 ? { end_ms } : {}),
      automatic: false,
      ...(secondaryText ? { secondary: { text: secondaryText, language: captions.secondary?.language ?? languageCodeOf(undefined, secondaryText) } } : {}),
    }
    this.publish(update, item)
  }

  private publish(update: VideoUpdate | SubtitleUpdate, item: string | undefined): void {
    this.lastSyncAt = this.options.now()
    const player: PlayerRef = { key: this.key, kind: this.endpoint.player, reach: 'direct', eligible: true, links: item ? [`jf-item:${item}`] : [] }
    try {
      this.events?.observe({ player, update })
    }
    catch (error) {
      this.options.report?.(`mpv ${this.pipe}: observer failed (${(error as Error).name})`)
    }
  }

  /**
   * Identity from the path and title. A local file gets a hashed id, so its path never leaves the adapter. A Jellyfin
   * stream keeps only its item id. Titles are guesses from tags or the file name.
   */
  private media(): { media: MediaIdentity, item?: string } {
    const path = typeof this.props.path === 'string' ? this.props.path : ''
    const stream = /^https?:\/\//i.test(path)
    const item = stream ? JELLYFIN_ITEM.exec(path)?.[1]?.toLowerCase() : undefined
    const id = item ? `jellyfin:${item}` : `local:${createHash('sha256').update(path).digest('hex').slice(0, 16)}`
    const raw = typeof this.props['media-title'] === 'string' ? this.props['media-title'] : ''
    const base = (stream ? path.split(/[?#]/)[0] : path).split(/[\\/]/).pop() ?? ''
    const origin = raw === base ? 'filename' : 'tags'
    const parsed = raw && (!stream || (!URL_TITLE.test(raw) && raw !== base)) ? mediaTitleOf(raw, origin) : {}
    const now = this.options.now()
    const evidence = <T>(value: T, confidence: number) => ({ value, source: 'player' as const, confidence, observed_at: now, valid_until: now + 35_000 })
    return {
      item,
      media: {
        id,
        site: item ? 'jellyfin' : 'local',
        player: this.endpoint.player,
        ...(parsed.title ? { title: evidence(parsed.title, origin === 'tags' ? 0.7 : 0.6) } : {}),
        ...(parsed.episode ? { episode: evidence(parsed.episode, 0.6) } : {}),
        ...(parsed.season ? { season: evidence(parsed.season, 0.6) } : {}),
      },
    }
  }

  /** The selected tracks, matched by id, so the order of `sid` and `track-list` notifications does not matter. */
  private captions(): CaptionTrack {
    const tracks = Array.isArray(this.props['track-list']) ? this.props['track-list'] as TrackEntry[] : []
    const find = (id: unknown) => typeof id === 'number' ? tracks.find(track => track && track.type === 'sub' && track.id === id) : undefined
    const form = (track?: TrackEntry): CaptionTrack['form'] => {
      if (!track)
        return 'none'
      return IMAGE_CODECS.has(label(track.codec) ?? '') ? 'image' : 'text'
    }
    const primary = find(this.props.sid)
    const secondary = find(this.props['secondary-sid'])
    return {
      form: form(primary),
      ...(languageCodeOf(label(primary?.lang)) ? { language: languageCodeOf(label(primary?.lang)) } : {}),
      ...(label(primary?.codec) ? { codec: label(primary?.codec) } : {}),
      ...(secondary ? { secondary: { form: form(secondary), ...(languageCodeOf(label(secondary.lang)) ? { language: languageCodeOf(label(secondary.lang)) } : {}) } } : {}),
    }
  }

  private stamp() {
    return { session: this.session, sequence: ++this.sequence, observed_at: this.options.now(), timeline: this.timeline }
  }

  private read(name: Property): Promise<Reply> {
    return this.request(['get_property', name])
  }

  /** Sends one allowlisted, read-only command. Anything else throws, so no caller can widen the protocol. */
  private request(command: ['get_property', Property] | ['observe_property', number, Observed]): Promise<Reply> {
    const name = command[0] === 'get_property' ? command[1] : command[2]
    if ((command[0] !== 'get_property' && command[0] !== 'observe_property') || !ALLOWED.has(name))
      throw new Error('mpv command outside the read-only allowlist')
    const socket = this.socket
    if (!socket || !this.connected || this.pending.size >= MAX_PENDING)
      return Promise.resolve({ ok: false, error: 'not connected' })
    const id = this.nextRequest++
    return new Promise<Reply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: 'timeout' })
      }, REQUEST_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(id, { resolve, timer })
      socket.write(`${JSON.stringify({ command, request_id: id })}\n`)
    })
  }

  private failPending(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, error: 'closed' })
      this.pending.delete(id)
    }
  }
}
