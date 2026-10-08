import type { BrowserStamp, BrowserUpdate, CaptionTrack, Evidence, JellyfinRef, MediaIdentity, SubtitleUpdate, VideoUpdate } from './contracts'
import type { CueRequest, PlayerEndReason, PlayerObservation, PlayerRef } from './sources'

/** Why a group's watch session ended. */
export type GroupEndReason = PlayerEndReason | 'selected' | 'merged' | 'ineligible'

/**
 * What the watch runtime applies, in order. `start` opens a WatchState with `session`. `update` goes to that
 * WatchState. `end` cancels it.
 */
export type ManagerOutput
  = | { kind: 'start', key: string, session: number }
    | { kind: 'update', key: string, update: BrowserUpdate }
    | { kind: 'end', key: string, reason: GroupEndReason }

/** Ops view of one followed player. Titles are shown to the Ops user only. */
export interface PlayerSummary {
  key: string
  kind: PlayerRef['kind']
  reach: PlayerRef['reach']
  eligible: boolean
  group?: string
  active: boolean
  playing?: boolean
  title?: string
  episode?: number
  captions?: CaptionTrack
  lastSeenMs: number
}

export interface GroupSummary {
  key: string
  session?: number
  members: string[]
  playback?: string
  dialogue?: string
  timeline: number
  waitingForIdentity: boolean
  identitySource?: Evidence<string>['source']
}

export interface ManagerOptions {
  now: () => number
  /** Silence after which a player counts as gone. */
  staleMs: number
  /** A playing selection keeps its place against other players while it was seen this recently. */
  takeoverMs: number
  /**
   * Longest wait for library identity: before a Jellyfin-correlated group starts, and after its player changes media
   * while the server still reports the old item. @default 3000
   */
  settleMs?: number
}

/** A producer clock this far ahead of the Core clock is broken. */
const MAX_CLOCK_SKEW_MS = 2000
/** Two players without exact ids are one playback when title and episode match and positions differ less. */
const DUPLICATE_POSITION_S = 5
const MAX_PLAYERS = 64
const MAX_RETIRED = 256

interface Lane {
  sequence: number
  observed_at: number
}

interface Player {
  ref: PlayerRef
  /** Adapter connection. A larger one is a reconnect and resets the lanes. */
  session: number
  timeline: number
  lanes: { video?: Lane, subtitle?: Lane }
  video?: VideoUpdate
  playStart?: number
  lastSeen: number
  group?: Group
}

interface Group {
  key: string
  members: Set<Player>
  created: number
  started: boolean
  session?: number
  sequence: number
  timeline: number
  last: { video?: number, subtitle?: number }
  /** Playback member and the connection and timeline that the WatchState last saw from it. */
  playback?: { player: Player, session: number, timeline: number, media: string }
  dialogue?: Player
  /** Group timeline in which a direct player sent subtitles. Server cues stay out of it. */
  directSubtitles?: number
  /** Pinned media id of the WatchState, and the server item it came from. */
  media?: { id: string, server?: string }
  /** Set after the playback member changed media while the server still reports the old item. */
  holdUntil?: number
  identityKey?: string
}

/** Identity ranks: library metadata beats a page title, which beats player tags and file names. */
const SOURCE_RANK: Partial<Record<Evidence<string>['source'], number>> = { metadata: 3, browser: 2, subtitle: 2, player: 1, server: 1 }

