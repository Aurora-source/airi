import type { ObservationFacts } from '../ports/contracts'

import * as v from 'valibot'

const text = (length: number) => v.pipe(v.string(), v.maxLength(length))
const schema = v.strictObject({
  confidence: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
  scene_type: v.picklist(['code', 'browser', 'terminal', 'desktop', 'media', 'other', 'unknown']),
  activity: text(80),
  visible_text_summary: text(240),
  notable_objects: v.pipe(v.array(text(60)), v.maxLength(6)),
  people_count: v.optional(v.pipe(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(20))), v.transform(value => value ?? undefined))),
  media: v.strictObject({ detected: v.boolean(), playback: v.picklist(['playing', 'paused', 'unknown']), title_like_text: text(120), subtitle_like_text: text(160) }),
  warnings: v.pipe(v.array(text(80)), v.maxLength(3)),
  concise_summary: text(320),
})

/** Invalid provider values produce a generic error. Provider contents never enter diagnostics. */
export function parseObservation(input: unknown): ObservationFacts {
  let value = input
  if (typeof input === 'string') {
    if (input.length > 8192)
      throw new Error('Invalid vision observation')
    try {
      value = JSON.parse(input)
    }
    catch { throw new Error('Invalid vision observation') }
  }
  const result = v.safeParse(schema, value)
  if (!result.success)
    throw new Error('Invalid vision observation')
  return result.output
}

const stringProperty = (maxLength: number) => ({ type: 'string', maxLength })

/** Providers receive the same limits as local validation. Tools and arbitrary schema extensions are absent. */
export const observationJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['confidence', 'scene_type', 'activity', 'visible_text_summary', 'notable_objects', 'people_count', 'media', 'warnings', 'concise_summary'],
  properties: {
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    scene_type: { type: 'string', enum: ['code', 'browser', 'terminal', 'desktop', 'media', 'other', 'unknown'] },
    activity: stringProperty(80),
    visible_text_summary: stringProperty(240),
    notable_objects: { type: 'array', maxItems: 6, items: stringProperty(60) },
    people_count: { type: ['integer', 'null'], minimum: 0, maximum: 20 },
    media: { type: 'object', additionalProperties: false, required: ['detected', 'playback', 'title_like_text', 'subtitle_like_text'], properties: {
      detected: { type: 'boolean' },
      playback: { type: 'string', enum: ['playing', 'paused', 'unknown'] },
      title_like_text: stringProperty(120),
      subtitle_like_text: stringProperty(160),
    } },
    warnings: { type: 'array', maxItems: 3, items: stringProperty(80) },
    concise_summary: stringProperty(320),
  },
}
