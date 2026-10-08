import { episodeFromTitle } from './browser'

/** Where a player title came from. A file name carries release tags that a tag title does not. */
export type TitleOrigin = 'filename' | 'tags'

/** Show identity read from one player title. Every field is a guess from untrusted text. */
export interface MediaTitle {
  title?: string
  season?: number
  episode?: number
}

const EXTENSION = /\.(?:mkv|mp4|m4v|webm|avi|mov|ts|m2ts|flv|wmv|ogm|ogv)$/i
/** Release tags in brackets: group names, resolution, codecs, checksums. */
const BRACKETS = /\[[^\]]*\]|\([^)]*?(?:\d{3,4}p|bd|web|hevc|x26[45]|flac|aac|dual|multi|\b(?:19|20)\d{2}\b)[^)]*\)/gi
const SEASON_EPISODE = /^(.*?)\bS(\d{1,2})[\s._-]?E(\d{1,4})(?:v\d)?\b/i
/** ` - 05`, ` - 05v2` at the end of the name, after release tags were removed. A range or a fraction is not one episode. */
const DASH_EPISODE = /^(.*\S)\s+-\s+(\d{1,4})(?:v\d)?$/

function clean(input: string): string {
  return input.replace(/\p{Cc}/gu, '').replace(/\s+/g, ' ').trim()
}

function episodeNumber(value: string): number | undefined {
  const episode = Number(value)
  return Number.isSafeInteger(episode) && episode > 0 ? episode : undefined
}

/**
 * Reads a show title, season, and episode from a player title or a file name.
 * Explicit markers only: `S01E13`, a trailing ` - 13`, `Episode 13`, or `第13話`. A bare number never names an episode.
 *
 * @example
 * mediaTitleOf('[SubsPlease] Sousou no Frieren - 13 (1080p) [A1B2C3D4].mkv', 'filename')
 * // => { title: 'Sousou no Frieren', episode: 13 }
 */
export function mediaTitleOf(input: string, origin: TitleOrigin): MediaTitle {
  let name = clean(input)
  if (origin === 'filename') {
    name = name.replace(EXTENSION, '')
    // Scene names separate words with dots or underscores.
    if (!name.includes(' '))
      name = name.replace(/[._]/g, ' ')
    name = clean(name.replace(BRACKETS, ' '))
  }
  if (!name)
    return {}

  const scene = SEASON_EPISODE.exec(name)
  if (scene) {
    const title = clean(scene[1].replace(/[\s.-]+$/, ''))
    const season = episodeNumber(scene[2])
    const episode = episodeNumber(scene[3])
    return { ...(title ? { title: title.slice(0, 160) } : {}), ...(season ? { season } : {}), ...(episode ? { episode } : {}) }
  }

  if (origin === 'filename') {
    const dash = DASH_EPISODE.exec(name)
    if (dash) {
      const episode = episodeNumber(dash[2])
      return { title: dash[1].slice(0, 160), ...(episode ? { episode } : {}) }
    }
    // A batch range or a recap number stays out of the title as well.
    name = clean(name.replace(/\s+-\s+\d{1,4}[-~.]\d{1,4}$/, ''))
  }

  const labelled = episodeFromTitle(name)
  if (labelled) {
    const title = clean(name.replace(/\b(?:episode|ep\.?)[\s:#-]*\d{1,4}\b|第\s*\d{1,4}\s*[話集]/i, ' ').replace(/[\s-]+$/, ''))
    return { ...(title ? { title: title.slice(0, 160) } : {}), episode: labelled }
  }
  return { title: name.slice(0, 160) }
}
