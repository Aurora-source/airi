/** `jellyfin` is a Jellyfin Web origin that the user allowed in the popup. It never comes from a host name guess. */
export type VideoSite = 'youtube' | 'bilibili' | 'jellyfin' | 'unknown'

/**
 * Jellyfin ids of the page's playback. AIRI's Core matches them with the server session of the same device.
 * They are ids only, never URLs or credentials.
 */
export interface JellyfinPagePayload {
  /** The web client's device id from `localStorage._deviceId2`, the same value as the server session `DeviceId`. */
  deviceId?: string
  /** Library item id from the stream path of `video.currentSrc`, when the stream is not a blob. */
  itemId?: string
}

export interface PageContextPayload {
  site: VideoSite
  url: string
  title: string
  description?: string
  language?: string
}

export interface VideoContextPayload {
  site: VideoSite
  url: string
  title: string
  channel?: string
  videoId?: string
  durationSec?: number
  currentTimeSec?: number
  isPlaying?: boolean
  isMuted?: boolean
  volume?: number
  playbackRate?: number
  isLive?: boolean
  /** The media element fired `ended` for the current source. It never comes from a position near the end. */
  isEnded?: boolean
  /**
   * The page removed its media element, so this playback stopped. It never means that the episode finished.
   * The observer starts a new stream for the next playback.
   */
  isStopped?: boolean
  playerSize?: { width: number, height: number }
  jellyfin?: JellyfinPagePayload
}

export interface SubtitlePayload {
  site: VideoSite
  url: string
  videoId?: string
  title?: string
  text: string
  language?: string
  startMs?: number
  endMs?: number
  isAuto?: boolean
  /** A second subtitle shown at the same time, for example the secondary track of Jellyfin Web. */
  secondary?: { text: string, language?: string }
  /**
   * The on-screen caption disappeared, so `text` is empty.
   * It proves nothing about speech: consumers treat dialogue as unknown, never as silence.
   */
  cleared?: boolean
}

/**
 * Ordering of one video or subtitle observation, stamped by the content observer when it reads the page.
 * Consumers use it to reject delayed or replayed observations. Message arrival time is never acquisition time.
 */
export interface ObservationStamp {
  /** Random id of one content observer. Every page load starts another stream. */
  stream: string
  /** Grows by one for each sent video or subtitle observation of the stream. Both kinds share one counter. */
  sequence: number
  /** Wall-clock milliseconds when the observer read the page. */
  observedAt: number
  /** Playback timeline. It grows on a seek, a media change, and a new video element. */
  timeline: number
  /**
   * Browser tab of the observer, added by the background from the message sender.
   * A new stream in the same tab replaces the old one at once, for example after a navigation.
   */
  tab?: number
}

/** The stamp that the background adds to context updates. `connection` changes on every server reconnect. */
export interface ConnectionObservationStamp extends ObservationStamp {
  connection: string
}

export interface VisionFramePayload {
  site: VideoSite
  url: string
  videoId?: string
  title?: string
  capturedAt: number
  width: number
  height: number
  dataUrl: string
}

export type ContentToBackgroundMessage
  = | { type: 'content:page', payload: PageContextPayload }
    | { type: 'content:video', payload: VideoContextPayload, stamp: ObservationStamp }
    | { type: 'content:subtitle', payload: SubtitlePayload, stamp: ObservationStamp }
    | { type: 'content:vision:frame', payload: VisionFramePayload }

export interface ExtensionSettings {
  wsUrl: string
  token: string
  enabled: boolean
  sendPageContext: boolean
  sendVideoContext: boolean
  sendSubtitles: boolean
  sendSparkNotify: boolean
  enableVision: boolean
  /** Origins that the user allowed as Jellyfin Web in the popup, for example `https://media.example.com`. */
  jellyfinOrigins: string[]
}

export interface ExtensionStatus {
  connected: boolean
  lastError?: string
  settings: ExtensionSettings
  lastPage?: PageContextPayload
  lastVideo?: VideoContextPayload
  lastSubtitle?: SubtitlePayload
  lastVisionFrameAt?: number
}

export type BackgroundToContentMessage
  = | { type: 'background:request-vision-frame' }
