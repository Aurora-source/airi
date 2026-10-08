import { describe, expect, it, vi } from 'vitest'

import { AniListAdapter, contextWithinProgress } from '../../src/watch/anilist'

describe('hard spoiler boundary', () => {
  const entries = [
    { kind: 'background' as const, text: 'Background through episode one.', verified_through_episode: 1 },
    { kind: 'character' as const, text: 'A character first introduced in episode four.', verified_through_episode: 4 },
    { kind: 'synopsis' as const, text: 'The future outcome.', verified_through_episode: 10 },
  ]

  it('withholds every spoiler-sensitive entry when progress is unknown', () => {
    expect(contextWithinProgress({ anilist_id: 1, entries }, { anilist_id: 1 })).toEqual([])
    expect(contextWithinProgress({ anilist_id: 1, entries }, { anilist_id: 1, completed_episode: 0 })).toEqual([])
  })

  it('excludes future episodes, future characters and outcomes at known progress', () => {
    const result = contextWithinProgress({ anilist_id: 1, entries }, { anilist_id: 1, completed_episode: 3 })
    expect(result).toEqual([entries[0]])
    expect(JSON.stringify(result)).not.toContain('future')
    expect(JSON.stringify(result)).not.toContain('episode four')
  })

  it('isolates progress by show and rejects invalid episode bounds', () => {
    expect(contextWithinProgress({ anilist_id: 2, entries }, { anilist_id: 1, completed_episode: 20 })).toEqual([])
    expect(contextWithinProgress({ anilist_id: 1, entries: [{ ...entries[0], verified_through_episode: Number.NaN }] }, { anilist_id: 1, completed_episode: 3 })).toEqual([])
  })

  it('whitelists identity fields and never queries general plot or character data', async () => {
    const transport = vi.fn<typeof fetch>(async (_, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string }
      expect(request.query).not.toMatch(/description|character|relation|tag|review/i)
      return Response.json({ data: { Media: { id: 1, title: { english: 'Example', romaji: 'Sample', native: 'サンプル' }, episodes: 12, duration: 24, description: 'Future twist', characters: ['Future character'], relations: ['Sequel'] } } })
    })
    const adapter = new AniListAdapter({ enabled: true, now: () => 1000, transport })
    const result = await adapter.lookup(1, new AbortController().signal)
    expect(result?.title.native).toBe('サンプル')
    expect(result?.valid_until).toBe(301000)
    expect(JSON.stringify(result)).not.toMatch(/Future|Sequel|description|characters/)
  })

  it('is disabled by default and respects cancellation', async () => {
    const transport = vi.fn<typeof fetch>()
    const adapter = new AniListAdapter({ now: () => 1000, transport })
    expect(await adapter.lookup(1, new AbortController().signal)).toBeUndefined()
    expect(transport).not.toHaveBeenCalled()
    const controller = new AbortController()
    controller.abort()
    expect(await new AniListAdapter({ enabled: true, now: () => 1000, transport }).lookup(1, controller.signal)).toBeUndefined()
  })

  it('rejects mismatched identity and provider errors without leaking their contents', async () => {
    const adapter = new AniListAdapter({ enabled: true, now: () => 1000, transport: async () => Response.json({ data: { Media: { id: 2, title: { english: 'Wrong show' } } } }) })
    expect(await adapter.lookup(1, new AbortController().signal)).toBeUndefined()
    const failed = new AniListAdapter({ enabled: true, now: () => 1000, transport: async () => new Response('Future private plot', { status: 429 }) })
    expect(await failed.lookup(1, new AbortController().signal)).toBeUndefined()
  })
})
