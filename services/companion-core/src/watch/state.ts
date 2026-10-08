import type { BrowserStamp, BrowserUpdate, Dialogue, Evidence, FreshPerceptionPort, MediaIdentity, WatchEventKind, WatchEventPort, WatchOptions, WatchSnapshot } from './contracts'

import { watchDefaults } from './contracts'

/**
 * Owns volatile current media, dialogue and scene evidence for one selected browser session.
 * Lane sequence numbers, playback epochs and acquisition time guard independent event streams.
 * Disconnect, seek, navigation and cancellation erase prior dialogue and invalidate pending work.
 */
export class WatchState {
  readonly options: WatchOptions
  private session = -1
  private connected = false
  private cancelled = false
  private revision = 0
  private lanes = new Map<BrowserUpdate['kind'], BrowserStamp>()
  private video_stamp?: BrowserStamp
  private media?: MediaIdentity
  private playback?: Evidence<'playing' | 'paused'>
  private position?: Evidence<number>
  private rate = 1
  private dialogue?: Dialogue
  private activity?: Evidence<boolean>
  private scene?: Evidence<string>
  private visual_title?: Evidence<string>
  private visual_time = -1
  private changed_at = -1
  private changed_sequence = -1
  private gap_since?: number
  private gap_until = -1
  private metadata?: { title?: Evidence<string>, episode?: Evidence<number> }
  private subtitle_title?: Evidence<string>
  private perception_blocked = false
  private completed = false
  private readonly listeners = new Set<() => void>()

  constructor(private readonly ports: { now: () => number, events?: WatchEventPort }, options: Partial<WatchOptions> = {}) {
    this.options = { ...watchDefaults, ...options }
    if (Object.values(this.options).some(value => !Number.isFinite(value) || value <= 0))
      throw new Error('Invalid watch timing configuration')
  }

  /** A reconnect requires a larger trusted session number. Old queued messages remain inadmissible. */
  connect(session: number): boolean {
    if (this.cancelled || !Number.isSafeInteger(session) || session <= this.session)
      return false
    this.disconnect()
    this.session = session
    this.connected = true
    this.lanes.clear()
    return true
  }

  disconnect(): void {
    if (this.media)
      this.publish('stopped')
    this.connected = false
    this.media = undefined
    this.playback = undefined
    this.position = undefined
    this.video_stamp = undefined
    this.invalidate()
    this.notify()
  }

