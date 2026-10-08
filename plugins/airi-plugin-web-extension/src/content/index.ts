import type { BackgroundToContentMessage, ContentToBackgroundMessage, ExtensionSettings, ObservationStamp, PageContextPayload, SubtitlePayload, VideoContextPayload, VideoSite, VisionFramePayload } from '../shared/types'

import { STORAGE_KEY } from '../shared/constants'
import { allowedJellyfinOrigin, deviceIdOf, itemIdFromStream, videoIdOf } from '../shared/jellyfin'
import { ObservationStamper } from '../shared/observation-stamp'
import { detectSiteFromUrl, extractVideoId, normalizeText } from '../shared/sites'

const VIDEO_PROGRESS_INTERVAL = 15000
const TITLE_POLL_INTERVAL = 2000
const SUBTITLE_DEDUPE_WINDOW = 2000
/** jellyfin-web keeps its device id under this localStorage key. The Core matches it with the server session. */
const JELLYFIN_DEVICE_KEY = '_deviceId2'

const lastPayloadByType = new Map<string, string>()
/** One stream per playback. A removed media element ends the stream, and the next playback gets a new one. */
let stamper = new ObservationStamper()

/** A message as built from the page. {@link safeSend} adds the stamp of video and subtitle messages. */
type UnstampedMessage<M = ContentToBackgroundMessage> = M extends { stamp: ObservationStamp } ? Omit<M, 'stamp'> : M

/**
 * The media name of the stamp. On Jellyfin Web every episode plays at one page URL, so the video id names the media.
 * Other sites name the media by URL.
 */
function mediaOf(payload: { site: VideoSite, videoId?: string }): string | undefined {
  return payload.site === 'jellyfin' && payload.videoId ? `jellyfin:${payload.videoId}` : undefined
}

/**
 * Sends one message unless its payload equals the last payload of its type.
 * `force` sends an equal payload too. The progress tick uses it, so a paused video still reports a fresh observation.
 */
function safeSend(message: UnstampedMessage, force = false) {
  const serialized = JSON.stringify(message.payload)
  const lastSerialized = lastPayloadByType.get(message.type)
  if (!force && serialized === lastSerialized)
    return

  lastPayloadByType.set(message.type, serialized)
  let stamped: ContentToBackgroundMessage
  if (message.type === 'content:video')
    stamped = { ...message, stamp: stamper.stamp(message.payload.site, message.payload.url, mediaOf(message.payload)) }
  else if (message.type === 'content:subtitle')
    stamped = { ...message, stamp: stamper.stamp(message.payload.site, message.payload.url, mediaOf(message.payload)) }
  else
    stamped = message
  void browser.runtime.sendMessage(stamped).catch(() => {})
}

/**
 * Page URL that leaves the page. On Jellyfin Web only the origin and path go out: the hash route can hold ids that
 * the Core does not need.
 */
function pageUrl(site: VideoSite): string {
  return site === 'jellyfin' ? `${location.origin}${location.pathname}` : location.href
}

function buildPageContext(site: VideoSite): PageContextPayload {
  const description = normalizeText(document.querySelector('meta[name="description"]')?.getAttribute('content'))
  const ogDescription = normalizeText(document.querySelector('meta[property="og:description"]')?.getAttribute('content'))

  return {
    site,
    url: pageUrl(site),
    title: normalizeText(document.title),
    description: description || ogDescription || undefined,
    language: document.documentElement.lang || undefined,
  }
}

/** The web client's device id. It identifies this browser's Jellyfin session. Stored credentials are never read. */
function jellyfinDeviceId(): string | undefined {
  try {
    return deviceIdOf(localStorage.getItem(JELLYFIN_DEVICE_KEY))
  }
  catch {
    return undefined
  }
}

/**
 * The title of what Jellyfin Web plays. The Media Session API is the stable seam when the web client fills it. The
 * player page also names the item in the document title. Other pages carry the server name there, so the document
 * title counts only while the player element exists. AIRI's Core prefers the server's library identity anyway.
 */
function jellyfinTitle(): string {
  const metadata = navigator.mediaSession?.metadata
  const title = normalizeText(metadata?.title || metadata?.artist || metadata?.album || '')
  if (title)
    return title
  return document.querySelector('video.htmlvideoplayer') ? normalizeText(document.title) : ''
}

