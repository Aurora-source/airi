import type { WireRequest } from '../budget/wire'

import { createHash } from 'node:crypto'

import { parseConversation } from '../budget/request-units'
import { isInstructionRole } from '../budget/wire'

/** How many of the newest turns count as recent when the prompt policy looks for tool activity. */
const RECENT_TURNS = 6

/** What the router needs to know about a request, besides its size. */
export interface RequestTraits {
  stream: boolean
  /** The request offers tools, and `tool_choice` does not switch them off. */
  hasTools: boolean
  /** The model must call a tool: `tool_choice` is `required` or names a function. */
  toolsRequired: boolean
  /** The request ends with a tool result, so it is the second or a later round of a tool turn. */
  toolContinuation: boolean
  hasImages: boolean
  structuredOutput: boolean
  /** Tool exchanges in the newest turns. A busy tool history asks for a larger prompt. */
  recentToolExchanges: number
  /** Identifies the conversation for sticky routing. It holds no message text. */
  conversationKey: string
}

/**
 * Reads the traits of a chat-completions request.
 *
 * AIRI sends no session id, so the conversation key is a hash of the first user-side message.
 * That message stays the same while the conversation grows. Two conversations that begin with the same words share
 * a key. That is harmless, because the key only decides which model to prefer. A `user` field in the request wins.
 */
export function analyzeRequest(body: WireRequest): RequestTraits {
  const messages = body.messages ?? []
  const toolChoice = body.tool_choice
  const toolsOff = toolChoice === 'none'
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0 && !toolsOff
  const responseFormat = body.response_format as { type?: unknown } | undefined

  const parsed = parseConversation(messages)
  let recentToolExchanges = 0
  if (parsed.ok) {
    for (const group of parsed.groups.slice(-RECENT_TURNS))
      recentToolExchanges += group.assistant?.exchanges.length ?? 0
  }

  return {
    stream: body.stream === true,
    hasTools,
    toolsRequired: hasTools && (toolChoice === 'required' || (typeof toolChoice === 'object' && toolChoice !== null)),
    toolContinuation: messages.at(-1)?.role === 'tool',
    hasImages: messages.some(message => Array.isArray(message.content) && message.content.some(part => isImagePart(part))),
    structuredOutput: responseFormat?.type === 'json_schema' || responseFormat?.type === 'json_object',
    recentToolExchanges,
    conversationKey: conversationKeyOf(body),
  }
}

function isImagePart(part: unknown): boolean {
  const type = (part as { type?: unknown } | null)?.type
  return type === 'image_url' || type === 'input_image' || type === 'image'
}

function conversationKeyOf(body: WireRequest): string {
  const messages = body.messages ?? []
  const first = messages.find(message => !isInstructionRole(message.role))
  const source = typeof body.user === 'string' && body.user ? `user:${body.user}` : `first:${JSON.stringify(first?.content ?? null)}`
  return createHash('sha256').update(source).digest('hex').slice(0, 16)
}
