/**
 * One chat-completions message as AIRI's OpenAI-compatible client sends it.
 *
 * The budgeter keeps or drops whole messages and never edits them, so every other field,
 * for example `extra_content` on Gemini tool calls, passes through untouched.
 */
export interface WireMessage {
  role: string
  /** A string, or an array of content parts, or `null` for an assistant message that only calls tools. */
  content?: unknown
  tool_calls?: WireToolCall[]
  /** Set on `tool` messages. It names the call that this message answers. */
  tool_call_id?: string
  [key: string]: unknown
}

export interface WireToolCall {
  id: string
  type?: string
  function?: { name?: string, arguments?: string }
  [key: string]: unknown
}

/** The parts of a chat-completions request body that routing and budgeting read. */
export interface WireRequest {
  model: string
  messages?: WireMessage[]
  tools?: unknown[]
  tool_choice?: unknown
  stream?: unknown
  max_tokens?: unknown
  max_completion_tokens?: unknown
  response_format?: unknown
  [key: string]: unknown
}

/** Roles that open a conversation and are never trimmed. `developer` is the newer name for `system`. */
export function isInstructionRole(role: string): boolean {
  return role === 'system' || role === 'developer'
}
