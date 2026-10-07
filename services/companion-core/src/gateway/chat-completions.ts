import type { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ReadableStreamReadResult } from 'node:stream/web'

import type { WireRequest } from '../budget/wire'
import type { Candidate } from '../routing/eligibility'
import type { RouteError } from '../routing/router'
import type { GatewayLogEvent } from './http'
import type { GatewayRuntime } from './runtime'

import { Buffer as NodeBuffer } from 'node:buffer'
import { once } from 'node:events'

import { errorMessageFrom } from '@moeru/std'

import { promptTokensOf } from '../budget/budgeter'
import { createGeminiToolCallIndexer, prepareGeminiRequest } from '../providers/gemini-compat'
import { sendChatCompletion } from '../providers/openai-compatible'
import { createUsageSniffer } from '../providers/usage-sniffer'
import { classifyUpstreamFailure, parseRateLimitHeaders } from '../quota/rate-limit'
import { readRequestBody, RequestBodyTooLargeError, sendError } from './http'

/** Provider response headers that clients use. Length and encoding headers are not copied, because Node re-frames the body. */
const FORWARDED_RESPONSE_HEADERS = new Set(['content-type', 'cache-control', 'retry-after', 'x-request-id'])
/** A failed provider response is kept to pass it on when no other model can answer. Error bodies are small. */
const MAX_CAPTURED_BYTES = 64 * 1024

interface ChatCompletionContext {
  runtime: GatewayRuntime
  redact: (text: string) => string
  log: (event: GatewayLogEvent) => void
}

/** A failed provider response, kept byte for byte. */
interface CapturedResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

type AttemptOutcome
  = | { kind: 'committed' }
    /** The client went away. Nothing is left to answer. */
    | { kind: 'client-gone' }
    /** The request itself is wrong, so another model would fail the same way. The provider's answer goes to the client as it is. */
    | { kind: 'terminal', response: CapturedResponse }
    | { kind: 'failed', response?: CapturedResponse }

interface Attempt {
  runtime: GatewayRuntime
  context: ChatCompletionContext
  res: ServerResponse
  clientSignal: AbortSignal
  startedAt: number
  /** Filled while the gateway works. It becomes the `attempts` of the log line and of the diagnostic header. */
  attempts: string[]
  skipped: string[]
  alias: string
  pinned?: string
  conversationKey: string
  stickyModelId?: string
  stream: boolean
}

/**
 * Serves one `POST /v1/chat/completions` request through the router.
 *
 * Transparency contract, which R2A proved and routing keeps:
 * - The request body is forwarded with every field kept. Only `model` changes, and the history is trimmed only when the
 *   model needs it.
 * - The provider status, the useful headers, and the body bytes reach the client unchanged and unbuffered.
 * - When the client disconnects before the response ends, the provider request is aborted.
 *
 * Routing contract:
 * - The router names the models that can take the request. The gateway tries them in order.
 * - A model that fails before the client received a byte is replaced by the next one. That covers a network error,
 *   a timeout, a rate limit, a server error, and an unusable key or model.
 * - After the first byte has gone to the client, the answer belongs to that model. If its stream breaks, the client sees
 *   the break. The gateway never continues an answer with another model.
 * - A request error from the provider (HTTP 400 without a size problem) goes to the client unchanged, because another model fails the same way.
 *
 * Call stack:
 *
 * handleRequest (../server)
 *   -> {@link proxyChatCompletion}
 *     -> Router.plan (../routing/router)
 *     -> attemptCandidate
 *       -> {@link sendChatCompletion} (../providers/openai-compatible)
 */