function buildVideoContext(site: VideoSite, video: HTMLVideoElement, includeProgress = false): VideoContextPayload {
  const title = normalizeText(findVideoTitle(site))
  const channel = normalizeText(findChannelName(site))
  const url = pageUrl(site)
  const itemId = site === 'jellyfin' ? itemIdFromStream(video.currentSrc) : undefined
  const videoId = site === 'jellyfin' ? videoIdOf(itemId, title) : extractVideoId(site, url)
  const durationSec = Number.isFinite(video.duration) ? Math.floor(video.duration) : undefined
  const currentTimeSec = includeProgress && Number.isFinite(video.currentTime) ? Math.floor(video.currentTime) : undefined
  const rect = video.getBoundingClientRect()
  const deviceId = site === 'jellyfin' ? jellyfinDeviceId() : undefined

  return {
    site,
    url,
    title: title || normalizeText(document.title),
    channel: channel || undefined,
    videoId,
    durationSec,
    currentTimeSec,
    isPlaying: !video.paused && !video.ended,
    isEnded: video.ended,
    isMuted: video.muted,
    volume: Number.isFinite(video.volume) ? Number(video.volume.toFixed(2)) : undefined,
    playbackRate: Number.isFinite(video.playbackRate) ? Number(video.playbackRate.toFixed(2)) : undefined,
    playerSize: rect.width && rect.height ? { width: Math.round(rect.width), height: Math.round(rect.height) } : undefined,
    ...(deviceId || itemId ? { jellyfin: { ...(deviceId ? { deviceId } : {}), ...(itemId ? { itemId } : {}) } } : {}),
  }
}

function findVideoTitle(site: VideoSite) {
  if (site === 'youtube') {
    return (
      document.querySelector('ytd-watch-metadata h1 yt-formatted-string')?.textContent
      || document.querySelector('h1.title yt-formatted-string')?.textContent
      || document.querySelector('h1.title')?.textContent
    )
  }

  if (site === 'bilibili') {
    return (
      document.querySelector('h1.video-title')?.textContent
      || document.querySelector('.video-title')?.textContent
      || document.querySelector('h1')?.textContent
    )
  }

  if (site === 'jellyfin')
    return jellyfinTitle()

  return document.querySelector('h1')?.textContent
}

function findChannelName(site: VideoSite) {
  if (site === 'youtube') {
    return (
      document.querySelector('#channel-name a')?.textContent
      || document.querySelector('ytd-channel-name a')?.textContent
      || document.querySelector('ytd-channel-name')?.textContent
    )
  }

  if (site === 'bilibili') {
    return (
      document.querySelector('.up-name')?.textContent
      || document.querySelector('.username')?.textContent
      || document.querySelector('.up-info .name')?.textContent
    )
  }

  return undefined
}

/** Keeps the line breaks of multi-line captions. Spaces inside a line collapse. */
function captionText(value: string): string {
  return value.replace(/\r\n?/g, '\n').split('\n').map(line => normalizeText(line)).filter(Boolean).join('\n')
}

function observeTextTracks(site: VideoSite, video: HTMLVideoElement, onSubtitle: (payload: SubtitlePayload) => void) {
  const seen = new Map<string, number>()
  // Jellyfin Web switches its own track between `showing` and `disabled`. Only the track it shows is the user's choice.
  const shownOnly = site === 'jellyfin'

  const handleCueChange = (track: TextTrack) => {
    if (shownOnly && track.mode !== 'showing')
      return
    const cues = Array.from(track.activeCues ?? []) as TextTrackCue[]
    for (const cue of cues) {
      const text = shownOnly ? captionText((cue as VTTCue).text ?? '') : normalizeText((cue as VTTCue).text ?? '')
      if (!text)
        continue

      const key = `${text}:${Math.floor(cue.startTime * 1000)}`
      const now = Date.now()
      const lastSeen = seen.get(key)
      if (lastSeen && now - lastSeen < SUBTITLE_DEDUPE_WINDOW)
        continue

      seen.set(key, now)
      onSubtitle({
        site,
        url: pageUrl(site),
        title: normalizeText(findVideoTitle(site)) || undefined,
        videoId: site === 'jellyfin' ? videoIdOf(itemIdFromStream(video.currentSrc), normalizeText(findVideoTitle(site))) : extractVideoId(site, location.href),
        text,
        // Jellyfin names its track `manualTrack`, so only a real language code counts there.
        language: track.language && track.language !== 'und' ? track.language : shownOnly ? undefined : track.label || undefined,
        startMs: Math.floor(cue.startTime * 1000),
        endMs: Math.floor(cue.endTime * 1000),
      })
    }
  }

  const attach = () => {
    const tracks = Array.from(video.textTracks ?? [])
    for (const track of tracks) {
      if (track.kind && !['subtitles', 'captions'].includes(track.kind))
        continue

      // Other sites hide their native tracks behind their own overlay, so a disabled track is read in hidden mode.
      // Jellyfin's track modes are never changed.
      if (!shownOnly && track.mode === 'disabled')
        track.mode = 'hidden'
      track.oncuechange = () => handleCueChange(track)
    }
  }

  attach()

  const observer = new MutationObserver(() => attach())
  observer.observe(video, { attributes: true, childList: true, subtree: true })
  video.textTracks?.addEventListener?.('addtrack', attach)

  return () => {
    observer.disconnect()
    video.textTracks?.removeEventListener?.('addtrack', attach)
  }
}

