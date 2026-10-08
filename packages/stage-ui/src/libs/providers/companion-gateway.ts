/** Port of the local Companion Gateway in `services/companion-core`. */
export const COMPANION_GATEWAY_PORT = '11980'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Whether a provider base URL points at the local Companion Gateway.
 * The gateway reads the chat session, round, and character ids to scope memory. No other provider gets them.
 *
 * @example
 * isCompanionGatewayURL('http://127.0.0.1:11980/v1/')
 * // => true
 */
export function isCompanionGatewayURL(baseURL: unknown): boolean {
  if (typeof baseURL !== 'string' && !(baseURL instanceof URL))
    return false
  try {
    const url = new URL(baseURL)
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && url.port === COMPANION_GATEWAY_PORT
  }
  catch {
    return false
  }
}
