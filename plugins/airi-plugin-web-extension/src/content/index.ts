import type { BackgroundToContentMessage, ContentToBackgroundMessage, ObservationStamp, PageContextPayload, SubtitlePayload, VideoContextPayload, VideoSite, VisionFramePayload } from '../shared/types'

import { ObservationStamper } from '../shared/observation-stamp'
import { detectSiteFromUrl, extractVideoId, normalizeText } from '../shared/sites'

const VIDEO_PROGRESS_INTERVAL = 15000
const TITLE_POLL_INTERVAL = 2000
const SUBTITLE_DEDUPE_WINDOW = 2000

const lastPayloadByType = new Map<string, string>()
const stamper = new ObservationStamper()

/** A message as built from the page. {@link safeSend} adds the stamp of video and subtitle messages. */
type UnstampedMessage<M = ContentToBackgroundMessage> = M extends { stamp: ObservationStamp } ? Omit<M, 'stamp'> : M

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
    stamped = { ...message, stamp: stamper.stamp(message.payload.site, message.payload.url) }
  else if (message.type === 'content:subtitle')
    stamped = { ...message, stamp: stamper.stamp(message.payload.site, message.payload.url) }
  else
    stamped = message
  void browser.runtime.sendMessage(stamped).catch(() => {})
}

function buildPageContext(site: VideoSite): PageContextPayload {
  const description = normalizeText(document.querySelector('meta[name="description"]')?.getAttribute('content'))
  const ogDescription = normalizeText(document.querySelector('meta[property="og:description"]')?.getAttribute('content'))

  return {
    site,
    url: location.href,
    title: normalizeText(document.title),
    description: description || ogDescription || undefined,
    language: document.documentElement.lang || undefined,
  }
}

function buildVideoContext(site: VideoSite, video: HTMLVideoElement, includeProgress = false): VideoContextPayload {
  const title = normalizeText(findVideoTitle(site))
  const channel = normalizeText(findChannelName(site))
  const url = location.href
  const videoId = extractVideoId(site, url)
  const durationSec = Number.isFinite(video.duration) ? Math.floor(video.duration) : undefined
  const currentTimeSec = includeProgress && Number.isFinite(video.currentTime) ? Math.floor(video.currentTime) : undefined
  const rect = video.getBoundingClientRect()

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

function observeTextTracks(site: VideoSite, video: HTMLVideoElement, onSubtitle: (payload: SubtitlePayload) => void) {
  const seen = new Map<string, number>()

  const handleCueChange = (track: TextTrack) => {
    const cues = Array.from(track.activeCues ?? []) as TextTrackCue[]
    for (const cue of cues) {
      const text = normalizeText((cue as VTTCue).text ?? '')
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
        url: location.href,
        title: normalizeText(findVideoTitle(site)) || undefined,
        videoId: extractVideoId(site, location.href),
        text,
        language: (track.language || track.label || undefined),
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

      if (track.mode === 'disabled')
        track.mode = 'hidden'
      track.oncuechange = () => handleCueChange(track)
    }
  }

  attach()

  const observer = new MutationObserver(() => attach())
  observer.observe(video, { attributes: true, childList: true, subtree: true })

  return () => observer.disconnect()
}

function observeSubtitleDom(site: VideoSite, onSubtitle: (payload: SubtitlePayload) => void) {
  let selector = ''
  if (site === 'youtube')
    selector = '.caption-window .caption-window-text, .ytp-caption-segment'
  if (site === 'bilibili')
    selector = '.bpx-player-subtitle-panel-text, .bpx-player-subtitle-text'

  if (!selector)
    return () => {}

  let lastText = ''

  const read = () => {
    const nodes = Array.from(document.querySelectorAll(selector))
    const text = normalizeText(nodes.map(node => node.textContent).join(' '))
    if (text === lastText)
      return

    lastText = text
    // An overlay caption has no cue end. Its disappearance only says that no caption shows now.
    if (!text) {
      onSubtitle({
        site,
        url: location.href,
        title: normalizeText(findVideoTitle(site)) || undefined,
        videoId: extractVideoId(site, location.href),
        text: '',
        cleared: true,
      })
      return
    }
    onSubtitle({
      site,
      url: location.href,
      title: normalizeText(findVideoTitle(site)) || undefined,
      videoId: extractVideoId(site, location.href),
      text,
    })
  }

  const observer = new MutationObserver(read)
  observer.observe(document.documentElement, { childList: true, subtree: true })

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
      url: location.href,
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

function observeVideo(site: VideoSite) {
  let video: HTMLVideoElement | null = null
  let stopTracks: (() => void) | null = null
  let stopDomSubtitles: (() => void) | null = null
  let listenersAttached = false

  const sendVideo = (includeProgress: boolean, force = false) => {
    if (!video)
      return

    safeSend({ type: 'content:video', payload: buildVideoContext(site, video, includeProgress) }, force)
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
  ]

  const detachListeners = () => {
    if (!video || !listenersAttached)
      return

    for (const [type, listener] of mediaListeners)
      video.removeEventListener(type, listener)
    listenersAttached = false
  }

  const attach = () => {
    const found = document.querySelector('video') as HTMLVideoElement | null
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

export function startContentObserver() {
  const site = detectSiteFromUrl(location.href)
  safeSend({ type: 'content:page', payload: buildPageContext(site) })
  const stopVideo = observeVideo(site)

  browser.runtime.onMessage.addListener((message: BackgroundToContentMessage) => {
    if (message.type === 'background:request-vision-frame') {
      const video = document.querySelector('video') as HTMLVideoElement | null
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
