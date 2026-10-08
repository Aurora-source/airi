import type { CaptionTrack, Evidence, JellyfinRef, MediaIdentity, SubtitleUpdate, VideoUpdate } from '../../src/watch/contracts'
import type { AdapterStatus, CueRequest, MediaSourceAdapter, PlayerEndReason, PlayerRef, SourceEvents } from '../../src/watch/sources'

/**
 * A media source adapter whose observations the test sends by hand, on the test clock. It implements the same
 * interface as the mpv, VLC, and Jellyfin adapters, so CompanionWatch treats it like a real source.
 *
 * @example
 * const jellyfin = new ScriptedSource('jellyfin', now)
 * const session = jellyfin.player({ key: 'jellyfin:s1', reach: 'server' }, { id: 'jellyfin:item', site: 'jellyfin' })
 * session.video({ playing: true, position: 10 })
 */
export class ScriptedSource implements MediaSourceAdapter {
  events?: SourceEvents
  readonly cueRequests: Array<CueRequest | undefined> = []
  wakes = 0
  stopped = false

  constructor(readonly kind: AdapterStatus['adapter'], private readonly now: () => number) {}

  start(events: SourceEvents): void {
    this.events = events
  }

  async stop(): Promise<void> {
    this.stopped = true
  }

  status(): AdapterStatus {
    return { adapter: this.kind, enabled: true, connection: 'connected', players: 0, limitations: [] }
  }

  wake(): void {
    this.wakes++
  }

  followCues(request: CueRequest | undefined): void {
    this.cueRequests.push(request)
  }

  player(ref: Partial<PlayerRef> & { key: string }, media: Partial<MediaIdentity> & { id: string }): ScriptedPlayer {
    return new ScriptedPlayer(this, { kind: 'mpv', reach: 'direct', eligible: true, links: [], ...ref }, media, this.now)
  }
}

/** One player of a scripted source. It keeps the connection, sequence, and timeline that a real adapter keeps. */
export class ScriptedPlayer {
  session = 1
  sequence = 0
  timeline = 0
  media: MediaIdentity
  jellyfin?: JellyfinRef
  captions?: CaptionTrack

  constructor(private readonly source: ScriptedSource, readonly ref: PlayerRef, media: Partial<MediaIdentity> & { id: string }, private readonly now: () => number) {
    this.media = { site: 'local', ...media }
  }

  evidence<T>(value: T, source: Evidence<T>['source'], confidence: number): Evidence<T> {
    return { value, source, confidence, observed_at: this.now(), valid_until: this.now() + 35_000 }
  }

  video(fields: Partial<Omit<VideoUpdate, 'kind' | 'stamp' | 'media'>> = {}): void {
    const update: VideoUpdate = {
      kind: 'video',
      stamp: this.stamp(),
      media: structuredClone(this.media),
      playing: true,
      position: 10,
      rate: 1,
      source: this.ref.reach === 'server' ? 'server' : 'player',
      ...(this.captions ? { captions: structuredClone(this.captions) } : {}),
      ...(this.jellyfin ? { jellyfin: { ...this.jellyfin } } : {}),
      ...fields,
    }
    this.source.events?.observe({ player: { ...this.ref, links: [...this.ref.links] }, update })
  }

  subtitle(text: string, fields: Partial<Omit<SubtitleUpdate, 'kind' | 'stamp'>> = {}): void {
    const update: SubtitleUpdate = { kind: 'subtitle', stamp: this.stamp(), media_id: this.media.id, text, automatic: false, ...fields }
    this.source.events?.observe({ player: { ...this.ref, links: [...this.ref.links] }, update })
  }

  gone(reason: PlayerEndReason): void {
    this.source.events?.gone(this.ref.key, reason)
    this.session++
  }

  private stamp() {
    return { session: this.session, sequence: ++this.sequence, observed_at: this.now(), timeline: this.timeline }
  }
}
