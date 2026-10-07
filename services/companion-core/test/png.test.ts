import { Buffer } from 'node:buffer'
import { crc32, inflateSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { solidColorPng } from '../src/probe/png'

/** Reads the chunks of a PNG and checks the CRC of each, as any decoder does. */
function readChunks(png: Buffer) {
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  const chunks: { type: string, data: Buffer }[] = []
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('ascii')
    const data = png.subarray(offset + 8, offset + 8 + length)
    expect(png.readUInt32BE(offset + 8 + length), `CRC of ${type}`).toBe(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])))
    chunks.push({ type, data })
    offset += 12 + length
  }
  return chunks
}

describe('solidColorPng', () => {
  it('writes a valid PNG with the requested size and color', () => {
    const png = Buffer.from(solidColorPng(16, 8, [255, 0, 0]), 'base64')

    const chunks = readChunks(png)

    expect(chunks.map(chunk => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    const header = chunks[0].data
    expect(header.readUInt32BE(0)).toBe(16)
    expect(header.readUInt32BE(4)).toBe(8)
    expect(header[8]).toBe(8)
    expect(header[9]).toBe(2)
    const pixels = inflateSync(chunks[1].data)
    // One filter byte, then 16 RGB pixels, for each of the 8 rows.
    expect(pixels.length).toBe((1 + 16 * 3) * 8)
    expect([...pixels.subarray(0, 4)]).toEqual([0, 255, 0, 0])
  })
})
