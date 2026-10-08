import type { BrowserUpdate } from '../watch'

import * as v from 'valibot'

import { normalizeBrowserLane } from '../watch'

/** The plugin id that the AIRI browser extension declares on the server channel. */
export const WEB_EXTENSION_PLUGIN = 'proj-airi:plugin-web-extension'

/** A producer clock this far ahead of the Core clock is broken, so its observations are refused. */
const MAX_CLOCK_SKEW_MS = 2000
/** Streams that the bridge follows at once. The least recently seen unselected stream is forgotten first. */
const MAX_STREAMS = 16
/** Ended sessions whose late traffic stays refused. */
const MAX_RETIRED = 256

const label = v.pipe(v.string(), v.regex(/^[\w-]{1,64}$/))
const counter = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER))

/** `metadata.stamp` of a lane event, written by the extension background (`ConnectionObservationStamp`). */
const stampSchema = v.object({
  connection: label,
  stream: label,
  sequence: counter,
  observedAt: v.pipe(v.number(), v.finite()),
  timeline: counter,
  tab: v.optional(counter),
})

const producerSchema = v.object({
  id: label,
  plugin: v.object({ id: v.literal(WEB_EXTENSION_PLUGIN) }),
})

const laneSchema = v.object({
  lane: v.picklist(['web:video', 'web:subtitle']),
  text: v.optional(v.string()),
  metadata: v.record(v.string(), v.unknown()),
})

/** One `context:update` event as the Core channel client receives it. Nothing in it is trusted yet. */
export interface LaneEvent {
  data?: unknown
  metadata?: { source?: unknown }
}

/** Why a lane event did not reach a WatchState. Ops counts them. They never hold event content. */
export type IgnoreReason
  = | 'not-a-lane'
    | 'unknown-producer'
    | 'unstamped'
    | 'future'
    | 'retired'
    | 'unparsable'
    | 'not-selected'

/** A session that this event ended, and why. */
export interface EndedSession {
  key: string
  reason: 'producer-reconnected' | 'navigated' | 'replaced'
}

export type BridgeResult
  = | { kind: 'update', key: string, session: number, update: BrowserUpdate }
    | { kind: 'ignored', reason: IgnoreReason }

interface Stream {
  key: string
  producer: string
  connection: string
  tab?: number
  session: number
  lastSeen: number
  /** Playing state of the newest video observation. Undefined until one arrives. */
  playing?: boolean
}

/**
 * Turns extension lane events into ordered WatchState updates for one selected watch session.
 *
 * Trust: AIRI's server channel authenticated the peer. The bridge accepts only the extension's declared plugin id,
 * its `web-extension` metadata, and a valid producer stamp. The channel forwards client-declared identity, so any
 * authenticated channel peer can pose as the extension. That is the trust level of every AIRI module.
 *
 * Sessions: one session per producer connection and content stream. Local session numbers only grow. A new connection
 * of a producer ends its older sessions, and a new stream in the same tab ends that tab's older stream, for example
 * after a navigation. Ended keys stay retired, so late traffic from them is refused.
 * Acquisition time is the producer's read time, capped at now. The receive time never makes an event fresh.
 *
 * Selection: the first stream with a valid video is selected. Another stream takes over only when it plays and the
 * selected stream does not play or is silent for longer than `staleMs`. Two playing tabs never flap.
 */
export class WatchBridge {
  private readonly streams = new Map<string, Stream>()
  private readonly connections = new Map<string, string>()
  private readonly retired = new Set<string>()
  private nextSession = 1
  private selectedKey?: string

  constructor(private readonly options: { now: () => number, staleMs: number }) {}

  get selected(): string | undefined {
    return this.selectedKey
  }

