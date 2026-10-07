/**
 * Shapes of credentials that must never reach a log line, even if a known secret list is incomplete.
 * Order matters: the bearer rule runs first so that the whole header value is replaced.
 */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /Bearer\s+[\w.~+/=-]+/gi,
  /cc_(?:inf|ops)_[\w-]+/g,
  /AIza[\w-]{20,}/g,
  /gsk_\w{20,}/g,
  /sk-or-[\w-]{20,}/g,
  /sk-[\w-]{20,}/g,
]

/**
 * Returns a function that removes known secrets and credential-shaped strings from text.
 *
 * @example
 * createRedactor(['secret-value'])('key=secret-value auth=Bearer abc.def')
 * // => 'key=[REDACTED] auth=[REDACTED]'
 */
export function createRedactor(secrets: readonly string[]): (text: string) => string {
  const known = secrets.filter(secret => secret.length >= 8)
  return (text) => {
    let result = text
    for (const secret of known)
      result = result.split(secret).join('[REDACTED]')
    for (const pattern of CREDENTIAL_PATTERNS)
      result = result.replace(pattern, '[REDACTED]')
    return result
  }
}
