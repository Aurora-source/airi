import type { ScreenFrame } from '../ports/contracts'

import * as v from 'valibot'

import { PerceptionFailure } from '../ports/failure'

const label = v.pipe(v.string(), v.maxLength(256))
const dimension = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8192))
const schema = v.strictObject({
  capture_id: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  captured_at: v.pipe(v.number(), v.finite(), v.minValue(0)),
  width: dimension,
  height: dimension,
  source: v.strictObject({
    kind: v.picklist(['window', 'display', 'reference']),
    id: v.pipe(label, v.minLength(1)),
    generation: v.pipe(v.number(), v.integer(), v.minValue(0)),
    display_id: v.optional(label),
    window_id: v.optional(label),
    foreground_app: v.optional(label),
    window_title: v.optional(label),
  }),
  safety: v.strictObject({ private_context: v.optional(v.boolean()), locked: v.optional(v.boolean()), sensitive: v.optional(v.boolean()) }),
  samples: v.pipe(v.instance(Uint8Array), v.length(2304)),
  image: v.strictObject({ mime_type: v.picklist(['image/png', 'image/jpeg', 'image/webp']), bytes: v.pipe(v.instance(Uint8Array), v.minLength(1), v.maxLength(4 * 1024 * 1024)) }),
  media_hint: v.optional(v.literal('video')),
})

/** Capture bounds apply before privacy or any upload. Validation errors contain no capture metadata. */
export function validateFrame(frame: ScreenFrame): void {
  if (!v.safeParse(schema, frame).success)
    throw new PerceptionFailure('invalid-capture')
}
