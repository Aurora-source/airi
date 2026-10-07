import type { WireMessage, WireRequest } from '../budget/wire'

import { isInstructionRole } from '../budget/wire'

/**
 * Adds a model-specific reminder to the end of the system prompt.
 *
 * Some models follow a format rule better when its last words are near the end of the system prompt.
 * The persona benchmark showed it: a reminder to close ACT tokens with `|>` raised the share of valid ACT tokens.
 * The reminder goes into the last leading system message. When the request has none, it becomes a new system message.
 * Model selection comes first. The reminder is a small help and not a cure.
 *
 * The router shares one request between its candidates, so this returns a changed copy and never edits its input.
 * Without a reminder, the same object comes back.
 */
export function withStyleReminder(body: WireRequest, reminder: string | undefined): WireRequest {
  if (!reminder)
    return body
  const messages = body.messages ?? []

  let last = -1
  while (last + 1 < messages.length && isInstructionRole(messages[last + 1].role))
    last++
  if (last < 0)
    return { ...body, messages: [{ role: 'system', content: reminder }, ...messages] }

  const target = messages[last]
  const content: WireMessage['content'] = Array.isArray(target.content)
    ? [...target.content, { type: 'text', text: reminder }]
    : `${typeof target.content === 'string' ? target.content : ''}\n\n${reminder}`
  return { ...body, messages: messages.map((message, index) => index === last ? { ...target, content } : message) }
}
