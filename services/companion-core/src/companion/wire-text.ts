import type { WireMessage, WireRequest } from '../budget/wire'

import { parseConversation } from '../budget/request-units'

/**
 * The visible text of one message. Text parts join with a space. Images and audio are left out.
 *
 * @example
 * textOf({ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url' }] })
 * // => 'look'
 */
export function textOf(message: WireMessage | undefined): string {
  const content = message?.content
  if (typeof content === 'string')
    return content
  if (!Array.isArray(content))
    return ''
  return content
    .map(part => (part as { type?: unknown, text?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : '')
    .filter(Boolean)
    .join(' ')
}

/** The newest user message of the request. It is the message that opened the current turn. */
export function currentUserText(body: WireRequest): string {
  const messages = body.messages ?? []
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user')
      return textOf(messages[index])
  }
  return ''
}

/** The request carries a tool result, so it is a later round of a turn that already started. */
export function isToolContinuation(body: WireRequest): boolean {
  return body.messages?.at(-1)?.role === 'tool'
}

/** Tool calls and results of the current turn, as memory evidence keyed by call id. Texts are capped. */
export function currentToolEvidence(body: WireRequest, maxChars = 400): { callId: string, name: string, outcome: 'success', text: string }[] {
  const messages = body.messages ?? []
  const parsed = parseConversation(messages)
  if (!parsed.ok)
    return []
  const current = parsed.groups.at(-1)?.assistant
  if (!current)
    return []
  const evidence: { callId: string, name: string, outcome: 'success', text: string }[] = []
  for (const exchange of current.exchanges) {
    const call = messages[exchange.start]
    for (let index = exchange.start + 1; index < exchange.end; index++) {
      const result = messages[index]
      const name = call.tool_calls?.find(item => item.id === result.tool_call_id)?.function?.name
      const text = textOf(result).trim()
      if (result.tool_call_id && name && text)
        evidence.push({ callId: result.tool_call_id, name, outcome: 'success', text: text.slice(0, maxChars) })
    }
  }
  return evidence.slice(0, 32)
}
