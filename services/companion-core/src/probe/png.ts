import { Buffer } from 'node:buffer'
import { crc32, deflateSync } from 'node:zlib'

/**
 * Builds a PNG of one flat color and returns it as base64, ready for a `data:image/png;base64,` URL.
 * The image probe uses it, so that no provider can refuse the test image for being broken.
 *
 * @example
 * solidColorPng(16, 16, [255, 0, 0])
 * // => 'iVBORw0KGgo...' (a 16 by 16 red image)
 */
export function solidColorPng(width: number, height: number, [red, green, blue]: [number, number, number]): string {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  // Bit depth 8, color type 2 (RGB), and the default compression, filter, and interlace methods.
  header[8] = 8
  header[9] = 2

  // Each row starts with the filter type 0, which means that the bytes that follow are the pixels as they are.
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++)
    row.set([red, green, blue], 1 + x * 3)
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++)
    rows.push(row)
  const pixels = Buffer.concat(rows)

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}

/** A PNG chunk: length, type, data, and the CRC of the type and the data. */
function chunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const framed = Buffer.alloc(12 + data.length)
  framed.writeUInt32BE(data.length, 0)
  typeAndData.copy(framed, 4)
  framed.writeUInt32BE(crc32(typeAndData), 8 + data.length)
  return framed
}
