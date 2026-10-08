/**
 * Samples four points per grid cell. Work stays bounded at 9216 pixels, independent of desktop resolution.
 * The capture backend owns downscaling and image encoding. This grid is only a cheap change signal.
 *
 * @example
 * sampleLuminance(new Uint8Array([100, 100, 100, 255]), 1, 1)
 * // => Uint8Array(2304), with each value equal to 100
 */
export function sampleLuminance(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || rgba.length !== width * height * 4)
    throw new Error('Invalid capture raster')
  const output = new Uint8Array(2304)
  for (let y = 0; y < 36; y++) {
    for (let x = 0; x < 64; x++) {
      let total = 0
      for (const dy of [0.25, 0.75]) {
        for (const dx of [0.25, 0.75]) {
          const row = Math.min(height - 1, Math.floor((y + dy) * height / 36))
          const column = Math.min(width - 1, Math.floor((x + dx) * width / 64))
          const index = (row * width + column) * 4
          total += (rgba[index] * 77 + rgba[index + 1] * 150 + rgba[index + 2] * 29) / 256
        }
      }
      output[y * 64 + x] = Math.round(total / 4)
    }
  }
  return output
}
