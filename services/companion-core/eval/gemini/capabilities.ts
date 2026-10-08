import type { WireMessage } from '../../src/budget/wire'
import type { StreamResult } from './protocol'

import * as v from 'valibot'

import { SYSTEM } from './corpus'

/** Distinguishes stage control markers from the API functions supplied by this benchmark. */
export const NATIVE_TOOL_REMINDER = 'The supplied API functions are separate from stage CALL markers. Invoke them with native API tool_calls, never text CALL markers.'

export const TOOL_SYSTEM = `${SYSTEM}
${NATIVE_TOOL_REMINDER}
When the user requests synthetic_clock, call that API function before answering. Do not invent its result.
After receiving the tool result, answer naturally with a valid ACT marker.`

/** Validates a local fixture call before supplying its result. Missing or incorrect calls remain recorded failures. */
export function clockContinuation(messages: WireMessage[], result: Pick<StreamResult, 'text' | 'calls'>): WireMessage[] | undefined {
  const call = result.calls[0]
  if (result.calls.length !== 1 || !call?.id || call.function?.name !== 'synthetic_clock' || !call.function.arguments)
    return
  let argumentsValue: unknown
  try {
    argumentsValue = JSON.parse(call.function.arguments)
  }
  catch {
    return
  }
  if (!v.safeParse(v.object({ location: v.literal('Kyoto') }), argumentsValue).success)
    return
  return [
    ...messages,
    { role: 'assistant', content: result.text || null, tool_calls: result.calls },
    { role: 'tool', tool_call_id: call.id, content: '{"location":"Kyoto","time":"19:30","source":"synthetic"}' },
  ]
}