export async function proxyChatCompletion(req: IncomingMessage, res: ServerResponse, context: ChatCompletionContext): Promise<void> {
  const startedAt = performance.now()
  const logBase = { method: 'POST', path: '/v1/chat/completions' }
  const { runtime } = context

  let raw: Buffer
  try {
    raw = await readRequestBody(req, runtime.config.maxRequestBytes)
  }
  catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendError(res, 413, 'invalid_request_error', 'request_too_large', 'Request body is too large.')
      context.log({ ...logBase, status: 413, outcome: 'rejected', reason: 'request_too_large', durationMs: elapsed(startedAt) })
      return
    }
    // The client closed the connection while the body was still arriving.
    context.log({ ...logBase, status: 499, outcome: 'cancelled', reason: 'request_body_aborted', durationMs: elapsed(startedAt) })
    return
  }

  const body = parseRequestBody(raw)
  if (!body) {
    sendError(res, 400, 'invalid_request_error', 'invalid_json', 'Request body must be a JSON object with a string "model" field.')
    context.log({ ...logBase, status: 400, outcome: 'rejected', reason: 'invalid_json', durationMs: elapsed(startedAt) })
    return
  }

  const plan = runtime.router.plan(body)
  if (!plan.ok) {
    sendRouteError(res, plan.error)
    const skipped = plan.error.skipped.map(skip => `${skip.modelId}=${skip.reason}`)
    context.log({ ...logBase, alias: body.model, status: plan.error.status, outcome: 'rejected', reason: plan.error.code, skipped, stream: body.stream === true, durationMs: elapsed(startedAt) })
    runtime.recordRoute({ at: new Date().toISOString(), alias: body.model, attempts: [], skipped, status: plan.error.status })
    return
  }

  // Abort the provider request as soon as the client goes away, whether before or during the response.
  const clientController = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished)
      clientController.abort()
  })

  const attempt: Attempt = {
    runtime,
    context,
    res,
    clientSignal: clientController.signal,
    startedAt,
    attempts: [],
    skipped: plan.skipped.map(skip => `${skip.modelId}=${skip.reason}`),
    alias: plan.alias,
    pinned: plan.pinned,
    conversationKey: plan.conversationKey,
    stickyModelId: plan.stickyModelId,
    stream: body.stream === true,
  }

  let lastResponse: CapturedResponse | undefined
  for (const candidate of plan.candidates) {
    const outcome = await attemptCandidate(candidate, attempt)
    if (outcome.kind === 'committed' || outcome.kind === 'client-gone')
      return
    if (outcome.response)
      lastResponse = outcome.response
    if (outcome.kind === 'terminal')
      break
  }

  // No model answered. Pass the provider's own error on when there is one, so that the client sees what a direct connection shows.
  const failed = attempt.attempts.join(', ')
  if (lastResponse) {
    res.writeHead(lastResponse.status, { ...lastResponse.headers, ...diagnosticHeaders(undefined, undefined, attempt) })
    res.end(lastResponse.body)
  }
  else {
    sendError(res, 502, 'upstream_error', 'provider_unreachable', `No provider answered. Tried: ${failed}.`, diagnosticHeaders(undefined, undefined, attempt))
  }
  const status = lastResponse?.status ?? 502
  context.log({ ...logBase, alias: plan.alias, status, outcome: lastResponse ? 'upstream_error' : 'network_error', reason: failed, attempts: attempt.attempts, skipped: attempt.skipped, stream: attempt.stream, durationMs: elapsed(startedAt) })
  runtime.recordRoute({ at: new Date().toISOString(), alias: plan.alias, pinned: plan.pinned, attempts: attempt.attempts, skipped: attempt.skipped, status })
}

/**
 * Sends the request to one candidate. It stays undecided until the first response byte is in hand.
 * Failing before that point returns `failed`, and the caller tries the next candidate. Writing that byte commits the answer to this model.
 */