  /** Terminal cancellation revokes all evidence. Create another instance for a new watch session. */
  cancel(): void {
    this.disconnect()
    this.cancelled = true
    this.notify()
    this.listeners.clear()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  ingest(update: BrowserUpdate): boolean {
    const now = this.ports.now()
    const stamp = update.stamp
    const previous = this.lanes.get(update.kind)
    if (!this.connected || this.cancelled || stamp.session !== this.session
      || ![stamp.sequence, stamp.timeline].every(value => Number.isSafeInteger(value) && value >= 0)
      || !Number.isFinite(stamp.observed_at) || stamp.observed_at > now
      || now - stamp.observed_at >= this.options.browser_ttl_ms
      || (previous && (stamp.sequence <= previous.sequence || stamp.observed_at < previous.observed_at))) {
      return false
    }

    if (update.kind === 'subtitle') {
      if (!this.media || !this.video_stamp || update.media_id !== this.media.id
        || stamp.timeline !== this.video_stamp.timeline || stamp.observed_at < this.changed_at
        || stamp.sequence <= this.changed_sequence || now - stamp.observed_at >= this.options.subtitle_ttl_ms) {
        return false
      }
      this.lanes.set('subtitle', { ...stamp })
      this.acceptSubtitle(update)
    }
    else {
      if (this.video_stamp && stamp.timeline < this.video_stamp.timeline)
        return false
      this.lanes.set('video', { ...stamp })
      this.acceptVideo(update)
    }
    this.notify()
    return true
  }

  /** R5 owns privacy, validation and source freshness. R6 copies only bounded current facts. */
  fuse(perception: FreshPerceptionPort): void {
    if (this.cancelled)
      return
    const world = perception.current()
    this.perception_blocked = world.status === 'blocked-by-privacy'
    if (world.status !== 'fresh') {
      this.clearVisual()
      this.notify()
      return
    }
    const o = world.observation
    const now = this.ports.now()
    if (!o.media.detected || o.captured_at > now || o.valid_until <= now || o.captured_at < this.changed_at
      || o.captured_at < this.visual_time || !Number.isFinite(o.confidence)) {
      if (this.scene && this.scene.valid_until <= now)
        this.clearVisual()
      return
    }
    this.visual_time = o.captured_at
    const evidence = <T>(value: T): Evidence<T> => ({ value, source: 'visual', confidence: Math.max(0, Math.min(0.6, o.confidence)), observed_at: o.captured_at, valid_until: o.valid_until })
    this.scene = o.concise_summary ? evidence(o.concise_summary.slice(0, 320)) : undefined
    this.visual_title = o.media.title_like_text ? evidence(o.media.title_like_text.slice(0, 160)) : undefined
    // A visual subtitle is uncertain dialogue, but can conservatively suppress an interruption.
    if ((!this.dialogue || this.dialogue.valid_until <= now || this.dialogue.source === 'visual' || this.dialogue.source === 'system-audio') && o.media.subtitle_like_text) {
      this.dialogue = evidence(o.media.subtitle_like_text.slice(0, 160))
      this.gap_since = undefined
    }
    this.notify()
  }

  /** VAD gaps are independent cheap evidence. Fresh captions still override a reported audio gap. */
  dialogueActivity(active: boolean, at: number, ttl_ms = 2500): boolean {
    const now = this.ports.now()
    if (this.cancelled || !this.media || at > now || at < this.changed_at || !Number.isFinite(at)
      || !Number.isFinite(ttl_ms) || ttl_ms <= 0 || at + ttl_ms <= now || (this.activity && at < this.activity.observed_at)) {
      return false
    }
    const continuousGap = !active && this.activity?.value === false && this.activity.valid_until >= at && this.gap_until >= at
      ? this.gap_since
      : undefined
    this.activity = { value: active, source: 'system-audio', confidence: 0.65, observed_at: at, valid_until: at + Math.min(5000, ttl_ms) }
    this.gap_since = active ? undefined : continuousGap ?? at
    this.gap_until = this.activity.valid_until
    this.notify()
    return true
  }

  /** Optional metadata fills missing identity fields only after the host correlates the current media ID. */
  enrich(input: { media_id: string, title?: string, episode?: number, observed_at: number }): boolean {
    const current = this.current()
    const at = input.observed_at
    if (!current.media || input.media_id !== current.media.id || !Number.isFinite(at) || at > this.ports.now()
      || at < this.changed_at || at + this.options.browser_ttl_ms <= this.ports.now()
      || (this.metadata?.title && at < this.metadata.title.observed_at) || (this.metadata?.episode && at < this.metadata.episode.observed_at)) {
      return false
    }
    const title = typeof input.title === 'string' ? input.title.replace(/\p{Cc}/gu, ' ').trim().slice(0, 160) : ''
    const valid_until = at + this.options.browser_ttl_ms
    if (!this.media?.episode && current.media.episode && input.episode && input.episode !== current.media.episode.value) {
      this.invalidate()
      this.changed_at = at
      this.changed_sequence = this.video_stamp?.sequence ?? -1
    }
    this.metadata = {
      title: title ? { value: title, source: 'metadata', confidence: 0.8, observed_at: at, valid_until } : undefined,
      episode: input.episode && Number.isSafeInteger(input.episode) && input.episode > 0
        ? { value: input.episode, source: 'metadata', confidence: 0.8, observed_at: at, valid_until }
        : undefined,
    }
    this.notify()
    return true
  }

  /** A bounded STT result cannot replace fresher or stronger dialogue evidence. */
  audioDialogue(text: string, language: 'en' | 'ja', at: number, revision: number): boolean {
    const current = this.current()
    if (this.cancelled || this.perception_blocked || current.status !== 'watching' || revision !== this.revision
      || !Number.isFinite(at) || at < this.changed_at || at > this.ports.now()
      || at + this.options.subtitle_ttl_ms <= this.ports.now()
      || (this.dialogue && this.dialogue.valid_until > this.ports.now() && (this.dialogue.source !== 'system-audio' || this.dialogue.observed_at > at))) {
      return false
    }
    const value = text.replace(/\p{Cc}/gu, ' ').trim().slice(0, 320)
    if (!value)
      return false
    this.dialogue = { value, language, source: 'system-audio', confidence: 0.55, observed_at: at, valid_until: at + this.options.subtitle_ttl_ms }
    this.gap_since = undefined
    this.notify()
    return true
  }

  /** Only the host's correlated ended signal confirms completion. Position alone cannot prove an episode finished. */
  finished(revision: number): boolean {
    const current = this.current()
    if (revision !== this.revision || this.completed || current.status !== 'watching' || !current.media?.episode)
      return false
    this.completed = true
    this.publish('finished-episode')
    return true
  }

  shared(kind: 'shared-reaction' | 'user-opinion', detail: string): void {
    if (this.current().status === 'watching')
      this.publish(kind, detail.replace(/\p{Cc}/gu, ' ').slice(0, 240))
  }

  /** Every read applies expiry. Returned objects are detached from the owned volatile state. */
  current(): WatchSnapshot {
    const now = this.ports.now()
    const fresh = <T>(value?: Evidence<T>): Evidence<T> | undefined => value && value.valid_until > now ? { ...value } : undefined
    const media = this.media && this.video_stamp && this.video_stamp.observed_at + this.options.browser_ttl_ms > now
      ? { ...this.media, title: fresh(this.media.title) ?? fresh(this.subtitle_title) ?? fresh(this.metadata?.title), episode: fresh(this.media.episode) ?? fresh(this.metadata?.episode) }
      : undefined
    const playback = media ? fresh(this.playback) : undefined
    let dialogue = fresh(this.dialogue)
    if (dialogue && this.dialogue?.end_ms !== undefined && playback?.value === 'playing' && this.position && this.position.valid_until > now) {
      const endAt = this.position.observed_at + (this.dialogue.end_ms / 1000 - this.position.value) * 1000 / this.rate
      if (endAt <= now) {
        this.gap_since = endAt
        this.gap_until = endAt + this.options.subtitle_ttl_ms
        this.dialogue = undefined
        dialogue = undefined
      }
    }
    if (this.dialogue && this.dialogue.valid_until <= now) {
      this.dialogue = undefined
      this.gap_since = undefined
    }
    const activity = media ? fresh(this.activity) : undefined
    let dialogue_active: WatchSnapshot['dialogue_active'] = 'unknown'
    if (media && playback?.value === 'paused')
      dialogue_active = 'gap'
    else if (media && (dialogue || activity?.value === true))
      dialogue_active = 'active'
    else if (media && (activity?.value === false || (this.gap_since !== undefined && this.gap_until > now)))
      dialogue_active = 'gap'
    const scene = fresh(this.scene)
    const visual_title = fresh(this.visual_title)
    const titleConflict = media?.title && visual_title && media.title.value.toLocaleLowerCase() !== visual_title.value.toLocaleLowerCase()
    const dialogue_valid_until = dialogue_active === 'gap'
      ? playback?.value === 'paused' ? playback.valid_until : Math.max(activity?.value === false ? activity.valid_until : -1, this.gap_until)
      : dialogue_active === 'active' ? Math.max(dialogue?.valid_until ?? -1, activity?.value === true ? activity.valid_until : -1) : undefined
    return {
      status: this.cancelled ? 'cancelled' : media ? 'watching' : this.media ? 'stale' : 'idle',
      revision: this.revision,
      valid_until: media && this.video_stamp ? this.video_stamp.observed_at + this.options.browser_ttl_ms : undefined,
      media,
      playback,
      position: media ? fresh(this.position) : undefined,
      dialogue: media || dialogue?.source === 'visual' ? dialogue : undefined,
      dialogue_active,
      gap_since: dialogue_active === 'gap' ? this.gap_since : undefined,
      dialogue_valid_until,
      scene,
      visual_title,
      conflicts: titleConflict ? ['title-conflict'] : [],
      confidence: media?.title?.confidence ?? visual_title?.confidence ?? 0,
      perception_blocked: this.perception_blocked,
    }
  }

  private acceptVideo(update: Extract<BrowserUpdate, { kind: 'video' }>): void {
    const previous = this.current()
    const stamp = update.stamp
    const changed = this.media && (update.media.id !== this.media.id || update.media.episode?.value !== this.media.episode?.value)
    const predicted = this.position ? this.position.value + (this.playback?.value === 'playing' ? (stamp.observed_at - this.position.observed_at) * this.rate / 1000 : 0) : undefined
    const seek = update.position !== undefined && predicted !== undefined && Math.abs(update.position - predicted) > 3
    const timelineChanged = this.video_stamp && stamp.timeline !== this.video_stamp.timeline
    if (changed)
      this.publish('stopped')
    if (!this.media || changed || seek || timelineChanged) {
      this.invalidate()
      this.changed_at = stamp.observed_at
      this.changed_sequence = stamp.sequence
    }
    const valid_until = stamp.observed_at + this.options.browser_ttl_ms
    this.media = structuredClone(update.media)
    for (const item of [this.media.title, this.media.episode]) {
      if (item)
        item.valid_until = valid_until
    }
    if (changed || !this.video_stamp) {
      this.playback = undefined
      this.position = undefined
      this.rate = 1
    }
    else if (update.position === undefined && predicted !== undefined && this.position && this.position.valid_until > this.ports.now()) {
      // Pause and rate changes anchor media time without renewing an old position source's TTL.
      this.position = { ...this.position, value: predicted, observed_at: stamp.observed_at }
    }
    this.video_stamp = { ...stamp }
    if (update.playing !== undefined) {
      this.playback = { value: update.playing ? 'playing' : 'paused', source: 'browser', confidence: 0.95, observed_at: stamp.observed_at, valid_until }
      if (!update.playing) {
        this.gap_since = stamp.observed_at
      }
      else if (previous.playback?.value === 'paused') {
        this.gap_since = undefined
        this.activity = undefined
        // Resume revokes pre-resume silence, including delayed subtitle and VAD events from the same playback epoch.
        this.changed_at = stamp.observed_at
        this.changed_sequence = stamp.sequence
      }
    }
    if (update.position !== undefined)
      this.position = { value: update.position, source: 'browser', confidence: 0.9, observed_at: stamp.observed_at, valid_until }
    this.rate = update.rate && update.rate > 0 ? update.rate : this.rate
    if (!previous.media || changed)
      this.publish('started')
    else if (previous.playback?.value === 'playing' && this.playback?.value === 'paused')
      this.publish('paused')
    else if (previous.playback?.value === 'paused' && this.playback?.value === 'playing')
      this.publish('resumed')
  }

  private acceptSubtitle(update: Extract<BrowserUpdate, { kind: 'subtitle' }>): void {
    if (update.title)
      this.subtitle_title = { value: update.title, source: 'subtitle', confidence: 0.8, observed_at: update.stamp.observed_at, valid_until: update.stamp.observed_at + this.options.browser_ttl_ms }
    if (!update.text) {
      this.dialogue = undefined
      this.gap_since = update.stamp.observed_at
      this.gap_until = update.stamp.observed_at + this.options.subtitle_ttl_ms
      return
    }
    if (this.dialogue?.source === 'subtitle' && this.dialogue.value === update.text && this.dialogue.start_ms === update.start_ms)
      return
    this.dialogue = { value: update.text, language: update.language, start_ms: update.start_ms, end_ms: update.end_ms, source: 'subtitle', confidence: update.automatic ? 0.65 : 0.85, observed_at: update.stamp.observed_at, valid_until: update.stamp.observed_at + this.options.subtitle_ttl_ms }
    this.gap_since = undefined
  }

  private invalidate(): void {
    this.revision++
    this.dialogue = undefined
    this.activity = undefined
    this.gap_since = undefined
    this.completed = false
    this.metadata = undefined
    this.subtitle_title = undefined
    this.clearVisual()
  }

  private clearVisual(): void {
    this.scene = undefined
    this.visual_title = undefined
    if (this.dialogue?.source === 'visual')
      this.dialogue = undefined
  }

  private publish(kind: WatchEventKind, detail?: string): void {
    if (!this.media || !this.ports.events)
      return
    try {
      this.ports.events.publish({ kind, media: structuredClone(this.current().media ?? this.media), at: this.ports.now(), ...(detail ? { detail } : {}) })
    }
    catch { /* Event consumer failure never changes current watch truth. */ }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      }
      catch { /* A consumer cannot prevent state invalidation. */ }
    }
  }
}
