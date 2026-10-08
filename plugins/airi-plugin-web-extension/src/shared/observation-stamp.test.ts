import { describe, expect, it } from 'vitest'

import { ObservationStamper } from './observation-stamp'

describe('observationStamper', () => {
  it('shares one growing sequence across observations and keeps the read time', () => {
    let now = 1000
    const stamper = new ObservationStamper(() => now)
    const first = stamper.stamp('youtube', 'https://www.youtube.com/watch?v=abc')
    now = 1400
    const second = stamper.stamp('youtube', 'https://www.youtube.com/watch?v=abc&t=30')

    expect(first).toEqual({ stream: stamper.stream, sequence: 1, observedAt: 1000, timeline: 0 })
    expect(second).toEqual({ stream: stamper.stream, sequence: 2, observedAt: 1400, timeline: 0 })
  })

  it('starts a new timeline on a seek and on another media identity', () => {
    const stamper = new ObservationStamper(() => 0)
    stamper.stamp('bilibili', 'https://www.bilibili.com/video/BV1?p=1')
    stamper.restartTimeline()
    const afterSeek = stamper.stamp('bilibili', 'https://www.bilibili.com/video/BV1?p=1')
    const nextPart = stamper.stamp('bilibili', 'https://www.bilibili.com/video/BV1?p=2')

    expect(afterSeek.timeline).toBe(1)
    expect(nextPart.timeline).toBe(2)
  })

  it('starts a new timeline when an explicit media name changes on the same page URL', () => {
    const stamper = new ObservationStamper(() => 0)
    const url = 'https://media.example.com/web/#/video'
    stamper.stamp('jellyfin', url, 'jellyfin:t:Episode 1')
    const same = stamper.stamp('jellyfin', url, 'jellyfin:t:Episode 1')
    const next = stamper.stamp('jellyfin', url, 'jellyfin:t:Episode 2')

    expect(same.timeline).toBe(0)
    expect(next.timeline).toBe(1)
  })

  it('gives every observer its own stream', () => {
    expect(new ObservationStamper().stream).not.toBe(new ObservationStamper().stream)
  })
})
