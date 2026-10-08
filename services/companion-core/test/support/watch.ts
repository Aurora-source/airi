import type { Client, WebSocketBaseEvent, WebSocketEventOptionalSource, WebSocketEvents } from '@proj-airi/server-sdk'

import { WEB_EXTENSION_PLUGIN } from '../../src/companion/watch-bridge'

type ClientOptions = ConstructorParameters<typeof Client>[0]

/**
 * Plays AIRI's server channel for the Core's watch client. Tests emit channel events and read what the Core sent.
 *
 * @example
 * const channel = new FakeChannel()
 * new CompanionWatch({ config, createClient: channel.connect })
 * channel.ready(true)
 */
export class FakeChannel {
  readonly sent: WebSocketEventOptionalSource[] = []
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  private options?: ClientOptions
  closed = false

  /** Pass it as `createClient`. */
  readonly connect = (options: ClientOptions): Pick<Client, 'onEvent' | 'send' | 'close'> => {
    this.options = options
    return this
  }

  onEvent<E extends keyof WebSocketEvents>(event: E, callback: (data: WebSocketBaseEvent<E, WebSocketEvents[E]>) => void | Promise<void>): () => void {
    let listeners = this.listeners.get(event)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(event, listeners)
    }
    const listener = (value: unknown) => void callback(value as WebSocketBaseEvent<E, WebSocketEvents[E]>)
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  send(data: WebSocketEventOptionalSource): boolean {
    this.sent.push(data)
    return !this.closed
  }

  close(): void {
    this.closed = true
  }

  /** Reports the client's connection state, like server-sdk does. */
  ready(ready: boolean): void {
    this.options?.onStateChange?.({ previousStatus: ready ? 'connecting' : 'ready', status: ready ? 'ready' : 'reconnecting' })
  }

  emit(type: string, data: unknown, metadata?: unknown): void {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ type, data, metadata })
  }

  sentOf<T extends WebSocketEventOptionalSource['type']>(type: T): Extract<WebSocketEventOptionalSource, { type: T }>[] {
    return this.sent.filter((event): event is Extract<WebSocketEventOptionalSource, { type: T }> => event.type === type)
  }
}

export interface VideoFields {
  site?: 'youtube' | 'bilibili' | 'unknown'
  url?: string
  videoId?: string
  title?: string
  isPlaying?: boolean
  currentTimeSec?: number
  durationSec?: number
  playbackRate?: number
  isEnded?: boolean
}

export interface SubtitleFields {
  language?: string
  startMs?: number
  endMs?: number
  isAuto?: boolean
  cleared?: boolean
}

/**
 * Plays one content stream of the AIRI browser extension behind one background connection. Events have the shape that
 * `plugins/airi-plugin-web-extension/src/background/client.ts` sends: ReplaceSelf context updates on `web:video` and
 * `web:subtitle`, with `metadata.stamp` from the content observer and the background.
 */
export class FakeExtension {
  sequence = 0
  timeline = 0
  private video: Required<Pick<VideoFields, 'site' | 'url' | 'videoId' | 'title'>> = { site: 'youtube', url: 'https://www.youtube.com/watch?v=frieren3', videoId: 'frieren3', title: 'Frieren Episode 3' }

  constructor(private readonly channel: FakeChannel, private readonly now: () => number, public connection = 'conn-1', public stream = 'stream-1', public producer = 'extension-1') {}

  /** Sends one video observation. Fields persist, like a page that keeps its title and URL. */
  sendVideo(fields: VideoFields = {}, observedAt = this.now()): void {
    this.video = { site: fields.site ?? this.video.site, url: fields.url ?? this.video.url, videoId: fields.videoId ?? this.video.videoId, title: fields.title ?? this.video.title }
    const { site, url, videoId, title } = this.video
    this.emit('web:video', `User is watching: ${title}`, { site, url, title, videoId, isPlaying: fields.isPlaying, currentTimeSec: fields.currentTimeSec, durationSec: fields.durationSec, playbackRate: fields.playbackRate, isEnded: fields.isEnded }, observedAt)
  }

  sendSubtitle(text: string, fields: SubtitleFields = {}, observedAt = this.now()): void {
    const { site, url, videoId, title } = this.video
    this.emit('web:subtitle', `Subtitle: ${text}`, { site, url, title, videoId, ...fields }, observedAt)
  }

  /** A native `seeked` event starts a new timeline before the next observation. */
  seek(): void {
    this.timeline++
  }

  /** Sends a lane event with an explicit stamp, for example a delayed or replayed one. */
  sendStamped(lane: 'web:video' | 'web:subtitle', text: string, metadata: Record<string, unknown>, stamp: { sequence: number, observedAt: number, timeline: number, connection?: string, stream?: string }): void {
    this.channel.emit('context:update', {
      id: `context-${stamp.sequence}`,
      contextId: `context-${stamp.sequence}`,
      lane,
      strategy: 'replace-self',
      text,
      metadata: { source: 'web-extension', ...metadata, stamp: { connection: stamp.connection ?? this.connection, stream: stamp.stream ?? this.stream, sequence: stamp.sequence, observedAt: stamp.observedAt, timeline: stamp.timeline } },
    }, { source: { kind: 'plugin', id: this.producer, plugin: { id: WEB_EXTENSION_PLUGIN } }, event: { id: `event-${stamp.sequence}` } })
  }

  /** The extension's server connection closed. AIRI's server announces it to every module. */
  leave(): void {
    this.channel.emit('extension:module:de-announced', { name: WEB_EXTENSION_PLUGIN, identity: { id: this.producer }, possibleEvents: [] })
  }

  private emit(lane: 'web:video' | 'web:subtitle', text: string, metadata: Record<string, unknown>, observedAt: number): void {
    this.sequence++
    this.sendStamped(lane, text, metadata, { sequence: this.sequence, observedAt, timeline: this.timeline })
  }
}