async function attemptCandidate(candidate: Candidate, attempt: Attempt): Promise<AttemptOutcome> {
  const { runtime, context, res, clientSignal, startedAt } = attempt
  const { model } = candidate
  const apiKey = model.provider.keyRef ? runtime.providerKeys.get(model.provider.keyRef) : undefined
  const logBase = { method: 'POST', path: '/v1/chat/completions', alias: attempt.alias, model: model.id, tier: candidate.tier, stream: attempt.stream }
  const tokens = tokenCounts(candidate)

  const ticket = runtime.ledger.begin(model.scope, candidate.estimatedInputTokens)
  const sentAt = performance.now()
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), runtime.config.routing.firstByteTimeoutMs)
  const signal = AbortSignal.any([clientSignal, timeout.signal])
  const note = (label: string) => attempt.attempts.push(`${model.id}=${label}`)

  /** A failure before any byte reached the client. The model rests, and the next candidate takes over. */
  const failBeforeOutput = (label: 'network' | 'timeout', error: unknown): AttemptOutcome => {
    clearTimeout(timer)
    runtime.ledger.finish(ticket, { counted: false })
    runtime.health.recordFailure(model.id, label)
    note(label)
    context.log({ ...logBase, status: 502, outcome: 'network_error', reason: `${label}: ${context.redact(errorMessageFrom(error) ?? 'request failed')}`, tokens, durationMs: elapsed(startedAt) })
    return { kind: 'failed' }
  }
  const clientGone = (reason: string): AttemptOutcome => {
    clearTimeout(timer)
    runtime.ledger.finish(ticket, { counted: false })
    note('cancelled')
    context.log({ ...logBase, status: 499, outcome: 'cancelled', reason, tokens, durationMs: elapsed(startedAt) })
    return { kind: 'client-gone' }
  }

  let upstream: Response
  try {
    upstream = await sendChatCompletion({
      provider: model.provider,
      apiKey,
      // Spread keeps the original key order. Overwriting `model` keeps its position.
      body: JSON.stringify({ ...(model.provider.compat === 'gemini' ? prepareGeminiRequest(candidate.body) : candidate.body), model: model.model }),
      signal,
    })
  }
  catch (error) {
    if (clientSignal.aborted)
      return clientGone('client_closed_before_response')
    return failBeforeOutput(timeout.signal.aborted ? 'timeout' : 'network', error)
  }

  const observed = parseRateLimitHeaders(upstream.headers, runtime.now())
  if (observed)
    runtime.ledger.noteObserved(model.scope, observed)

  if (!upstream.ok) {
    let captured: CapturedResponse
    try {
      captured = await captureResponse(upstream, signal)
    }
    catch (error) {
      if (clientSignal.aborted)
        return clientGone('client_closed_before_response')
      return failBeforeOutput(timeout.signal.aborted ? 'timeout' : 'network', error)
    }
    clearTimeout(timer)
    runtime.ledger.finish(ticket, { counted: false })
    const failure = classifyUpstreamFailure(upstream.status, upstream.headers, captured.body.toString('utf8'), runtime.now())
    note(failure.kind)
    context.log({ ...logBase, status: upstream.status, outcome: 'upstream_error', reason: failure.kind, tokens, durationMs: elapsed(startedAt) })

    switch (failure.kind) {
      case 'rate-limited':
        runtime.ledger.noteRateLimit(model.scope, model.limits, failure)
        break
      case 'server':
        runtime.health.recordFailure(model.id, 'server', failure.retryAfterMs)
        break
      case 'auth':
        runtime.health.recordFailure(model.id, 'auth')
        break
      case 'model-not-found':
        runtime.health.recordFailure(model.id, 'model-not-found')
        break
      case 'bad-request':
        return { kind: 'terminal', response: captured }
      default:
        // A size problem that the preflight could not predict. The next model can take the request.
        break
    }
    return { kind: 'failed', response: captured }
  }

  // Stream repair is provider-scoped and touches only successful event streams. Errors and JSON bodies stay byte-exact.
  const contentType = upstream.headers.get('content-type') ?? ''
  const repairsStream = model.provider.compat === 'gemini' && contentType.includes('text/event-stream')
  const sniffer = createUsageSniffer(contentType)
  const source = repairsStream && upstream.body ? upstream.body.pipeThrough(createGeminiToolCallIndexer()) : upstream.body
  const reader = source?.pipeThrough(sniffer.stream).getReader()

  let first: ReadableStreamReadResult<Uint8Array> | undefined
  try {
    first = await reader?.read()
  }
  catch (error) {
    if (clientSignal.aborted)
      return clientGone('client_closed_before_response')
    return failBeforeOutput(timeout.signal.aborted ? 'timeout' : 'network', error)
  }
  clearTimeout(timer)

  // Commit point. From here on, this model owns the answer and no other model continues it.
  const firstByteMs = Math.round(performance.now() - sentAt)
  runtime.health.recordSuccess(model.id, firstByteMs)
  if (!attempt.pinned) {
    const reason = attempt.attempts.length > 0
      ? `failover:${attempt.attempts[0].split('=')[1]}`
      : attempt.stickyModelId && attempt.stickyModelId !== model.id ? 'rerouted' : 'served'
    runtime.sticky.set(attempt.alias, attempt.conversationKey, model.id, reason)
  }
  note('ok')

  const headers: Record<string, string> = {}
  upstream.headers.forEach((value, name) => {
    if (FORWARDED_RESPONSE_HEADERS.has(name) || name.startsWith('x-ratelimit-'))
      headers[name] = value
  })
  Object.assign(headers, diagnosticHeaders(model.id, candidate.tier, attempt))
  res.writeHead(upstream.status, headers)
  res.flushHeaders()

  const route = {
    at: new Date().toISOString(),
    alias: attempt.alias,
    pinned: attempt.pinned,
    modelId: model.id,
    tier: candidate.tier,
    attempts: attempt.attempts,
    skipped: attempt.skipped,
    prompt: candidate.diagnostics,
    status: upstream.status,
    firstByteMs,
  }
  let bytesOut = 0
  try {
    if (reader && first && !first.done) {
      bytesOut += first.value.byteLength
      if (!res.write(first.value))
        await once(res, 'drain', { signal: clientSignal })
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        bytesOut += next.value.byteLength
        // Respect backpressure instead of queueing the whole provider response in memory.
        if (!res.write(next.value))
          await once(res, 'drain', { signal: clientSignal })
      }
    }
    res.end()
  }
  catch (error) {
    const usage = sniffer.usage()
    if (clientSignal.aborted) {
      runtime.ledger.finish(ticket, { counted: true, inputTokens: usage?.promptTokens, outputTokens: usage?.completionTokens })
      context.log({ ...logBase, status: upstream.status, outcome: 'cancelled', reason: 'client_closed_during_response', attempts: attempt.attempts, tokens, firstByteMs: elapsed(startedAt), bytesOut, durationMs: elapsed(startedAt) })
      return { kind: 'client-gone' }
    }
    // The provider broke the stream. Close the client connection the same way, so the client sees
    // an incomplete response, exactly as it would with a direct connection.
    res.destroy()
    runtime.ledger.finish(ticket, { counted: true })
    runtime.health.recordFailure(model.id, 'network')
    context.log({ ...logBase, status: upstream.status, outcome: 'upstream_error', reason: `stream_broke: ${context.redact(errorMessageFrom(error) ?? 'provider stream failed')}`, attempts: attempt.attempts, tokens, firstByteMs: elapsed(startedAt), bytesOut, durationMs: elapsed(startedAt) })
    runtime.recordRoute(route)
    return { kind: 'committed' }
  }

  const usage = sniffer.usage()
  runtime.ledger.finish(ticket, { counted: true, inputTokens: usage?.promptTokens, outputTokens: usage?.completionTokens })
  if (usage?.promptTokens)
    runtime.health.recordUsage(model.id, candidate.estimatedInputTokens, usage.promptTokens)
  context.log({ ...logBase, status: upstream.status, outcome: 'ok', attempts: attempt.attempts, skipped: attempt.skipped, tokens, firstByteMs: elapsed(startedAt), bytesOut, durationMs: elapsed(startedAt) })
  runtime.recordRoute(route)
  return { kind: 'committed' }
}