function normalizeTitle(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function bestEvidence<T>(values: Array<Evidence<T> | undefined>): Evidence<T> | undefined {
  let best: Evidence<T> | undefined
  for (const value of values) {
    if (!value)
      continue
    const rank = SOURCE_RANK[value.source] ?? 0
    const bestRank = best ? SOURCE_RANK[best.source] ?? 0 : -1
    if (rank > bestRank || (rank === bestRank && best && value.confidence > best.confidence))
      best = value
  }
  return best
}

/**
 * Turns observations of many players into one ordered update stream for one WatchState.
 *
 * Players: each adapter reports players with a connection, per-lane sequences, a timeline, and read times. The manager
 * refuses older connections, repeated or older reads, and data of an older timeline, like the browser bridge does for
 * extension streams. Ended players stay retired, so their late traffic is refused.
 *
 * Groups: players that show the same playback form one group. Exact links join them (`jf-device`, `jf-item`).
 * Players without links join when title, episode, and position match. A group is one watch session. Inside a group,
 * a direct player gives playback and subtitles, library metadata gives identity, and server cues fill in subtitles
 * only while no direct subtitle flows.
 *
 * Selection: a manual choice wins. Otherwise the active group keeps its place while it plays or nothing else plays.
 * Another group takes over only when it plays and the active one does not. A group needs an eligible member, so media
 * on another device or of another user is never followed by itself.
 *
 * Ordering: output stamps use the group session, one sequence, and a group timeline. The timeline grows on a seek or
 * media change of the playback member, on a switch of the playback or subtitle source, and on a reconnect. That
 * revokes subtitle, gap, and reaction evidence in WatchState. Read times never go back inside a group.
 */
export class MediaSourceManager {
  /** Observations refused for order, connection, or timeline. Ops adds them to the watch rejection count. */
  refused = 0
  private readonly known = new Map<string, Player>()
  private readonly groups = new Map<string, Group>()
  private readonly retired = new Map<string, number>()
  private readonly settleMs: number
  private nextGroup = 1
  private nextSession = 1
  private activeKey?: string
  private manual?: string

  constructor(private readonly options: ManagerOptions) {
    this.settleMs = options.settleMs ?? 3000
  }

  /** Key of the group whose session is open. */
  get active(): string | undefined {
    const group = this.activeKey ? this.groups.get(this.activeKey) : undefined
    return group?.started ? group.key : undefined
  }

  observe(observation: PlayerObservation): ManagerOutput[] {
    const out: ManagerOutput[] = []
    const accepted = this.accept(observation)
    if (!accepted) {
      this.refused++
      return out
    }
    const { player, update } = accepted
    this.place(player, out)
    const startedNow = this.reconcile(out, 'replaced')
    const group = player.group
    if (!group || group.key !== this.activeKey || !group.started)
      return out
    if (update.kind === 'subtitle')
      this.emitSubtitle(group, player, update, out)
    else if (startedNow !== group)
      this.emitVideo(group, out, player)
    return out
  }

  /** The adapter stopped following a player. Its group ends when no eligible member is left. */
  gone(key: string, reason: PlayerEndReason): ManagerOutput[] {
    const out: ManagerOutput[] = []
    const player = this.known.get(key)
    if (!player)
      return out
    this.drop(player, reason, out)
    this.reconcile(out, 'replaced')
    return out
  }

  /**
   * Applies time: silent players go, a group that waited for identity starts, a media-change hold ends.
   * Call it about once per second while players exist.
   */
  tick(): ManagerOutput[] {
    const out: ManagerOutput[] = []
    const now = this.options.now()
    for (const player of [...this.known.values()]) {
      if (now - player.lastSeen > this.options.staleMs)
        this.drop(player, 'stale', out)
    }
    const startedNow = this.reconcile(out, 'replaced')
    const group = this.activeKey ? this.groups.get(this.activeKey) : undefined
    if (group?.started && group !== startedNow && group.holdUntil !== undefined && now >= group.holdUntil) {
      group.holdUntil = undefined
      this.emitVideo(group, out)
    }
    return out
  }

  /** Follows one player by the user's choice, or returns to automatic selection with `undefined`. */
  select(key: string | undefined): ManagerOutput[] | 'unknown-player' {
    if (key !== undefined && !this.known.has(key))
      return 'unknown-player'
    this.manual = key
    const out: ManagerOutput[] = []
    this.reconcile(out, 'selected')
    return out
  }

  /** The runtime ended the group's session, for example after it stayed stale. Its players are forgotten. */
  retire(groupKey: string): void {
    const group = this.groups.get(groupKey)
    if (!group)
      return
    for (const player of group.members)
      this.forget(player)
    group.members.clear()
    group.started = false
    this.groups.delete(groupKey)
    if (this.activeKey === groupKey)
      this.activeKey = undefined
  }

  /** The server cue lookup that the active group needs now, or `undefined`. */
  cueRequest(): CueRequest | undefined {
    const group = this.activeKey ? this.groups.get(this.activeKey) : undefined
    if (!group?.started || group.holdUntil !== undefined || group.directSubtitles === group.timeline)
      return undefined
    const playback = this.playbackMember(group)
    const server = this.serverMember(group)
    const ref = server?.video?.jellyfin
    if (!playback?.video || !server?.video || !ref?.item || !ref.media_source || ref.subtitle_stream === undefined || ref.subtitle_stream < 0)
      return undefined
    // The player reads its own subtitle text, so server cues add nothing.
    if (playback.ref.reach === 'direct' && playback.video.captions?.form === 'text')
      return undefined
    if (server.video.captions?.form !== 'text')
      return undefined
    return {
      player: server.ref.key,
      item: ref.item,
      media_source: ref.media_source,
      index: ref.subtitle_stream,
      sync: playback.ref.reach === 'direct' ? 'exact' : 'estimated',
      session: group.session!,
      timeline: group.timeline,
      ...(server.video.captions.language ? { language: server.video.captions.language } : {}),
      playing: playback.video.playing === true,
      position: () => this.positionOf(group),
    }
  }

  players(): PlayerSummary[] {
    const now = this.options.now()
    return [...this.known.values()].map(player => ({
      key: player.ref.key,
      kind: player.ref.kind,
      reach: player.ref.reach,
      eligible: player.ref.eligible,
      group: player.group?.key,
      active: player.group !== undefined && player.group.key === this.active,
      playing: player.video?.playing,
      title: player.video?.media.title?.value,
      episode: player.video?.media.episode?.value,
      captions: player.video?.captions && structuredClone(player.video.captions),
      lastSeenMs: now - player.lastSeen,
    }))
  }

  /** The active group, or the group that waits to become active. */
  activeGroup(): GroupSummary | undefined {
    const group = this.activeKey ? this.groups.get(this.activeKey) : this.target()
    if (!group)
      return undefined
    return {
      key: group.key,
      session: group.session,
      members: [...group.members].map(member => member.ref.key),
      playback: this.playbackMember(group)?.ref.key,
      dialogue: group.dialogue?.ref.key,
      timeline: group.timeline,
      waitingForIdentity: !group.started || group.holdUntil !== undefined,
      identitySource: bestEvidence([...group.members].map(member => member.video?.media.title))?.source,
    }
  }

  get manualSelection(): string | undefined {
    return this.manual
  }

  /** Checks connection, lane order, and timeline of one observation, then stores it on its player. */
  private accept({ player: ref, update }: PlayerObservation): { player: Player, update: BrowserUpdate } | undefined {
    const now = this.options.now()
    const stamp = update.stamp
    if (![stamp.session, stamp.sequence, stamp.timeline].every(value => Number.isSafeInteger(value) && value >= 0)
      || !Number.isFinite(stamp.observed_at) || stamp.observed_at > now + MAX_CLOCK_SKEW_MS) {
      return undefined
    }
    const retired = this.retired.get(ref.key)
    if (retired !== undefined && stamp.session <= retired)
      return undefined
    let player = this.known.get(ref.key)
    if (player && stamp.session < player.session)
      return undefined
    if (!player) {
      player = { ref, session: stamp.session, timeline: stamp.timeline, lanes: {}, lastSeen: now }
      this.known.set(ref.key, player)
      this.evict()
    }
    else if (stamp.session > player.session) {
      // A reconnect: the old connection's data is gone, and its timeline means nothing now.
      player.session = stamp.session
      player.timeline = stamp.timeline
      player.lanes = {}
      player.video = undefined
    }
    const observed_at = Math.min(stamp.observed_at, now)
    const lane = player.lanes[update.kind]
    if ((lane && (stamp.sequence <= lane.sequence || observed_at < lane.observed_at)) || stamp.timeline < player.timeline)
      return undefined
    // A subtitle of a timeline that no video announced yet cannot be placed. Adapters send the video first.
    if (update.kind === 'subtitle' && player.video && stamp.timeline > player.timeline)
      return undefined
    player.lanes[update.kind] = { sequence: stamp.sequence, observed_at }
    player.timeline = stamp.timeline
    player.ref = { ...ref, links: [...ref.links] }
    player.lastSeen = now
    const stored = structuredClone({ ...update, stamp: { ...stamp, observed_at } }) as BrowserUpdate
    if (stored.kind === 'video') {
      if (stored.playing === true && player.video?.playing !== true)
        player.playStart = observed_at
      player.video = stored
    }
    return { player, update: stored }
  }

  /** Puts a player into the group that it links to. Players never leave a group on their own, so a lagging member cannot split a playback. */
  private place(player: Player, out: ManagerOutput[]): void {
    const matches = this.matches(player)
    if (matches.length === 0) {
      if (!player.group)
        this.join(this.createGroup(), player)
      return
    }
    const involved = [...new Set([...(player.group ? [player.group] : []), ...matches])]
    // The active group survives a merge, so its watch session continues. Otherwise the oldest group survives.
    const target = involved.find(group => group.key === this.activeKey) ?? involved.sort((a, b) => a.created - b.created)[0]
    for (const group of involved) {
      if (group === target)
        continue
      for (const member of [...group.members])
        this.join(target, member)
      this.dissolve(group, 'merged', out)
    }
    if (player.group !== target)
      this.join(target, player)
  }

  private matches(player: Player): Group[] {
    const found = new Set<Group>()
    const links = new Set(player.ref.links)
    for (const other of this.known.values()) {
      if (other !== player && other.group && other.group !== player.group && other.ref.links.some(link => links.has(link)))
        found.add(other.group)
    }
    if (found.size > 0 || links.size > 0 || !player.video)
      return [...found]
    for (const group of this.groups.values()) {
      if (group === player.group)
        continue
      const other = this.playbackMember(group)
      if (other && other.ref.links.length === 0 && this.sameMedia(player, other))
        found.add(group)
    }
    return [...found]
  }

  private sameMedia(a: Player, b: Player): boolean {
    const left = a.video?.media
    const right = b.video?.media
    if (!left?.title || !right?.title || normalizeTitle(left.title.value) !== normalizeTitle(right.title.value) || left.episode?.value !== right.episode?.value)
      return false
    const positionA = this.extrapolate(a)
    const positionB = this.extrapolate(b)
    return positionA !== undefined && positionB !== undefined && Math.abs(positionA - positionB) < DUPLICATE_POSITION_S
  }

  private createGroup(): Group {
    const group: Group = { key: `g${this.nextGroup++}`, members: new Set(), created: this.options.now(), started: false, sequence: 0, timeline: 0, last: {} }
    this.groups.set(group.key, group)
    return group
  }

  private join(group: Group, player: Player): void {
    player.group?.members.delete(player)
    player.group = group
    group.members.add(player)
  }

  /** Chooses the group to follow and switches to it once it is ready. Returns the group that started now. */
  private reconcile(out: ManagerOutput[], reason: 'replaced' | 'selected'): Group | undefined {
    const target = this.target()
    const current = this.activeKey ? this.groups.get(this.activeKey) : undefined
    if (target === current) {
      if (current && !current.started && this.ready(current)) {
        this.start(current, out)
        return current
      }
      return undefined
    }
    // A group that waits for identity does not displace the current one yet.
    if (target && !this.ready(target))
      return undefined
    if (current)
      this.stop(current, reason, out)
    this.activeKey = target?.key
    if (!target)
      return undefined
    this.start(target, out)
    return target
  }

  private target(): Group | undefined {
    const now = this.options.now()
    if (this.manual) {
      const chosen = this.known.get(this.manual)?.group
      if (chosen && this.playbackMember(chosen))
        return chosen
    }
    const candidates = [...this.groups.values()].filter(group => this.eligible(group) && this.playbackMember(group))
    const current = this.activeKey ? this.groups.get(this.activeKey) : undefined
    const playing = (group: Group) => {
      const member = this.playbackMember(group)
      return member?.video?.playing === true && now - (member.lanes.video?.observed_at ?? -Infinity) < this.options.takeoverMs
    }
    if (current && candidates.includes(current) && (playing(current) || !candidates.some(group => group !== current && playing(group))))
      return current
    const pool = candidates.some(playing) ? candidates.filter(playing) : candidates
    return pool.sort((a, b) => this.priority(b) - this.priority(a) || this.playStart(b) - this.playStart(a) || a.created - b.created)[0]
  }

  private eligible(group: Group): boolean {
    return [...group.members].some(member => member.ref.eligible || member.ref.key === this.manual)
  }

  /** Direct player state outranks a server report. */
  private priority(group: Group): number {
    return Math.max(...[...group.members].map(member => member.ref.reach === 'direct' ? 2 : 1))
  }

  private playStart(group: Group): number {
    return this.playbackMember(group)?.playStart ?? -Infinity
  }

  /** A group with Jellyfin links waits for library identity, at most `settleMs` after it formed. */
  private ready(group: Group): boolean {
    if (!this.playbackMember(group))
      return false
    const linked = [...group.members].some(member => member.ref.links.some(link => link.startsWith('jf-')))
    const identified = [...group.members].some(member => member.video?.media.title?.source === 'metadata')
    return !linked || identified || this.options.now() >= group.created + this.settleMs
  }

  /** The member whose video gives playback: a direct player first, then the current one, then the newest read. */
  private playbackMember(group: Group): Player | undefined {
    let best: Player | undefined
    for (const member of group.members) {
      if (!member.video)
        continue
      if (!best) {
        best = member
        continue
      }
      const rank = (player: Player) => player.ref.reach === 'direct' ? 2 : 1
      if (rank(member) > rank(best)
        || (rank(member) === rank(best) && (member === group.playback?.player || (best !== group.playback?.player && (member.lanes.video?.observed_at ?? 0) > (best.lanes.video?.observed_at ?? 0))))) {
        best = member
      }
    }
    return best
  }

  /** The server member that knows the library item, when one exists. */
  private serverMember(group: Group): Player | undefined {
    return [...group.members].find(member => member.ref.reach === 'server' && member.video?.jellyfin?.item)
  }

  private start(group: Group, out: ManagerOutput[]): void {
    group.started = true
    group.session = this.nextSession++
    group.sequence = 0
    group.timeline = 0
    group.last = {}
    group.playback = undefined
    group.dialogue = undefined
    group.directSubtitles = undefined
    group.media = undefined
    group.holdUntil = undefined
    group.identityKey = undefined
    out.push({ kind: 'start', key: group.key, session: group.session })
    this.emitVideo(group, out)
  }

  private stop(group: Group, reason: GroupEndReason, out: ManagerOutput[]): void {
    if (group.started)
      out.push({ kind: 'end', key: group.key, reason })
    group.started = false
    group.session = undefined
  }

  private dissolve(group: Group, reason: GroupEndReason, out: ManagerOutput[]): void {
    this.stop(group, reason, out)
    for (const member of group.members)
      member.group = undefined
    group.members.clear()
    this.groups.delete(group.key)
    if (this.activeKey === group.key)
      this.activeKey = undefined
  }

  private drop(player: Player, reason: PlayerEndReason, out: ManagerOutput[]): void {
    const group = player.group
    this.forget(player)
    if (!group)
      return
    group.members.delete(player)
    if (group.dialogue === player)
      group.dialogue = undefined
    if (group.members.size === 0 || !this.eligible(group))
      this.dissolve(group, reason, out)
  }

  private forget(player: Player): void {
    this.known.delete(player.ref.key)
    player.group = undefined
    this.retired.set(player.ref.key, player.session)
    if (this.retired.size > MAX_RETIRED)
      this.retired.delete(this.retired.keys().next().value!)
    if (this.manual === player.ref.key)
      this.manual = undefined
  }

  private evict(): void {
    if (this.known.size <= MAX_PLAYERS)
      return
    const oldest = [...this.known.values()].filter(player => player.group?.key !== this.activeKey).sort((a, b) => a.lastSeen - b.lastSeen)[0]
    if (oldest)
      this.drop(oldest, 'stale', [])
  }

  /**
   * Sends the composed video of the group. `trigger` is the member whose video arrived. A video of a member that does
   * not give playback goes out only when it changes the identity, for example when library metadata arrives.
   */
  private emitVideo(group: Group, out: ManagerOutput[], trigger?: Player): void {
    const playback = this.playbackMember(group)
    if (!playback?.video)
      return
    const media = this.mediaOf(group, playback)
    if (!media)
      return
    const previous = group.playback
    const switched = !previous || previous.player !== playback || previous.session !== playback.session
    const advanced = !switched && playback.timeline > previous.timeline
    const identityKey = JSON.stringify([media.id, media.title?.value, media.episode?.value, media.season?.value])
    if (trigger && trigger !== playback && !switched && identityKey === group.identityKey)
      return
    if (previous && (switched || advanced))
      group.timeline++
    group.playback = { player: playback, session: playback.session, timeline: playback.timeline, media: playback.video.media.id }
    group.identityKey = identityKey
    this.pushVideo(group, playback, media, out)
  }

  private pushVideo(group: Group, playback: Player, media: MediaIdentity, out: ManagerOutput[]): void {
    const video = playback.video!
    const server = this.serverMember(group)
    const captions = video.captions && video.captions.form !== 'unknown' ? video.captions : server?.video?.captions ?? video.captions
    const jellyfin: JellyfinRef | undefined = media.site === 'jellyfin'
      ? { device: video.jellyfin?.device ?? server?.video?.jellyfin?.device, item: group.media?.server ?? video.jellyfin?.item, media_source: server?.video?.jellyfin?.media_source, subtitle_stream: server?.video?.jellyfin?.subtitle_stream }
      : undefined
    const update: VideoUpdate = {
      ...structuredClone(video),
      media,
      stamp: this.stamp(group, 'video', video.stamp.observed_at),
      ...(captions ? { captions: structuredClone(captions) } : {}),
      ...(jellyfin ? { jellyfin } : {}),
    }
    out.push({ kind: 'update', key: group.key, update })
  }

  /**
   * Composes identity. The media id stays pinned while the playback member and the server item stay the same, so
   * metadata that arrives late enriches the watch instead of restarting it. Returns `undefined` while the group waits
   * for the server to report the new item after the player changed media.
   */
  private mediaOf(group: Group, playback: Player): MediaIdentity | undefined {
    const now = this.options.now()
    const server = this.serverMember(group)
    const serverItem = server?.video?.jellyfin?.item
    const playbackMedia = playback.video!.media.id
    const playbackChanged = group.playback?.player === playback && group.playback.media !== playbackMedia
    const serverChanged = group.media?.server !== undefined && serverItem !== undefined && serverItem !== group.media.server
    if (playbackChanged && server && !serverChanged && group.holdUntil === undefined) {
      group.holdUntil = now + this.settleMs
      group.playback!.media = playbackMedia
    }
    if (group.holdUntil !== undefined) {
      if (!serverChanged && now < group.holdUntil)
        return undefined
      group.holdUntil = undefined
    }
    if (!group.media || playbackChanged || serverChanged) {
      const item = serverItem ?? playback.video!.jellyfin?.item ?? [...group.members].map(member => member.video?.jellyfin?.item).find(Boolean)
      group.media = item ? { id: `jellyfin:${item}`, server: serverItem } : { id: playbackMedia }
    }
    const videos = [...group.members].flatMap(member => member.video ? [member.video.media] : [])
    const base = playback.video!.media
    const site = group.media.id.startsWith('jellyfin:') ? 'jellyfin' : base.site
    const title = bestEvidence(videos.map(media => media.title))
    const episode = bestEvidence(videos.map(media => media.episode))
    const season = bestEvidence(videos.map(media => media.season))
    return {
      id: group.media.id,
      site,
      ...(playback.ref.kind !== 'browser' ? { player: playback.ref.kind } : {}),
      ...(title ? { title: { ...title } } : {}),
      ...(episode ? { episode: { ...episode } } : {}),
      ...(season ? { season: { ...season } } : {}),
    }
  }

  /**
   * Forwards one subtitle. A direct player's subtitle passes when it is the playback member of the current timeline.
   * A server cue passes only while no direct subtitle flows in this timeline. Switching from server cues to a direct
   * player starts a new timeline, so cue timing and gaps from the server never mix with exact ones.
   */
  private emitSubtitle(group: Group, player: Player, update: SubtitleUpdate, out: ManagerOutput[]): void {
    const playback = this.playbackMember(group)
    if (!playback || !group.playback || !group.media || group.holdUntil !== undefined)
      return
    if (player.ref.reach === 'direct') {
      if (player !== playback || player.session !== group.playback.session || update.stamp.timeline !== group.playback.timeline)
        return
      if (group.dialogue && group.dialogue !== player) {
        group.timeline++
        const media = this.mediaOf(group, playback)
        if (!media)
          return
        this.pushVideo(group, playback, media, out)
      }
      group.dialogue = player
      group.directSubtitles = group.timeline
    }
    else {
      if (player.video || update.stamp.timeline !== group.timeline || group.directSubtitles === group.timeline)
        return
      if (playback.ref.reach === 'direct' && playback.video?.captions?.form === 'text')
        return
      group.dialogue = player
    }
    out.push({ kind: 'update', key: group.key, update: { ...update, media_id: group.media.id, stamp: this.stamp(group, 'subtitle', update.stamp.observed_at) } })
  }

  /** Read times never go back inside a group, so a switch to a source with an older read cannot fail WatchState order checks. */
  private stamp(group: Group, lane: 'video' | 'subtitle', observed_at: number): BrowserStamp {
    const at = Math.max(observed_at, group.last[lane] ?? -Infinity)
    group.last[lane] = at
    return { session: group.session!, sequence: ++group.sequence, observed_at: at, timeline: group.timeline }
  }

  private positionOf(group: Group): number | undefined {
    const playback = this.playbackMember(group)
    return playback ? this.extrapolate(playback) : undefined
  }

  /** Media time now, from the newest position read and the playback rate. */
  private extrapolate(player: Player): number | undefined {
    const video = player.video
    if (!video || video.position === undefined)
      return undefined
    const elapsed = video.playing === true ? (this.options.now() - video.stamp.observed_at) / 1000 * (video.rate && video.rate > 0 ? video.rate : 1) : 0
    return video.position + elapsed
  }
}
