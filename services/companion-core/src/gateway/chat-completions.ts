import type { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { CompanionConfig } from '../config/config'
import type { GatewayLogEvent } from './http'

import { once } from 'node:events'

import { errorMessageFrom } from '@moeru/std'

import { sendChatCompletion } from '../providers/openai-compatible'
import { readRequestBody, RequestBodyTooLargeError, sendError } from './http'

/** Provider response headers that clients use. Length and encoding headers are not copied, because Node re-frames the body. */
const FORWARDED_RESPONSE_HEADERS = new Set(['content-type', 'cache-control', 'retry-after', 'x-request-id'])

interface ChatCompletionContext {
  config: CompanionConfig
  /** Provider API keys by `keyRef`. */
  providerKeys: ReadonlyMap<string, string>
  redact: (text: string) => string
  log: (event: GatewayLogEvent) => void
}

/**
 * Forwards one `POST /v1/chat/completions` request to the provider that its alias names.
 *
 * Transparency contract (R2A):
 * - The request body is forwarded with every field kept. Only `model` changes, from the alias to the configured model.
 * - The provider status, the useful headers, and the body bytes reach the client unchanged and unbuffered.
 *   Server-sent events, tool-call deltas, finish reasons, usage, and provider errors therefore pass through as sent.
 * - When the client disconnects before the response ends, the provider request is aborted.
 *
 * Call stack:
 *
 * handleRequest (../server)
 *   -> {@link proxyChatCompletion}
 *     -> {@link sendChatCompletion} (../providers/openai-compatible)
 */
export async function proxyChatCompletion(req: IncomingMessage, res: ServerResponse, context: ChatCompletionContext): Promise<void> {
  const startedAt = performance.now()
  const logBase = { method: 'POST', path: '/v1/chat/completions' }

  let raw: Buffer
  try {
    raw = await readRequestBody(req, context.config.maxRequestBytes)
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

  const aliasName = body.model
  const alias = context.config.aliases[aliasName]
  if (!alias) {
    sendError(res, 404, 'invalid_request_error', 'model_not_found', `Model "${aliasName}" is not a configured alias.`)
    context.log({ ...logBase, status: 404, outcome: 'rejected', reason: 'model_not_found', durationMs: elapsed(startedAt) })
    return
  }
  const provider = context.config.providers[alias.provider]
  const apiKey = context.providerKeys.get(provider.keyRef)
  if (!apiKey) {
    sendError(res, 503, 'server_error', 'provider_key_missing', `No API key is stored for provider "${alias.provider}".`)
    context.log({ ...logBase, status: 503, outcome: 'rejected', reason: 'provider_key_missing', alias: aliasName, durationMs: elapsed(startedAt) })
    return
  }

  // Abort the provider request as soon as the client goes away, whether before or during the response.
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished)
      controller.abort()
  })

  const log = (event: Omit<GatewayLogEvent, 'method' | 'path' | 'alias' | 'stream'>) => context.log({
    ...logBase,
    alias: aliasName,
    stream: body.stream === true,
    ...event,
  })

  let upstream: Response
  try {
    // Spread keeps the original key order. Overwriting `model` keeps its position.
    upstream = await sendChatCompletion({ provider, apiKey, body: JSON.stringify({ ...body, model: alias.model }), signal: controller.signal })
  }
  catch (error) {
    if (controller.signal.aborted) {
      log({ status: 499, outcome: 'cancelled', reason: 'client_closed_before_response', durationMs: elapsed(startedAt) })
      return
    }
    const message = context.redact(errorMessageFrom(error) ?? 'Provider request failed.')
    sendError(res, 502, 'upstream_error', 'provider_unreachable', `Provider "${alias.provider}" is unreachable: ${message}`)
    log({ status: 502, outcome: 'network_error', reason: message, durationMs: elapsed(startedAt) })
    return
  }

  const headers: Record<string, string> = {}
  upstream.headers.forEach((value, name) => {
    if (FORWARDED_RESPONSE_HEADERS.has(name) || name.startsWith('x-ratelimit-'))
      headers[name] = value
  })
  res.writeHead(upstream.status, headers)
  res.flushHeaders()

  let firstByteMs: number | undefined
  let bytesOut = 0
  try {
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        firstByteMs ??= elapsed(startedAt)
        bytesOut += chunk.byteLength
        // Respect backpressure instead of queueing the whole provider response in memory.
        if (!res.write(chunk))
          await once(res, 'drain', { signal: controller.signal })
      }
    }
    res.end()
    log({ status: upstream.status, outcome: upstream.ok ? 'ok' : 'upstream_error', firstByteMs, bytesOut, durationMs: elapsed(startedAt) })
  }
  catch (error) {
    if (controller.signal.aborted) {
      log({ status: upstream.status, outcome: 'cancelled', reason: 'client_closed_during_response', firstByteMs, bytesOut, durationMs: elapsed(startedAt) })
      return
    }
    // The provider broke the stream. Close the client connection the same way, so the client sees
    // an incomplete response, exactly as it would with a direct connection.
    res.destroy()
    log({ status: upstream.status, outcome: 'upstream_error', reason: context.redact(errorMessageFrom(error) ?? 'Provider stream failed.'), firstByteMs, bytesOut, durationMs: elapsed(startedAt) })
  }
}

function parseRequestBody(raw: Buffer): ({ model: string, stream?: unknown } & Record<string, unknown>) | undefined {
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
  return record as { model: string } & Record<string, unknown>
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}
