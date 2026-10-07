import type { WireMessage } from './wire'

import { isInstructionRole } from './wire'

/** A run of messages. `start` is inclusive and `end` is exclusive. */
export interface MessageRange {
  start: number
  end: number
}

/**
 * One assistant message with `tool_calls` and every `tool` message that answers those calls, including failed and cancelled results.
 * It is indivisible. The budgeter never keeps the call without its results or the results without their call.
 */
export interface ToolExchangeUnit extends MessageRange {
  callIds: string[]
}

/**
 * Every assistant and tool message between two user-side messages. It is the wire projection of one upstream `AssistantTurn`,
 * with all its `GenerationRound`s.
 */
export interface AssistantTurnUnit extends MessageRange {
  exchanges: ToolExchangeUnit[]
  /**
   * Index of the closing assistant message when it carries text and no tool calls.
   * It is absent when the turn ends with tool results, as in an agent continuation.
   */
  finalTextIndex?: number
}

/**
 * The unit that the budgeter keeps or drops: the user-side messages that open a turn, and the assistant turn that answers them.
 *
 * User-side messages are `user`, and also `system` or `developer` after the conversation started.
 * AIRI renders its context, event, and summary turns as `user` messages, so several can follow each other.
 * A kept group keeps every message of its user side, because a user turn is whole or nothing.
 */
export interface TurnGroup extends MessageRange {
  userSide: MessageRange
  assistant?: AssistantTurnUnit
}

export type MalformedReason
  = | 'orphan-tool-result'
    | 'missing-tool-result'
    | 'unresolved-tool-call'
    | 'assistant-before-user'
    | 'invalid-tool-call'
    | 'unknown-role'
    | 'no-user-message'

export type ParsedConversation
  = | {
    ok: true
    /** The leading `system` and `developer` messages. They are never trimmed. */
    system: MessageRange
    groups: TurnGroup[]
  }
  | { ok: false, reason: MalformedReason, detail: string }

/**
 * Parses an OpenAI chat message list into atomic context units.
 *
 * The result is `ok: false` when the history is not a valid provider history. The budgeter then passes the request through
 * unchanged, so that it never makes a broken history worse. Tool results can arrive in any order inside their exchange.
 *
 * @example
 * parseConversation([system, user, assistantWithCall, toolResult, assistant])
 * // => { ok: true, system: { start: 0, end: 1 }, groups: [{ start: 1, end: 5, ... }] }
 */
export function parseConversation(messages: readonly WireMessage[]): ParsedConversation {
  let cursor = 0
  while (cursor < messages.length && isInstructionRole(messages[cursor].role))
    cursor++
  const system = { start: 0, end: cursor }

  const groups: TurnGroup[] = []
  let group: TurnGroup | undefined
  /** The exchange that still waits for tool results. */
  let open: { start: number, callIds: string[], pending: Set<string> } | undefined

  for (let index = cursor; index < messages.length; index++) {
    const message = messages[index]
    if (open && message.role !== 'tool')
      return malformed('missing-tool-result', `message ${index} (${message.role}) follows tool calls that have no result yet`)

    switch (message.role) {
      case 'user':
      case 'system':
      case 'developer': {
        // A user-side message that follows an assistant turn opens the next group.
        if (!group || group.assistant) {
          group = { start: index, end: index, userSide: { start: index, end: index } }
          groups.push(group)
        }
        group.userSide.end = index + 1
        group.end = index + 1
        break
      }
      case 'assistant': {
        if (!group)
          return malformed('assistant-before-user', `message ${index} is an assistant message before any user message`)
        group.assistant ??= { start: index, end: index, exchanges: [] }
        group.assistant.end = index + 1
        group.end = index + 1
        const calls = message.tool_calls ?? []
        if (calls.length > 0) {
          const callIds = calls.map(call => call.id)
          if (callIds.some(id => typeof id !== 'string' || id === '') || new Set(callIds).size !== callIds.length)
            return malformed('invalid-tool-call', `message ${index} has a tool call without an id or with a repeated id`)
          open = { start: index, callIds, pending: new Set(callIds) }
        }
        break
      }
      case 'tool': {
        if (!open || !group?.assistant || typeof message.tool_call_id !== 'string' || !open.pending.delete(message.tool_call_id))
          return malformed('orphan-tool-result', `message ${index} answers no pending tool call`)
        group.assistant.end = index + 1
        group.end = index + 1
        if (open.pending.size === 0) {
          group.assistant.exchanges.push({ start: open.start, end: index + 1, callIds: open.callIds })
          open = undefined
        }
        break
      }
      default:
        return malformed('unknown-role', `message ${index} has the role "${String(message.role)}"`)
    }
  }

  if (open)
    return malformed('unresolved-tool-call', 'the conversation ends with tool calls that have no result, as after an interrupted generation')
  if (groups.length === 0)
    return malformed('no-user-message', 'the conversation has no user message')

  for (const turn of groups) {
    if (turn.assistant && hasFinalText(messages[turn.assistant.end - 1]))
      turn.assistant.finalTextIndex = turn.assistant.end - 1
  }
  return { ok: true, system, groups }
}

function malformed(reason: MalformedReason, detail: string): ParsedConversation {
  return { ok: false, reason, detail }
}

function hasFinalText(message: WireMessage): boolean {
  if (message.role !== 'assistant' || (message.tool_calls?.length ?? 0) > 0)
    return false
  if (typeof message.content === 'string')
    return message.content.trim() !== ''
  if (Array.isArray(message.content))
    return message.content.some(part => typeof (part as { text?: unknown })?.text === 'string' && (part as { text: string }).text.trim() !== '')
  return false
}
