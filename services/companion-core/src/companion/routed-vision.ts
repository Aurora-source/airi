import type { WireRequest } from '../budget/wire'
import type { GatewayRuntime } from '../gateway/runtime'
import type { ScreenFrame, VisionObservationPort } from '../perception/ports/contracts'
import type { Candidate } from '../routing/eligibility'

import { Buffer } from 'node:buffer'

import { PerceptionFailure } from '../perception/ports/failure'
import { visionRequestBody } from '../perception/vision/request'
import { prepareGeminiRequest } from '../providers/gemini-compat'
import { sendChatCompletion } from '../providers/openai-compatible'
import { classifyUpstreamFailure, parseRateLimitHeaders } from '../quota/rate-limit'

/** A provider answer larger than this is not an observation. */
const MAX_RESPONSE_BYTES = 32 * 1024

export interface RoutedVisionOptions {
  runtime: GatewayRuntime
  /** A `vision` alias of the gateway configuration. Its chain decides which models observe the screen. */
  alias: string
  /** Hybrid only: local models of the chain can answer after every cloud model failed. */
  allowLocal: boolean
}

type AttemptResult
  = | { kind: 'ok', content: string }
    | { kind: 'failed' }
    | { kind: 'rate-limited', retryAfterMs?: number }
    | { kind: 'terminal' }

/**
 * Sends screen observations through the R2B router, so vision shares the gateway's capability checks, profile rules,
 * quota ledger, health, and cool-downs. It never starts a local model and never routes by itself.
 *
 * The privacy guard runs before every candidate. A revoked policy stops the failover before the next upload.
 *
 * Call stack:
 *
 * VisionChain.observe (../perception/vision/chain)
 *   -> {@link RoutedVisionAdapter.observe}
 *     -> Router.plan (../routing/router)
 *     -> attempt -> sendChatCompletion (../providers/openai-compatible)
 */
export class RoutedVisionAdapter implements VisionObservationPort {
  readonly id: string
  readonly locality: 'cloud' | 'local'
  readonly capabilities = { vision: true, structured_output: true }

  constructor(private readonly options: RoutedVisionOptions) {
    this.id = `gateway:${options.alias}`
    // The chain filter in VisionChain sees one adapter. The router applies the real per-model profile rules.
    this.locality = options.runtime.config.profile === 'local' ? 'local' : 'cloud'
  }

  async observe(input: { frame: ScreenFrame, signal: AbortSignal, guard?: () => void }): Promise<unknown> {
    const { runtime, alias } = this.options
    const body = visionRequestBody(alias, input.frame, true) as WireRequest
    const plan = runtime.router.plan(body, undefined, { allowLocal: this.options.allowLocal && runtime.config.profile !== 'cloud' && runtime.config.profile !== 'cloud-mura-voice' })
    if (!plan.ok)
      throw new PerceptionFailure(plan.error.status === 429 ? 'rate-limited' : plan.error.status === 404 ? 'unconfigured' : 'provider-error', plan.error.retryAfterMs)
    let limited: { retryAfterMs?: number } | undefined
    for (const candidate of plan.candidates) {
      input.guard?.()
      if (input.signal.aborted)
        throw new PerceptionFailure('cancelled')
      const result = await this.attempt(candidate, input.signal)
      if (result.kind === 'ok')
        return result.content
      if (result.kind === 'rate-limited')
        limited = { retryAfterMs: Math.min(limited?.retryAfterMs ?? Number.POSITIVE_INFINITY, result.retryAfterMs ?? 5000) }
      if (result.kind === 'terminal')
        break
    }
    throw new PerceptionFailure(limited ? 'rate-limited' : 'provider-error', limited?.retryAfterMs)
  }

