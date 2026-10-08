import type { ObservationStamp, VideoSite } from './types'

import { nanoid } from 'nanoid'

import { extractVideoId } from './sites'

/**
 * Orders the video and subtitle observations of one content observer.
 *
 * The stream lives as long as the page. Its sequence counts every sent observation, video and subtitle alike.
 * Its timeline marks one continuous playback: a seek, another media identity, or another video element starts a new
 * timeline, so a consumer can drop evidence from before the change. Callers stamp an observation when they read the
 * page, before the asynchronous message to the background.
 */
export class ObservationStamper {
  readonly stream = nanoid()
  private sequence = 0
  private timeline = 0
  private media?: string

  constructor(private readonly now: () => number = Date.now) {}

  /** Starts a new timeline. Call it after a seek and after another video element took over. */
  restartTimeline(): void {
    this.timeline++
  }

  /**
   * Stamps one observation of the media at `url`. A changed media identity starts a new timeline first.
   * `media` names the media when the URL does not, for example on Jellyfin Web, where every episode plays at one URL.
   */
  stamp(site: VideoSite, url: string, media = mediaKey(site, url)): ObservationStamp {
    if (this.media !== undefined && media !== this.media)
      this.timeline++
    this.media = media
    this.sequence++
    return { stream: this.stream, sequence: this.sequence, observedAt: this.now(), timeline: this.timeline }
  }
}

/**
 * Identity of the playing media. Playback time and tracking parameters are not part of it.
 *
 * @example
 * mediaKey('youtube', 'https://www.youtube.com/watch?v=abc&t=42')
 * // => 'youtube:abc:'
 */
function mediaKey(site: VideoSite, url: string): string {
  try {
    const parsed = new URL(url)
    if (site === 'unknown')
      return `unknown:${parsed.host}${parsed.pathname}`
    // Bilibili keeps the episode part of a multi-part video in `p`.
    return `${site}:${extractVideoId(site, url) ?? parsed.pathname}:${parsed.searchParams.get('p') ?? ''}`
  }
  catch {
    return `${site}:${url}`
  }
}
