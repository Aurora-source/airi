import type { ScreenFrame } from '../ports/contracts'

import { Buffer } from 'node:buffer'

import { observationJsonSchema } from '../observations/schema'
import { observationPrompt } from './prompt'

/** Output bound of one observation. The schema keeps every field short. */
export const VISION_MAX_TOKENS = 700

/** The chat-completions body of one observation request. It offers no tools. */
export function visionRequestBody(model: string, frame: ScreenFrame, structured: boolean): Record<string, unknown> {
  return {
    model,
    stream: false,
    max_tokens: VISION_MAX_TOKENS,
    messages: [
      { role: 'system', content: `${observationPrompt}\nSchema: ${JSON.stringify(observationJsonSchema)}` },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${frame.image.mime_type};base64,${Buffer.from(frame.image.bytes).toString('base64')}`, detail: 'low' } }] },
    ],
    response_format: structured
      ? { type: 'json_schema', json_schema: { name: 'screen_observation', strict: true, schema: observationJsonSchema } }
      : { type: 'json_object' },
  }
}
