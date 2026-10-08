import { describe, expect, it } from 'vitest'

import { mediaTitleOf } from '../../src/watch/media-title'

describe('mediaTitleOf', () => {
  it('reads a fansub release name', () => {
    expect(mediaTitleOf('[SubsPlease] Sousou no Frieren - 13 (1080p) [A1B2C3D4].mkv', 'filename')).toEqual({ title: 'Sousou no Frieren', episode: 13 })
  })

  it('keeps numbers that belong to the series name', () => {
    expect(mediaTitleOf('[Erai-raws] 86 - Eighty Six - 05 [1080p][Multiple Subtitle].mkv', 'filename')).toEqual({ title: '86 - Eighty Six', episode: 5 })
    expect(mediaTitleOf('Mob Psycho 100 - 03.mkv', 'filename')).toEqual({ title: 'Mob Psycho 100', episode: 3 })
  })

  it('reads scene names with a season', () => {
    expect(mediaTitleOf('Frieren.Beyond.Journeys.End.S01E13.1080p.WEB.H264-GROUP.mkv', 'filename')).toEqual({ title: 'Frieren Beyond Journeys End', season: 1, episode: 13 })
    expect(mediaTitleOf('Spy x Family - S02E07 - Something.mp4', 'filename')).toEqual({ title: 'Spy x Family', season: 2, episode: 7 })
  })

  it('reads a revision suffix and an explicit episode word', () => {
    expect(mediaTitleOf('[Group] Bocchi the Rock! - 05v2 [720p].mkv', 'filename')).toEqual({ title: 'Bocchi the Rock!', episode: 5 })
    expect(mediaTitleOf('Lycoris Recoil Episode 7', 'tags')).toEqual({ title: 'Lycoris Recoil', episode: 7 })
  })

  it('reads Japanese titles and episode labels', () => {
    expect(mediaTitleOf('葬送のフリーレン 第13話.mkv', 'filename')).toEqual({ title: '葬送のフリーレン', episode: 13 })
  })

  it('never takes a bare number, a batch range, or a recap number as the episode', () => {
    expect(mediaTitleOf('Your Name (2016) [1080p].mkv', 'filename')).toEqual({ title: 'Your Name' })
    expect(mediaTitleOf('[Group] Frieren - 01-12 [Batch].mkv', 'filename')).toEqual({ title: 'Frieren' })
    expect(mediaTitleOf('Frieren - 13.5.mkv', 'filename')).toEqual({ title: 'Frieren' })
    expect(mediaTitleOf('Area 51', 'tags')).toEqual({ title: 'Area 51' })
  })

  it('keeps tag titles as they are except for control characters', () => {
    expect(mediaTitleOf('Frieren\u0007 [Special]', 'tags')).toEqual({ title: 'Frieren [Special]' })
  })

  it('returns nothing for an empty or tag-only name', () => {
    expect(mediaTitleOf('   ', 'filename')).toEqual({})
    expect(mediaTitleOf('[1080p].mkv', 'filename')).toEqual({})
  })
})
