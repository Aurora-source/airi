import type { SubtitlePayload, VideoContextPayload } from '../../../../plugins/airi-plugin-web-extension/src/shared/types'
import type { BrowserStamp, BrowserUpdate, Evidence, SubtitleUpdate, VideoUpdate } from './contracts'

function text(input: unknown, limit: number): string {
  return typeof input === 'string' ? input.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : ''
}

function nonnegative(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) && input >= 0 ? input : undefined
}

function identity(payload: Pick<VideoContextPayload, 'site' | 'url' | 'videoId'>): string | undefined {
  try {
    const url = new URL(payload.url)
    if (!['http:', 'https:'].includes(url.protocol))
      return undefined
    // Retain only identity fields. Page query parameters can contain private session data.
    const part = payload.site === 'bilibili' ? url.searchParams.get('p') : null
    const id = text(payload.videoId, 128) || `${url.hostname}${url.pathname}${payload.site === 'youtube' ? `?v=${url.searchParams.get('v') ?? ''}` : ''}`
    return `${payload.site}:${id}${part && /^\d+$/.test(part) ? `:part-${part}` : ''}`.slice(0, 320)
  }
  catch { return undefined }
}

function evidence<T>(value: T, stamp: BrowserStamp, confidence: number): Evidence<T> {
  return { value, source: 'browser', confidence, observed_at: stamp.observed_at, valid_until: stamp.observed_at + 35000 }
}

/** Explicit episode labels are hints. Bare numbers in titles never identify an episode. */
export function episodeFromTitle(title: string): number | undefined {
  const match = /\b(?:episode|ep\.?)[\s:#-]*(\d{1,4})\b|第\s*(\d{1,4})\s*[話集]/i.exec(title)
  const episode = match ? Number(match[1] ?? match[2]) : undefined
  return episode && Number.isSafeInteger(episode) ? episode : undefined
}

/** Reuses the upstream payload contract. No browser name or scraping logic enters R6. */
export function normalizeVideo(payload: VideoContextPayload, stamp: BrowserStamp): VideoUpdate | undefined {
  const id = identity(payload)
  if (!id)
    return undefined
  const title = text(payload.title, 160)
  const episode = episodeFromTitle(title)
  return {
    kind: 'video',
    stamp: { ...stamp },
    media: { id, site: payload.site, title: title ? evidence(title, stamp, 0.9) : undefined, episode: episode ? evidence(episode, stamp, 0.75) : undefined },
    playing: typeof payload.isPlaying === 'boolean' ? payload.isPlaying : undefined,
    position: nonnegative(payload.currentTimeSec),
    duration: nonnegative(payload.durationSec),
    rate: nonnegative(payload.playbackRate),
    ended: payload.isEnded === true ? true : undefined,
  }
}

/**
 * Cue timestamps use media time, not wall time.
 * A browser caption without text is a clear: the overlay disappeared. It never proves a dialogue gap.
 */
export function normalizeSubtitle(payload: SubtitlePayload, stamp: BrowserStamp): SubtitleUpdate | undefined {
  const media_id = identity(payload)
  const start_ms = nonnegative(payload.startMs)
  const end_ms = nonnegative(payload.endMs)
  if (!media_id || (start_ms !== undefined && end_ms !== undefined && end_ms <= start_ms))
    return undefined
  const line = text(payload.text, 320)
  return { kind: 'subtitle', stamp: { ...stamp }, media_id, text: line, title: text(payload.title, 160) || undefined, language: text(payload.language, 16) || undefined, start_ms, end_ms, automatic: payload.isAuto === true, cleared: line ? undefined : true }
}

/** Parses untrusted server lane data. The bridge authenticates the extension and supplies the trusted stamp. */
export function normalizeBrowserLane(input: { lane?: string, text?: string, metadata?: Record<string, unknown> }, stamp: BrowserStamp): BrowserUpdate | undefined {
  const m = input.metadata
  if (!m || m.source !== 'web-extension' || typeof m.url !== 'string' || !['youtube', 'bilibili', 'unknown'].includes(String(m.site)))
    return undefined
  const site = m.site as VideoContextPayload['site']
  const videoId = typeof m.videoId === 'string' ? m.videoId : undefined
  if (input.lane === 'web:video') {
    return normalizeVideo({ site, url: m.url, videoId, title: text(m.title, 160), isPlaying: typeof m.isPlaying === 'boolean' ? m.isPlaying : undefined, currentTimeSec: nonnegative(m.currentTimeSec), durationSec: nonnegative(m.durationSec), playbackRate: nonnegative(m.playbackRate), isEnded: m.isEnded === true }, stamp)
  }
  if (input.lane === 'web:subtitle' && typeof input.text === 'string' && input.text.startsWith('Subtitle: ')) {
    return normalizeSubtitle({ site, url: m.url, videoId, title: text(m.title, 160), text: input.text.slice('Subtitle: '.length), language: text(m.language, 16), startMs: nonnegative(m.startMs), endMs: nonnegative(m.endMs), isAuto: m.isAuto === true }, stamp)
  }
  return undefined
}
