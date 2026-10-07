/**
 * What the gateway reads out of a provider's rate-limit headers.
 *
 * The values are the provider's own numbers. The gateway does not interpret their window, because providers differ.
 * Groq reports requests per day and tokens per minute, and OpenAI reports both per minute.
 * A value of zero `remaining` until its reset time is what blocks a model.
 */
export interface ObservedLimits {
  limitRequests?: number
  remainingRequests?: number
  resetRequestsAtMs?: number
  limitTokens?: number
  remainingTokens?: number
  resetTokensAtMs?: number
  observedAtMs: number
}

/** The reason of a failed provider response, as far as the gateway needs it to choose between failover and passthrough. */
export type UpstreamFailure
  = | {
    kind: 'rate-limited'
    /** The quota window that the provider names. `unknown` when the body does not say. */
    window: 'minute' | 'day' | 'unknown'
    unit: 'requests' | 'tokens' | 'unknown'
    retryAfterMs?: number
    limit?: number
    used?: number
    requested?: number
  }
  /** The request is too big for this model. Another model can serve it. */
  | { kind: 'too-large' }
  /** The key is invalid or lacks access. The model stays unusable until someone fixes the key. */
  | { kind: 'auth' }
  | { kind: 'model-not-found' }
  /** The provider failed or is overloaded. A later request can succeed. */
  | { kind: 'server', retryAfterMs?: number }
  /** The request itself is wrong. Another model gives the same answer, so the gateway passes the error through. */
  | { kind: 'bad-request' }

const DURATION_TOKEN = /(\d+(?:\.\d+)?)(ms|[hms])/y
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const
const PLAIN_SECONDS = /^\d+(?:\.\d+)?$/
const TOO_LARGE_BODY = /maximum context length|context[_ ]length|token count exceeds|exceeds the maximum number of tokens|too large|reduce the length|reduce your message|input is too long|prompt is too long/i
const GROQ_LIMIT_BODY = /on (requests|tokens) per (minute|hour|day) \(\w+\): Limit (\d+), Used (\d+), Requested (\d+)/i
const GROQ_RETRY_BODY = /try again in ((?:\d+(?:\.\d+)?(?:ms|[hms]))+)/i

/**
 * Reads a Go-style duration such as `2m59.56s`, or a plain number of seconds.
 *
 * @example
 * parseDurationMs('2m59.56s')
 * // => 179560
 */
export function parseDurationMs(text: string): number | undefined {
  const value = text.trim()
  if (!value)
    return undefined
  if (PLAIN_SECONDS.test(value))
    return Math.round(Number(value) * 1000)

  let total = 0
  let position = 0
  DURATION_TOKEN.lastIndex = 0
  for (let match = DURATION_TOKEN.exec(value); match; match = DURATION_TOKEN.exec(value)) {
    total += Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS]
    position = DURATION_TOKEN.lastIndex
  }
  return position === value.length ? Math.round(total) : undefined
}

/** Reads a `Retry-After` header: a number of seconds, or an HTTP date. A date in the past gives zero. */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number): number | undefined {
  if (!value)
    return undefined
  const text = value.trim()
  if (PLAIN_SECONDS.test(text))
    return Math.round(Number(text) * 1000)
  const date = Date.parse(text)
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs)
}

/** Reads the `x-ratelimit-*` headers. Returns `undefined` when the provider sends none of them. */
export function parseRateLimitHeaders(headers: Headers, nowMs: number): ObservedLimits | undefined {
  const number = (name: string) => {
    const raw = headers.get(name)
    const parsed = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const resetAt = (name: string) => {
    const ms = parseDurationMs(headers.get(name) ?? '')
    return ms === undefined ? undefined : nowMs + ms
  }

  const observed: ObservedLimits = {
    limitRequests: number('x-ratelimit-limit-requests'),
    remainingRequests: number('x-ratelimit-remaining-requests'),
    resetRequestsAtMs: resetAt('x-ratelimit-reset-requests'),
    limitTokens: number('x-ratelimit-limit-tokens'),
    remainingTokens: number('x-ratelimit-remaining-tokens'),
    resetTokensAtMs: resetAt('x-ratelimit-reset-tokens'),
    observedAtMs: nowMs,
  }
  const hasAny = Object.entries(observed).some(([key, value]) => key !== 'observedAtMs' && value !== undefined)
  return hasAny ? observed : undefined
}

/**
 * Sorts a failed provider response into the few kinds that drive routing.
 *
 * The retry time comes from `Retry-After` first, then from the provider's body: Groq writes `try again in 12.9s`,
 * and Gemini sends a `RetryInfo.retryDelay` and a `QuotaFailure.quotaId` that names the window, for example `...PerDay...`.
 */
export function classifyUpstreamFailure(status: number, headers: Headers, body: string, nowMs: number): UpstreamFailure {
  const headerRetry = parseRetryAfterMs(headers.get('retry-after'), nowMs)

  if (status === 429) {
    const hints = bodyHints(body)
    const groq = GROQ_LIMIT_BODY.exec(hints.text)
    const groqRetry = GROQ_RETRY_BODY.exec(hints.text)
    const quotaId = hints.quotaIds.join(' ')
    const failure: UpstreamFailure = { kind: 'rate-limited', window: 'unknown', unit: 'unknown' }

    if (groq) {
      failure.window = groq[2].toLowerCase() === 'day' ? 'day' : groq[2].toLowerCase() === 'minute' ? 'minute' : 'unknown'
      failure.unit = groq[1].toLowerCase() === 'tokens' ? 'tokens' : 'requests'
      failure.limit = Number(groq[3])
      failure.used = Number(groq[4])
      failure.requested = Number(groq[5])
    }
    else if (quotaId) {
      failure.window = /PerDay/i.test(quotaId) ? 'day' : /PerMinute/i.test(quotaId) ? 'minute' : 'unknown'
      failure.unit = /Token/i.test(quotaId) ? 'tokens' : /Request/i.test(quotaId) ? 'requests' : 'unknown'
    }

    const retry = headerRetry ?? (groqRetry ? parseDurationMs(groqRetry[1]) : undefined) ?? hints.retryDelayMs
    if (retry !== undefined)
      failure.retryAfterMs = retry
    return failure
  }

  if (status === 413)
    return { kind: 'too-large' }
  if (status === 401 || status === 403)
    return { kind: 'auth' }
  if (status === 404)
    return { kind: 'model-not-found' }
  if (status === 408 || status >= 500)
    return headerRetry === undefined ? { kind: 'server' } : { kind: 'server', retryAfterMs: headerRetry }
  if (status === 400 && TOO_LARGE_BODY.test(body))
    return { kind: 'too-large' }
  return { kind: 'bad-request' }
}

/** Collects the message text, quota ids, and retry delay from an error body of any provider shape. */
function bodyHints(body: string): { text: string, quotaIds: string[], retryDelayMs?: number } {
  const hints: { text: string, quotaIds: string[], retryDelayMs?: number } = { text: body, quotaIds: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  }
  catch {
    return hints
  }
  const messages: string[] = []
  const walk = (value: unknown, depth: number) => {
    if (depth > 8 || value === null || typeof value !== 'object')
      return
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === 'string') {
        if (key === 'message')
          messages.push(child)
        else if (key === 'quotaId')
          hints.quotaIds.push(child)
        else if (key === 'retryDelay')
          hints.retryDelayMs ??= parseDurationMs(child)
      }
      else {
        walk(child, depth + 1)
      }
    }
  }
  walk(parsed, 0)
  if (messages.length > 0)
    hints.text = messages.join('\n')
  return hints
}