/**
 * Jellyfin Web's own text caption element. It hides the element with the `hide` class between cues and keeps the old
 * text inside, so a hidden element counts as no caption.
 */
function jellyfinCaption(selector: string): string {
  const node = document.querySelector<HTMLElement>(selector)
  if (!node || node.classList.contains('hide'))
    return ''
  return captionText(textWithBreaks(node))
}

/** Caption text with its line breaks: Jellyfin Web writes multi-line cues with `<br>` elements. */
function textWithBreaks(node: Node): string {
  let text = ''
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE)
      text += child.textContent ?? ''
    else if (child.nodeName === 'BR')
      text += '\n'
    else
      text += textWithBreaks(child)
  }
  return text
}

function observeSubtitleDom(site: VideoSite, onSubtitle: (payload: SubtitlePayload) => void) {
  let selector = ''
  if (site === 'youtube')
    selector = '.caption-window .caption-window-text, .ytp-caption-segment'
  if (site === 'bilibili')
    selector = '.bpx-player-subtitle-panel-text, .bpx-player-subtitle-text'

  if (!selector && site !== 'jellyfin')
    return () => {}

  let lastText = ''

  const read = () => {
    const title = normalizeText(findVideoTitle(site)) || undefined
    const video = site === 'jellyfin' ? document.querySelector<HTMLVideoElement>('video.htmlvideoplayer') ?? document.querySelector('video') : null
    const videoId = site === 'jellyfin' ? videoIdOf(video ? itemIdFromStream(video.currentSrc) : undefined, title ?? '') : extractVideoId(site, location.href)
    let text: string
    let secondary: string | undefined
    if (site === 'jellyfin') {
      text = jellyfinCaption('.videoSubtitlesInner')
      secondary = jellyfinCaption('.videoSecondarySubtitlesInner') || undefined
    }
    else {
      const nodes = Array.from(document.querySelectorAll(selector))
      text = normalizeText(nodes.map(node => node.textContent).join(' '))
    }
    const key = `${text}\n${secondary ?? ''}`
    if (key === lastText)
      return

    lastText = key
    // An overlay caption has no cue end. Its disappearance only says that no caption shows now.
    if (!text) {
      onSubtitle({ site, url: pageUrl(site), title, videoId, text: '', cleared: true })
      return
    }
    onSubtitle({ site, url: pageUrl(site), title, videoId, text, ...(secondary ? { secondary: { text: secondary } } : {}) })
  }

  const observer = new MutationObserver(read)
  observer.observe(document.documentElement, { childList: true, subtree: true, ...(site === 'jellyfin' ? { attributes: true, attributeFilter: ['class'], characterData: true } : {}) })

  const interval = window.setInterval(read, 1200)

  return () => {
    observer.disconnect()
    window.clearInterval(interval)
  }
}

function captureVisionFrame(site: VideoSite, video: HTMLVideoElement): VisionFramePayload | null {
  const canvas = document.createElement('canvas')
  const width = Math.min(480, Math.max(1, Math.floor(video.videoWidth)))
  const height = Math.min(270, Math.max(1, Math.floor(video.videoHeight)))

  if (!width || !height)
    return null

  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx)
    return null

  try {
    ctx.drawImage(video, 0, 0, width, height)
    return {
      site,
      url: pageUrl(site),
      videoId: extractVideoId(site, location.href),
      title: normalizeText(findVideoTitle(site)) || undefined,
      capturedAt: Date.now(),
      width,
      height,
      dataUrl: canvas.toDataURL('image/jpeg', 0.6),
    }
  }
  catch {
    return null
  }
}

/** The page's player element. Jellyfin Web marks its own player, so a preview or trailer element is not taken. */
function findVideo(site: VideoSite): HTMLVideoElement | null {
  if (site === 'jellyfin')
    return document.querySelector<HTMLVideoElement>('video.htmlvideoplayer') ?? document.querySelector('video')
  return document.querySelector('video')
}

