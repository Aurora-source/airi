import type { BrowserUpdate, PlayerKind } from './contracts'

/** A request for the current cue of the selected subtitle stream from the Jellyfin server. */
export interface CueRequest {
  /** Server player whose session named the stream. */
  player: string
  item: string
  media_source: string
  index: number
  /** `exact` when a direct player supplies the clock, `estimated` when only the server position is known. */
  sync: 'exact' | 'estimated'
  /** Watch session of the request. A new session restarts the cue stream. */
  session: number
  /** Group timeline of the request. A cue answered for an older timeline is refused. */
  timeline: number
  /** Language of the selected stream, when the server names it. */
  language?: string
  /**
   * Correlation links of the server session that named the stream. The cue player reports with them, so its cues
   * join the group that asked, also when that session has only a device link.
   */
  links: readonly string[]
  playing: boolean
  /** Media time in seconds, from the newest playback evidence. */
  position: () => number | undefined
}

/** One player that an adapter follows, as the source manager sees it. */
export interface PlayerRef {
  /** Stable while the adapter follows the player, for example `mpv:airi` or `jellyfin:<session>`. */
  key: string
  kind: PlayerKind
  /**
   * - `direct`: the player reported its own state (mpv IPC, VLC HTTP, a page media element).
   * - `server`: a media server repeated what a client reported. It lags and has no exact clock.
   */
  reach: 'direct' | 'server'
  /**
   * The player plays on this machine, or the user configured or selected it. The manager never follows a player
   * that is not eligible on its own, so media on another device or of another user stays out.
   */
  eligible: boolean
  /** Correlation keys of the current media: `jf-device:<id>` and `jf-item:<id>`. Exact ids only, never titles. */
  links: readonly string[]
}

/**
 * One observation of one player. `update.stamp.session` is the adapter's connection to the player and grows on
 * every reconnect. `sequence` grows per observation. `timeline` grows on a seek, a media change, or a subtitle track
 * change. `observed_at` is when the adapter read the player, never when the message arrived.
 */
export interface PlayerObservation {
  player: PlayerRef
  update: BrowserUpdate
}

/** Why a player stopped being followed. */
export type PlayerEndReason
  = | 'replaced'
    | 'navigated'
    | 'producer-reconnected'
    | 'producer-gone'
    | 'channel-lost'
    | 'player-exited'
    | 'stopped'
    | 'disconnected'
    | 'stale'

/** What an adapter reports to the source manager. */
export interface SourceEvents {
  observe: (observation: PlayerObservation) => void
  gone: (player: string, reason: PlayerEndReason) => void
}

/**
 * Ops view of one adapter. It holds states, counts, and error codes, never titles, paths, captions, or credentials.
 */
export interface AdapterStatus {
  adapter: 'jellyfin' | 'mpv' | 'vlc'
  enabled: boolean
  /**
   * - `connected`: the adapter reads its player or server.
   * - `waiting`: nothing to read yet, for example no player runs or the pipe does not exist.
   * - `unauthorized`: the server refused the stored credential.
   * - `error`: the last attempt failed. `error` names the code.
   */
  connection: 'connected' | 'waiting' | 'unauthorized' | 'error'
  /** Time of the last successful read. */
  lastSyncAt?: number
  players: number
  /** Known gaps of this source, for example `no-subtitle-text`. */
  limitations: readonly string[]
  error?: string
  /** Adapter facts that help setup, for example the endpoint name. Never secrets. */
  details?: Record<string, string | number | boolean | undefined>
}

/** A replaceable source of player observations. The Core starts it after the gateway listens. */
export interface MediaSourceAdapter {
  readonly kind: AdapterStatus['adapter']
  start: (events: SourceEvents) => void
  /** Stops polling and closes connections. Pending reads finish without reporting. */
  stop: () => Promise<void>
  status: () => AdapterStatus
  /** Reads at once, because another source saw media that this one can identify. Polling sources implement it. */
  wake?: () => void
  /** Follows the server cue lookup that the active watch session needs, or stops it with `undefined`. */
  followCues?: (request: CueRequest | undefined) => void
}
