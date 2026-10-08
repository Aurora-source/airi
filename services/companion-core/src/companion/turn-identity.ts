import type { IncomingHttpHeaders } from 'node:http'

/** Chat session id. Upstream AIRI already sends it to its official provider. */
export const AIRI_SESSION_HEADER = 'x-airi-session-id'
/** Round id. It is the id of the committed user message that opened the turn. */
export const AIRI_ROUND_HEADER = 'x-airi-round-id'
/** Id of the AIRI character card that owns the session. */
export const AIRI_CHARACTER_HEADER = 'x-airi-character-id'

export const TURN_IDENTITY_HEADERS = [AIRI_SESSION_HEADER, AIRI_ROUND_HEADER, AIRI_CHARACTER_HEADER] as const

/** Who a chat request belongs to. All three ids come from AIRI's persisted chat state. */
export interface TurnIdentity {
  sessionId: string
  roundId: string
  characterId: string
}

const ID = /^[\w.:-]{1,256}$/

/**
 * Reads the AIRI turn identity from request headers.
 * It returns `undefined` unless all three ids are present and well formed. Memory then stays out of the request.
 *
 * @example
 * turnIdentityOf({ 'x-airi-session-id': 's1', 'x-airi-round-id': 'r1', 'x-airi-character-id': 'c1' })
 * // => { sessionId: 's1', roundId: 'r1', characterId: 'c1' }
 */
export function turnIdentityOf(headers: IncomingHttpHeaders): TurnIdentity | undefined {
  const read = (name: string) => {
    const value = headers[name]
    return typeof value === 'string' && ID.test(value) ? value : undefined
  }
  const sessionId = read(AIRI_SESSION_HEADER)
  const roundId = read(AIRI_ROUND_HEADER)
  const characterId = read(AIRI_CHARACTER_HEADER)
  return sessionId && roundId && characterId ? { sessionId, roundId, characterId } : undefined
}