/** Reads a failed provider response, up to a small limit, and keeps the headers that clients use. */
async function captureResponse(response: Response, signal: AbortSignal): Promise<CapturedResponse> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    if (FORWARDED_RESPONSE_HEADERS.has(name) || name.startsWith('x-ratelimit-'))
      headers[name] = value
  })
  const parts: Buffer[] = []
  let size = 0
  if (response.body) {
    for await (const chunk of response.body) {
      signal.throwIfAborted()
      parts.push(NodeBuffer.from(chunk))
      size += chunk.byteLength
      if (size >= MAX_CAPTURED_BYTES)
        break
    }
  }
  return { status: response.status, headers, body: NodeBuffer.concat(parts) }
}

/**
 * Diagnostic response headers: which model answered, and what the gateway tried and skipped.
 * They hold model ids and reasons only. A client that does not know them ignores them.
 */
function diagnosticHeaders(modelId: string | undefined, tier: string | undefined, attempt: Attempt): Record<string, string> {
  const headers: Record<string, string> = {}
  if (modelId)
    headers['x-companion-model'] = headerSafe(modelId)
  if (tier)
    headers['x-companion-tier'] = tier
  if (attempt.attempts.length > 0)
    headers['x-companion-attempts'] = headerSafe(attempt.attempts.join(','))
  if (attempt.skipped.length > 0)
    headers['x-companion-skipped'] = headerSafe(attempt.skipped.join(','))
  return headers
}

function headerSafe(text: string): string {
  return text.replace(/[^\w.:=,\- /]/g, '_')
}

function tokenCounts(candidate: Candidate): NonNullable<GatewayLogEvent['tokens']> {
  const { diagnostics } = candidate
  return {
    system: diagnostics.systemTokens,
    conversation: diagnostics.conversationTokens,
    tools: diagnostics.toolSchemaTokens,
    output: diagnostics.estimatedOutputTokens,
    total: promptTokensOf(diagnostics) + diagnostics.estimatedOutputTokens,
  }
}

function sendRouteError(res: ServerResponse, error: RouteError): void {
  const headers: Record<string, string> = {}
  if (error.retryAfterMs !== undefined)
    headers['retry-after'] = String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)))
  if (error.skipped.length > 0)
    headers['x-companion-skipped'] = headerSafe(error.skipped.map(skip => `${skip.modelId}=${skip.reason}`).join(','))
  const type = error.status === 429 ? 'rate_limit_error' : error.status === 503 ? 'server_error' : 'invalid_request_error'
  sendError(res, error.status, type, error.code, error.message, headers)
}

function parseRequestBody(raw: Buffer): WireRequest | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  }
  catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.model !== 'string')
    return undefined
  return record as WireRequest
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}
