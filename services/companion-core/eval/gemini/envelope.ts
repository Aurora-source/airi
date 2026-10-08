import { readFileSync } from 'node:fs'

import * as v from 'valibot'

import { NATIVE_TOOL_REMINDER } from './capabilities'
import { history, SYSTEM } from './corpus'

/** Uses the repository's actual tool schemas with synthetic history. The harness never executes these functions. */
export function airiEnvelope() {
  const tools = v.parse(v.array(v.looseObject({
    type: v.literal('function'),
    function: v.looseObject({ name: v.string(), description: v.string(), parameters: v.unknown() }),
  })), JSON.parse(readFileSync(new URL('../../test/fixtures/airi-tools.json', import.meta.url), 'utf8')))
  const messages = history(4000)
  messages[0] = { role: 'system', content: `${SYSTEM}\n${NATIVE_TOOL_REMINDER}` }
  messages[messages.length - 1] = { role: 'user', content: 'Hey Mura, I finally have a quiet evening. Give me one warm, playful sentence about making tea together.' }
  return { tools, messages }
}