function observeVideo(site: VideoSite) {
  let video: HTMLVideoElement | null = null
  let stopTracks: (() => void) | null = null
  let stopDomSubtitles: (() => void) | null = null
  let listenersAttached = false

  let lastVideo: VideoContextPayload | undefined

  const sendVideo = (includeProgress: boolean, force = false) => {
    if (!video)
      return

    lastVideo = buildVideoContext(site, video, includeProgress)
    safeSend({ type: 'content:video', payload: lastVideo }, force)
  }

  const sendPage = () => {
    safeSend({ type: 'content:page', payload: buildPageContext(site) })
  }

  const onPlayback = () => sendVideo(true)

  // A seek starts a new timeline at once, so captions and gaps from before the jump cannot pass as current.
  const onSeeked = () => {
    stamper.restartTimeline()
    sendVideo(true, true)
  }

  const mediaListeners: Array<[keyof HTMLMediaElementEventMap, () => void]> = [
    ['play', onPlayback],
    ['pause', onPlayback],
    ['loadedmetadata', onPlayback],
    ['ended', onPlayback],
    ['seeked', onSeeked],
    ['ratechange', onPlayback],
  ]

  const detachListeners = () => {
    if (!video || !listenersAttached)
      return

    for (const [type, listener] of mediaListeners)
      video.removeEventListener(type, listener)
    listenersAttached = false
  }

  // The page removed the player, for example when Jellyfin Web stops playback. That playback ends here. It is not a
  // natural end, so `isEnded` stays as the element reported it.
  const stopped = () => {
    detachListeners()
    stopTracks?.()
    stopDomSubtitles?.()
    stopTracks = null
    stopDomSubtitles = null
    video = null
    if (lastVideo)
      safeSend({ type: 'content:video', payload: { ...lastVideo, isPlaying: false, isStopped: true } }, true)
    lastVideo = undefined
    stamper = new ObservationStamper()
    lastPayloadByType.delete('content:video')
    lastPayloadByType.delete('content:subtitle')
  }

  const attach = () => {
    if (video && !video.isConnected)
      stopped()
    const found = findVideo(site)
    if (!found || found === video)
      return

    detachListeners()
    // Another element plays other media, or the same media from another position.
    if (video)
      stamper.restartTimeline()

    video = found
    stopTracks?.()
    stopDomSubtitles?.()

    stopTracks = observeTextTracks(site, video, payload => safeSend({ type: 'content:subtitle', payload }))
    stopDomSubtitles = observeSubtitleDom(site, payload => safeSend({ type: 'content:subtitle', payload }))

    sendPage()
    sendVideo(false)
  }

  const interval = window.setInterval(attach, 1000)

  const progressInterval = window.setInterval(() => {
    if (!video)
      return
    sendVideo(true, true)
  }, VIDEO_PROGRESS_INTERVAL)

  const titleInterval = window.setInterval(() => {
    sendPage()
    sendVideo(false)
  }, TITLE_POLL_INTERVAL)

  const cleanup = () => {
    window.clearInterval(interval)
    window.clearInterval(progressInterval)
    window.clearInterval(titleInterval)
    detachListeners()
    stopTracks?.()
    stopDomSubtitles?.()
  }

  const attachListeners = () => {
    if (!video)
      return
    if (listenersAttached)
      return

    for (const [type, listener] of mediaListeners)
      video.addEventListener(type, listener)
    listenersAttached = true
  }

  const observer = new MutationObserver(() => {
    attach()
    attachListeners()
  })

  observer.observe(document.documentElement, { childList: true, subtree: true })

  attach()
  attachListeners()

  return () => {
    cleanup()
    observer.disconnect()
  }
}

/**
 * The site of this page. Jellyfin needs both the user's permission for this origin in the popup and the page's own
 * Jellyfin marker, so no other site on an allowed origin and no unallowed Jellyfin server switches to Jellyfin mode.
 */
function siteOf(origins: readonly string[]): VideoSite {
  if (allowedJellyfinOrigin(location.href, origins) && document.querySelector('meta[name="application-name"][content="Jellyfin"]'))
    return 'jellyfin'
  return detectSiteFromUrl(location.href)
}

async function jellyfinOrigins(): Promise<string[]> {
  try {
    const stored = await browser.storage.local.get(STORAGE_KEY)
    const origins = (stored[STORAGE_KEY] as Partial<ExtensionSettings> | undefined)?.jellyfinOrigins
    return Array.isArray(origins) ? origins.filter(origin => typeof origin === 'string') : []
  }
  catch {
    return []
  }
}

export function startContentObserver() {
  let site: VideoSite | undefined
  let stopVideo: (() => void) | undefined

  // Restarts the observer when the user allows or removes this origin as Jellyfin while the page is open.
  const begin = (origins: readonly string[]) => {
    const next = siteOf(origins)
    if (next === site)
      return
    stopVideo?.()
    site = next
    safeSend({ type: 'content:page', payload: buildPageContext(site) })
    stopVideo = observeVideo(site)
  }

  void jellyfinOrigins().then(begin)
  browser.storage.onChanged.addListener((changes) => {
    if (changes[STORAGE_KEY])
      void jellyfinOrigins().then(begin)
  })

  browser.runtime.onMessage.addListener((message: BackgroundToContentMessage) => {
    if (message.type === 'background:request-vision-frame' && site) {
      const video = findVideo(site)
      if (!video)
        return

      const frame = captureVisionFrame(site, video)
      if (frame)
        safeSend({ type: 'content:vision:frame', payload: frame })
    }
  })

  return () => {
    stopVideo?.()
  }
}