  /**
   * Admits one lane event. `ended` lists the sessions that this event ended, oldest first.
   * The caller ends their WatchStates before it applies the update.
   */
  accept(event: LaneEvent): { result: BridgeResult, ended: EndedSession[] } {
    const ended: EndedSession[] = []
    const lane = v.safeParse(laneSchema, event.data)
    if (!lane.success)
      return { result: { kind: 'ignored', reason: 'not-a-lane' }, ended }
    const producer = v.safeParse(producerSchema, event.metadata?.source)
    if (!producer.success)
      return { result: { kind: 'ignored', reason: 'unknown-producer' }, ended }
    const stamp = v.safeParse(stampSchema, lane.output.metadata.stamp)
    if (!stamp.success)
      return { result: { kind: 'ignored', reason: 'unstamped' }, ended }

    const now = this.options.now()
    const { connection, stream: streamId, sequence, observedAt, timeline, tab } = stamp.output
    const producerId = producer.output.id
    const key = `${producerId}|${connection}|${streamId}`
    if (this.retired.has(key))
      return { result: { kind: 'ignored', reason: 'retired' }, ended }
    if (observedAt > now + MAX_CLOCK_SKEW_MS)
      return { result: { kind: 'ignored', reason: 'future' }, ended }

    // A producer reconnect replaces every session of its previous connection.
    const known = this.connections.get(producerId)
    if (known !== undefined && known !== connection)
      ended.push(...this.retireProducer(producerId).map(key => ({ key, reason: 'producer-reconnected' as const })))
    this.connections.set(producerId, connection)

    let stream = this.streams.get(key)
    if (!stream) {
      // The tab loaded another page. Its old observer is gone and never sends again.
      if (tab !== undefined) {
        for (const old of [...this.streams.values()].filter(other => other.producer === producerId && other.connection === connection && other.tab === tab)) {
          ended.push({ key: old.key, reason: 'navigated' })
          this.retire(old.key)
        }
      }
      stream = { key, producer: producerId, connection, tab, session: this.nextSession++, lastSeen: now }
      this.streams.set(key, stream)
      this.evict()
    }
    stream.lastSeen = now

    // Small producer clock skew is capped, so the event is never newer than its arrival.
    const update = normalizeBrowserLane(lane.output, { session: stream.session, sequence, observed_at: Math.min(observedAt, now), timeline })
    if (!update)
      return { result: { kind: 'ignored', reason: 'unparsable' }, ended }
    if (update.kind === 'video' && update.playing !== undefined)
      stream.playing = update.playing

    if (this.selectedKey !== key && update.kind === 'video' && this.takesOver(stream)) {
      if (this.selectedKey)
        ended.push({ key: this.selectedKey, reason: 'replaced' })
      this.selectedKey = key
    }
    if (this.selectedKey !== key)
      return { result: { kind: 'ignored', reason: 'not-selected' }, ended }
    return { result: { kind: 'update', key, session: stream.session, update }, ended }
  }

  /** The extension left the channel. Returns the ended session keys. */
  producerGone(producerId: string): string[] {
    this.connections.delete(producerId)
    return this.retireProducer(producerId)
  }

  /** The Core lost the channel. Every session ends, because their traffic can no longer arrive. */
  reset(): string[] {
    const ended = [...this.streams.keys()]
    for (const key of ended)
      this.retire(key)
    this.connections.clear()
    return ended
  }

  /** Ends one session, for example after it was silent for too long. Its late traffic stays refused. */
  end(key: string): void {
    this.retire(key)
  }

  private takesOver(candidate: Stream): boolean {
    const selected = this.selectedKey ? this.streams.get(this.selectedKey) : undefined
    if (!selected)
      return true
    if (candidate.playing !== true)
      return false
    return selected.playing !== true || this.options.now() - selected.lastSeen > this.options.staleMs
  }

  private retireProducer(producerId: string): string[] {
    const keys = [...this.streams.values()].filter(stream => stream.producer === producerId).map(stream => stream.key)
    for (const key of keys)
      this.retire(key)
    return keys
  }

  private retire(key: string): void {
    this.streams.delete(key)
    if (this.selectedKey === key)
      this.selectedKey = undefined
    this.retired.add(key)
    if (this.retired.size > MAX_RETIRED)
      this.retired.delete(this.retired.values().next().value!)
  }

  private evict(): void {
    if (this.streams.size <= MAX_STREAMS)
      return
    const oldest = [...this.streams.values()].filter(stream => stream.key !== this.selectedKey).sort((a, b) => a.lastSeen - b.lastSeen)[0]
    if (oldest)
      this.retire(oldest.key)
  }
}
