import { describe, expect, it } from 'vitest'

import { classifyUpstreamFailure, parseDurationMs, parseRateLimitHeaders, parseRetryAfterMs } from '../src/quota/rate-limit'

const NOW = Date.parse('2026-10-07T12:00:00Z')

describe('parseDurationMs', () => {
  it.each([
    ['2m59.56s', 179_560],
    ['7.66s', 7660],
    ['500ms', 500],
    ['1h2m3s', 3_723_000],
    ['14m27.36s', 867_360],
    ['12s', 12_000],
    ['12', 12_000],
    ['0.5', 500],
  ])('reads %s', (text, ms) => {
    expect(parseDurationMs(text)).toBe(ms)
  })

  it.each(['', 'soon', '-3s', 'NaN'])('rejects %j', (text) => {
    expect(parseDurationMs(text)).toBeUndefined()
  })
})

describe('parseRetryAfterMs', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfterMs('2', NOW)).toBe(2000)
    expect(parseRetryAfterMs('Wed, 07 Oct 2026 12:00:30 GMT', NOW)).toBe(30_000)
  })

  it('treats a date in the past as zero and rejects text', () => {
    expect(parseRetryAfterMs('Wed, 07 Oct 2026 11:00:00 GMT', NOW)).toBe(0)
    expect(parseRetryAfterMs('later', NOW)).toBeUndefined()
    expect(parseRetryAfterMs(null, NOW)).toBeUndefined()
  })
})

describe('parseRateLimitHeaders', () => {
  it('reads the Groq headers as published: requests are per day, tokens are per minute', () => {
    const headers = new Headers({
      'x-ratelimit-limit-requests': '1000',
      'x-ratelimit-limit-tokens': '8000',
      'x-ratelimit-remaining-requests': '999',
      'x-ratelimit-remaining-tokens': '3500',
      'x-ratelimit-reset-requests': '2m59.56s',
      'x-ratelimit-reset-tokens': '7.66s',
    })

    expect(parseRateLimitHeaders(headers, NOW)).toEqual({
      limitRequests: 1000,
      remainingRequests: 999,
      resetRequestsAtMs: NOW + 179_560,
      limitTokens: 8000,
      remainingTokens: 3500,
      resetTokensAtMs: NOW + 7660,
      observedAtMs: NOW,
    })
  })

  it('returns nothing when the provider sends no rate-limit headers', () => {
    expect(parseRateLimitHeaders(new Headers({ 'content-type': 'application/json' }), NOW)).toBeUndefined()
  })
})

describe('classifyUpstreamFailure', () => {
  const groqTpm = JSON.stringify({ error: { message: 'Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 7000, Used 4002, Requested 4506. Please try again in 12.9s. Need more tokens?', type: 'tokens', code: 'rate_limit_exceeded' } })
  const groqRpd = JSON.stringify({ error: { message: 'Rate limit reached for model `openai/gpt-oss-20b` service tier `on_demand` on requests per day (RPD): Limit 1000, Used 1000, Requested 1. Please try again in 14m27.36s.', code: 'rate_limit_exceeded' } })
  const geminiMinute = JSON.stringify([{ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', 'violations': [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '15' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', 'retryDelay': '37s' },
  ] } }])
  const geminiDay = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', 'violations': [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
  ] } })

  it('reads a Groq per-minute token limit with the retry time from the body', () => {
    expect(classifyUpstreamFailure(429, new Headers(), groqTpm, NOW)).toMatchObject({ kind: 'rate-limited', window: 'minute', unit: 'tokens', retryAfterMs: 12_900, limit: 7000, used: 4002, requested: 4506 })
  })

  it('reads a Groq per-day request limit', () => {
    expect(classifyUpstreamFailure(429, new Headers(), groqRpd, NOW)).toMatchObject({ kind: 'rate-limited', window: 'day', unit: 'requests', retryAfterMs: 867_360 })
  })

  it('reads Gemini quota ids and the retry delay inside a JSON array', () => {
    expect(classifyUpstreamFailure(429, new Headers(), geminiMinute, NOW)).toMatchObject({ kind: 'rate-limited', window: 'minute', unit: 'requests', retryAfterMs: 37_000 })
    expect(classifyUpstreamFailure(429, new Headers(), geminiDay, NOW)).toMatchObject({ kind: 'rate-limited', window: 'day', unit: 'requests' })
  })

  it('prefers the Retry-After header over the body', () => {
    const headers = new Headers({ 'retry-after': '3' })

    expect(classifyUpstreamFailure(429, headers, groqTpm, NOW)).toMatchObject({ retryAfterMs: 3000 })
  })

  it('classifies a 429 with an unreadable body as rate limited with an unknown window', () => {
    expect(classifyUpstreamFailure(429, new Headers(), 'upstream connect error', NOW)).toEqual({ kind: 'rate-limited', window: 'unknown', unit: 'unknown' })
  })

  it.each([
    [413, '{"error":{"message":"Request too large for model on tokens per minute (TPM): Limit 7000, Requested 9000"}}', 'too-large'],
    [400, '{"error":{"message":"This model\'s maximum context length is 8192 tokens. However, you requested 20000 tokens"}}', 'too-large'],
    [400, '{"error":{"message":"The input token count exceeds the maximum number of tokens allowed 1048576."}}', 'too-large'],
    [400, '{"error":{"message":"Invalid value for tool_choice"}}', 'bad-request'],
    [422, '{"error":"unprocessable"}', 'bad-request'],
    [401, '{"error":{"message":"Invalid API Key"}}', 'auth'],
    [403, '{"error":{"message":"permission denied"}}', 'auth'],
    [404, '{"error":{"message":"model not found"}}', 'model-not-found'],
    [500, 'oops', 'server'],
    [502, '', 'server'],
    [503, '{"error":{"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}', 'server'],
    [529, '', 'server'],
    [408, '', 'server'],
  ])('classifies status %i as %s', (status, body, kind) => {
    expect(classifyUpstreamFailure(status, new Headers(), body, NOW).kind).toBe(kind)
  })
})
