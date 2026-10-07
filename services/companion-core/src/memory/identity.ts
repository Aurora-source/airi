import type { MemoryObservation } from './ports'

import { createHash } from 'node:crypto'

/**
 * Removes presentation markers and private reasoning before correlation or recall.
 * Unclosed reasoning consumes the remainder to prevent an interrupted tag from leaking.
 *
 * @example
 * normalizeText('[10:30] <think>private</think><|ACT:smile|> Hello  Rikon')
 * // => 'hello rikon'
 */
export function normalizeText(text: string): string {
  return visibleText(text).toLocaleLowerCase('en-US')
}

/**
 * Preserves visible wording while removing upstream formatting and reasoning.
 *
 * @example
 * visibleText('[09:10] <|ACT:wave|> Hello')
 * // => 'Hello'
 */
export function visibleText(text: string): string {
  return text.normalize('NFKC')
    .replace(/<(think|thinking|reasoning|analysis)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/<\|ACT:[^|]*\|>/gi, '')
    .replace(/^\s*\[\d{1,2}:\d{2}\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Length-safe hashing avoids delimiter collisions in user, scope and content fingerprints. */
export function fingerprint(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/** Persisted IDs distinguish repeated equal text. Content correlation is never authoritative identity. */
export function canonicalIdentity(event: MemoryObservation): string | null {
  const encode = encodeURIComponent
  if (event.source === 'spark' && event.sparkId)
    return `spark:${encode(event.sparkId)}`
  if (event.source === 'gateway')
    return null
  if (event.source === 'admin' && event.requestId)
    return `admin:${encode(event.requestId)}`
  if (!event.sessionId)
    return null
  const prefix = `airi:${encode(event.sessionId)}`
  if (event.kind === 'user_text' || event.kind === 'user_voice')
    return event.messageId ? `${prefix}:msg:${encode(event.messageId)}` : null
  if (event.turnId)
    return `${prefix}:turn:${encode(event.turnId)}`
  return null
}

/** User voice and persisted text can describe the same user message. Other event kinds stay distinct. */
export function matchIdentity(event: MemoryObservation): string {
  const kind = event.kind === 'user_voice' ? 'user_text' : event.kind
  return fingerprint(event.userId, event.characterId, kind, normalizeText(event.text))
}
