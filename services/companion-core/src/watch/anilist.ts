/** Explicit completed progress is separate from a guessed episode label on screen. */
export interface WatchProgress {
  anilist_id: number
  completed_episode?: number
}

export interface AniListMetadata {
  source: 'anilist'
  id: number
  title: { english?: string, romaji?: string, native?: string }
  episodes?: number
  duration_minutes?: number
  observed_at: number
  valid_until: number
}

export interface ProgressContext {
  kind: 'synopsis' | 'background' | 'character' | 'episode'
  text: string
  /** A trusted curator verifies the entire text through this completed episode. Provider claims alone are insufficient. */
  verified_through_episode: number
}

/** General AniList fields have no episode safety annotation. Only externally verified scoped context can pass this boundary. */
export function contextWithinProgress(input: { anilist_id: number, entries: readonly ProgressContext[] }, progress: WatchProgress): ProgressContext[] {
  if (input.anilist_id !== progress.anilist_id || !Number.isSafeInteger(progress.completed_episode) || !progress.completed_episode || progress.completed_episode < 1)
    return []
  return input.entries.filter(entry => ['synopsis', 'background', 'character', 'episode'].includes(entry.kind)
    && Number.isSafeInteger(entry.verified_through_episode) && entry.verified_through_episode >= 1
    && entry.verified_through_episode <= progress.completed_episode! && typeof entry.text === 'string')
    .slice(0, 8)
    .map(entry => ({ kind: entry.kind, text: entry.text.replace(/\p{Cc}/gu, ' ').slice(0, 320), verified_through_episode: entry.verified_through_episode }))
}

/**
 * Optional identity-only public AniList adapter. The host supplies a confirmed AniList ID.
 * The query never requests descriptions, characters, relations, tags, reviews or future episode events.
 * No cache, database, metadata logger or search-based identity inference exists here.
 */
export class AniListAdapter {
  constructor(private readonly options: { enabled?: boolean, now: () => number, transport?: typeof fetch }) {}

  async lookup(id: number, signal: AbortSignal): Promise<AniListMetadata | undefined> {
    if (!this.options.enabled || !Number.isSafeInteger(id) || id < 1 || signal.aborted)
      return undefined
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(abort, 5000)
    try {
      const response = await (this.options.transport ?? fetch)('https://graphql.anilist.co', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({ query: 'query ($id: Int!) { Media(id: $id, type: ANIME) { id title { english romaji native } episodes duration } }', variables: { id } }),
      })
      if (controller.signal.aborted || !response.ok || !response.body) {
        await response.body?.cancel()
        return undefined
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let body = ''
      let size = 0
      const cancelRead = () => {
        void reader.cancel().catch(() => {})
      }
      controller.signal.addEventListener('abort', cancelRead, { once: true })
      try {
        while (true) {
          controller.signal.throwIfAborted()
          const { done, value } = await reader.read()
          if (done)
            break
          size += value.byteLength
          if (size > 16384) {
            await reader.cancel()
            return undefined
          }
          body += decoder.decode(value, { stream: true })
        }
        body += decoder.decode()
      }
      finally {
        controller.signal.removeEventListener('abort', cancelRead)
        reader.releaseLock()
      }
      if (controller.signal.aborted)
        return undefined
      const payload: unknown = JSON.parse(body)
      if (!payload || typeof payload !== 'object' || !('data' in payload) || !payload.data || typeof payload.data !== 'object' || !('Media' in payload.data))
        return undefined
      const media = payload.data.Media
      if (!media || typeof media !== 'object' || !('id' in media) || media.id !== id || !('title' in media) || !media.title || typeof media.title !== 'object')
        return undefined
      const title: AniListMetadata['title'] = {}
      const titles = media.title as Record<string, unknown>
      for (const name of ['english', 'romaji', 'native'] as const) {
        const value = titles[name]
        if (typeof value === 'string' && value.length <= 160)
          title[name] = value
      }
      const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < 100000 ? value : undefined
      const at = this.options.now()
      return { source: 'anilist', id, title, episodes: integer('episodes' in media ? media.episodes : undefined), duration_minutes: integer('duration' in media ? media.duration : undefined), observed_at: at, valid_until: at + 300000 }
    }
    catch { return undefined }
    finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
    }
  }
}
