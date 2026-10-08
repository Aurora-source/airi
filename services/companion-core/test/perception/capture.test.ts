import { describe, expect, it } from 'vitest'

import { sampleLuminance } from '../../src/perception/capture/luminance'
import { PerceptionFailure, withDeadline } from '../../src/perception/ports/failure'

describe('capture sampling and deadline cleanup', () => {
  it('samples a bounded grid from RGBA pixels', () => {
    const pixels = new Uint8Array(640 * 360 * 4)
    for (let i = 0; i < pixels.length; i += 4) pixels.set([100, 100, 100, 255], i)
    const grid = sampleLuminance(pixels, 640, 360)
    expect(grid.length).toBe(2304)
    expect(grid.every(value => value === 100)).toBe(true)
    pixels.fill(0)
    expect(grid.every(value => value === 100)).toBe(true)
  })

  it('rejects inconsistent and excessive raster buffers', () => {
    for (const [width, height] of [[0, 1], [1.5, 2], [8193, 1], [2, 2]])
      expect(() => sampleLuminance(new Uint8Array(4), width, height)).toThrow()
  })

  it('releases values that arrive after a deadline expires', async () => {
    let resolve!: (value: Uint8Array) => void
    const pending = new Promise<Uint8Array>((done) => {
      resolve = done
    })
    await expect(withDeadline(() => pending, new AbortController().signal, 5, value => value.fill(0))).rejects.toMatchObject({ code: 'timeout' })
    const late = new Uint8Array([1, 2, 3])
    resolve(late)
    await Promise.resolve()
    expect(late).toEqual(new Uint8Array(3))
  })

  it('retains safe classified failures and excludes arbitrary error text', async () => {
    await expect(withDeadline(async () => {
      throw new PerceptionFailure('rate-limited', 60000)
    }, new AbortController().signal, 100)).rejects.toMatchObject({ code: 'rate-limited', retry_after_ms: 60000 })
    await expect(withDeadline(async () => {
      throw new Error('SCREEN SECRET')
    }, new AbortController().signal, 100)).rejects.toThrow('Perception provider-error')
  })
})
