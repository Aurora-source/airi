import type { WireMessage, WireToolCall } from '../../src/budget/wire'

import { readFileSync } from 'node:fs'

export function system(text: string): WireMessage {
  return { role: 'system', content: text }
}

export function user(text: string): WireMessage {
  return { role: 'user', content: text }
}

export function assistant(text: string): WireMessage {
  return { role: 'assistant', content: text }
}

export function toolCall(id: string, name: string, args: Record<string, unknown> = {}): WireToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

/** An assistant message that calls tools. Gemini also sends text with its calls, so `text` is optional. */
export function assistantCalls(calls: WireToolCall[], text: string | null = null): WireMessage {
  return { role: 'assistant', content: text, tool_calls: calls }
}

export function toolResult(id: string, text: string): WireMessage {
  return { role: 'tool', tool_call_id: id, content: text }
}

/**
 * Text that the default estimator counts as about `tokens` tokens.
 * Distinct `seed` values give distinct texts, so a test can tell one message from another.
 */
export function filler(tokens: number, seed = 'x'): string {
  const length = Math.max(1, Math.round(tokens * 3.4))
  return `${seed}:`.padEnd(length, seed)
}

/**
 * The `tools` array of a real AIRI request: five tool schemas from xsAI `tool()`, 7.8k characters,
 * 1,817 tokens by Gemini `countTokens`. AIRI sends four more runtime tools in a full session.
 */
export const AIRI_TOOLS = JSON.parse(readFileSync(new URL('../fixtures/airi-tools.json', import.meta.url), 'utf8')) as unknown[]
