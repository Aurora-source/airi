import type { SubtitleUpdate } from '../../watch/contracts'
import type { CueRequest, PlayerObservation } from '../../watch/sources'
import type { JellyfinClient } from './jellyfin-client'

import * as v from 'valibot'

import { assLinesOf, dialogueOf } from '../../watch/subtitle-text'

/** Fastest lookup rate: four per second at most. */
const MIN_DELAY_MS = 250
/** Lookup interval while no cue shows. A new line shows up within this time. */
const GAP_DELAY_MS = 500
/** Server positions are estimates. Their cue end gets this margin, so a gap starts late rather than early. */
const ESTIMATED_END_MARGIN_MS = 600

const eventSchema = v.object({ Text: v.optional(v.nullable(v.string())), StartPositionTicks: v.number(), EndPositionTicks: v.number() })
const trackSchema = v.object({ TrackEvents: v.optional(v.nullable(v.array(eventSchema))) })

/**
 * Looks up the cue that shows now in a text subtitle stream of the Jellyfin server, for playback whose player reports
 * no subtitle text (Jellyfin Web draws ASS on a canvas, and Jellyfin Media Player without IPC tells nothing).
 *
 * Spoilers: every request asks for one instant, `startPositionTicks = endPositionTicks = now`. The server then keeps
 * only cues with start <= now <= end, and the window checks that again. No later cue is ever requested or held.
 *
 * Scheduling: the next lookup runs when the current cue ends, or every 500 ms in a gap, at most four per second. A
 * paused player gets one lookup. Each request carries the watch session and timeline that asked for it, so a cue of
 * an older timeline is refused by the source manager.
 */
export class JellyfinCueWindow {
  lookups = 0
  private request?: CueRequest
  private timer?: ReturnType<typeof setTimeout>
  private inFlight = false
  private connection = 0
  private sequence = 0
  private session?: number
  private lastCue?: { text: string, start: number, end?: number }
  private pausedAt?: number

  constructor(private readonly options: { client: JellyfinClient, now: () => number, publish: (observation: PlayerObservation) => void }) {}

  follow(request: CueRequest | undefined): void {
    const previous = this.request
    this.request = request
    if (!request) {
      clearTimeout(this.timer)
      this.timer = undefined
      this.lastCue = undefined
      return
    }
    const same = previous && previous.session === request.session && previous.timeline === request.timeline && previous.item === request.item && previous.media_source === request.media_source && previous.index === request.index
    if (request.session !== this.session) {
      this.session = request.session
      this.connection++
    }
    if (!same) {
      this.lastCue = undefined
      this.pausedAt = undefined
      this.schedule(0)
      return
    }
    // A resume needs a fresh lookup. A pause gets one lookup at the paused position.
    if (request.playing && previous?.playing === false)
      this.schedule(0)
    if (!request.playing && previous?.playing === true)
      this.schedule(0)
    if (!this.timer && !this.inFlight && request.playing)
      this.schedule(0)
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.lookup()
    }, Math.max(delay, delay === 0 ? 0 : MIN_DELAY_MS))
    this.timer.unref?.()
  }

  private async lookup(): Promise<void> {
    const request = this.request
    if (!request || this.inFlight)
      return
    const position = request.position()
    if (position === undefined) {
      this.schedule(GAP_DELAY_MS)
      return
    }
    if (!request.playing) {
      if (this.pausedAt === position)
        return
      this.pausedAt = position
    }
    else {
      this.pausedAt = undefined
    }
    // Zero would disable the server's end filter, so the instant starts at one tick.
    const ticks = Math.max(1, Math.round(position * 10_000_000))
    this.inFlight = true
    this.lookups++
    const reply = await this.options.client.get<unknown>(`Videos/${request.item}/${request.media_source}/Subtitles/${request.index}/Stream.js`, { startPositionTicks: ticks, endPositionTicks: ticks, copyTimestamps: true })
    this.inFlight = false
    if (this.request !== request)
      return
    const parsed = reply.ok ? v.safeParse(trackSchema, reply.data) : undefined
    if (!parsed?.success) {
      this.schedule(GAP_DELAY_MS * 2)
      return
    }
    const now = this.options.now()
    // Signs are on-screen text, not speech. They neither give text nor stretch the timing of the spoken cue.
    const spoken = (parsed.output.TrackEvents ?? [])
      .filter(event => event.StartPositionTicks <= ticks && event.EndPositionTicks >= ticks)
      .map(event => ({ event, lines: assLinesOf((event.Text ?? '').replace(/<\/?[a-z][^>]*>/gi, ''), 'ass').filter(line => line.kind !== 'sign') }))
      .filter(entry => entry.lines.length > 0)
    const active = spoken.map(entry => entry.event)
    const text = dialogueOf(spoken.flatMap(entry => entry.lines))
    if (!text) {
      if (this.lastCue) {
        const cleared = this.lastCue.end === undefined
        this.lastCue = undefined
        this.emit(request, now, { text: '', ...(cleared ? { cleared: true } : {}) })
      }
      if (request.playing)
        this.schedule(GAP_DELAY_MS)
      return
    }
    const start = Math.min(...active.map(event => event.StartPositionTicks)) / 10_000
    const rawEnd = Math.max(...active.map(event => event.EndPositionTicks)) / 10_000
    const end = request.sync === 'estimated' ? rawEnd + ESTIMATED_END_MARGIN_MS : rawEnd
    if (!this.lastCue || this.lastCue.text !== text || this.lastCue.start !== start) {
      this.lastCue = { text, start, end }
      this.emit(request, now, { text, start_ms: Math.round(start), end_ms: Math.round(end), ...(request.language ? { language: request.language } : {}) })
    }
    if (request.playing)
      this.schedule(Math.max(MIN_DELAY_MS, rawEnd - position * 1000 + 50))
  }

  private emit(request: CueRequest, now: number, fields: Pick<SubtitleUpdate, 'text'> & Partial<SubtitleUpdate>): void {
    const update: SubtitleUpdate = {
      kind: 'subtitle',
      stamp: { session: this.connection, sequence: ++this.sequence, observed_at: now, timeline: request.timeline },
      media_id: `jellyfin:${request.item}`,
      automatic: false,
      sync: request.sync,
      ...fields,
    }
    this.options.publish({ player: { key: `jellyfin-cues:${request.player}`, kind: 'jellyfin-client', reach: 'server', eligible: true, links: [`jf-item:${request.item}`] }, update })
  }
}