  private async attempt(candidate: Candidate, signal: AbortSignal): Promise<AttemptResult> {
    const { runtime } = this.options
    const { model } = candidate
    const apiKey = model.provider.keyRef ? runtime.providerKeys.get(model.provider.keyRef) : undefined
    const ticket = runtime.ledger.begin(model.scope, candidate.estimatedInputTokens)
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), runtime.config.routing.firstByteTimeoutMs)
    const combined = AbortSignal.any([signal, timeout.signal])
    const sentAt = performance.now()
    try {
      let response: Response
      try {
        response = await sendChatCompletion({
          provider: model.provider,
          apiKey,
          body: JSON.stringify({ ...(model.provider.compat === 'gemini' ? prepareGeminiRequest(candidate.body) : candidate.body), model: model.model }),
          signal: combined,
        })
      }
      catch {
        runtime.ledger.finish(ticket, { counted: false })
        if (signal.aborted)
          throw new PerceptionFailure('cancelled')
        runtime.health.recordFailure(model.id, timeout.signal.aborted ? 'timeout' : 'network')
        return { kind: 'failed' }
      }
      const observed = parseRateLimitHeaders(response.headers, runtime.now())
      if (observed)
        runtime.ledger.noteObserved(model.scope, observed)

      const raw = await readBounded(response, combined).catch(() => undefined)
      if (!response.ok) {
        runtime.ledger.finish(ticket, { counted: false })
        const failure = classifyUpstreamFailure(response.status, response.headers, raw ?? '', runtime.now())
        switch (failure.kind) {
          case 'rate-limited':
            runtime.ledger.noteRateLimit(model.scope, model.limits, failure)
            return { kind: 'rate-limited', retryAfterMs: failure.retryAfterMs }
          case 'server':
            runtime.health.recordFailure(model.id, 'server', failure.retryAfterMs)
            return { kind: 'failed' }
          case 'auth':
          case 'model-not-found':
            runtime.health.recordFailure(model.id, failure.kind)
            return { kind: 'failed' }
          case 'bad-request':
            return { kind: 'terminal' }
          default:
            return { kind: 'failed' }
        }
      }
      if (raw === undefined) {
        runtime.ledger.finish(ticket, { counted: true })
        if (signal.aborted)
          throw new PerceptionFailure('cancelled')
        runtime.health.recordFailure(model.id, timeout.signal.aborted ? 'timeout' : 'network')
        return { kind: 'failed' }
      }
      runtime.health.recordSuccess(model.id, Math.round(performance.now() - sentAt))
      const parsed = parseCompletion(raw)
      runtime.ledger.finish(ticket, { counted: true, inputTokens: parsed?.promptTokens, outputTokens: parsed?.completionTokens })
      if (parsed?.promptTokens)
        runtime.health.recordUsage(model.id, candidate.estimatedInputTokens, parsed.promptTokens)
      // A malformed body is a provider answer. The chain validates it and rejects it without another upload.
      return { kind: 'ok', content: parsed?.content ?? '' }
    }
    finally {
      clearTimeout(timer)
    }
  }
}

/** Reads a small response body. A body above the bound is cut off and fails JSON parsing. */
async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  const parts: Buffer[] = []
  let size = 0
  if (response.body) {
    for await (const chunk of response.body) {
      signal.throwIfAborted()
      size += chunk.byteLength
      if (size > MAX_RESPONSE_BYTES)
        break
      parts.push(Buffer.from(chunk))
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

function parseCompletion(raw: string): { content: string, promptTokens?: number, completionTokens?: number } | undefined {
  try {
    const value = JSON.parse(raw) as { choices?: { message?: { content?: unknown } }[], usage?: { prompt_tokens?: unknown, completion_tokens?: unknown } }
    const content = value.choices?.[0]?.message?.content
    return {
      content: typeof content === 'string' ? content : '',
      promptTokens: typeof value.usage?.prompt_tokens === 'number' ? value.usage.prompt_tokens : undefined,
      completionTokens: typeof value.usage?.completion_tokens === 'number' ? value.usage.completion_tokens : undefined,
    }
  }
  catch {
    return undefined
  }
}
