import type { IncomingMessage, ServerResponse } from 'node:http'

import type { GatewayLogEvent } from '../gateway/http'
import type { TranscriptionTarget } from '../providers/groq-transcription'
import type { AudioRoutes, TranscriptionModel } from './audio-config'

import { Buffer } from 'node:buffer'

import { sendError } from '../gateway/http'
import { createRedactor } from '../logging/redact'
import { sendTranscription } from '../providers/groq-transcription'
import { AudioRequestError, readUpload } from './multipart'

interface TranscriptionContext {
  routes: AudioRoutes
  providerKeys: ReadonlyMap<string, string>
  redact: (text: string) => string
  log: (event: GatewayLogEvent) => void
  transport?: typeof fetch
}

type RoutedTarget = TranscriptionTarget & Pick<TranscriptionModel, 'keyRef' | 'locality'>

/**
 * Owns one deadline and cancellation signal from upload through the complete provider response.
 * Each request keeps audio only in memory. The alias chain and the compute profile fix every target.
 * A cloud model moves on to the next cloud model only when its model is unavailable. A rate limit is returned.
 * A local model, which only a hybrid or local profile allows, handles rate limits, outages, and network failures.
 */
export async function proxyTranscription(req: IncomingMessage, res: ServerResponse, context: TranscriptionContext): Promise<void> {
  const startedAt = performance.now()
  const { limits } = context.routes
  const controller = new AbortController()
  let timedOut = false
  let alias: string | undefined
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, limits.timeoutMs)
  const clientClosed = () => {
    if (!res.writableFinished)
      controller.abort()
  }
  req.on('aborted', clientClosed)
  req.on('error', clientClosed)
  res.on('close', clientClosed)
  const log = (status: number, outcome: GatewayLogEvent['outcome'], reason?: string) => context.log({ method: 'POST', path: '/v1/audio/transcriptions', alias, status, outcome, reason, durationMs: Math.round(performance.now() - startedAt) })
  try {
    const upload = await readUpload(req, limits.maxRequestBytes, controller.signal, new Set(context.routes.aliases.keys()))
    alias = upload.alias
    const redactInput = createRedactor([upload.sourceFilename, ...(upload.prompt ? [upload.prompt] : [])])
    const targets = routingTargets(context.routes.aliases.get(upload.alias) ?? [], context.providerKeys)
    let response: Response | undefined
    let bytes: Buffer | undefined
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index]
      controller.signal.throwIfAborted()
      try {
        if (target.locality === 'local' && target.keyRef && !target.apiKey)
          throw new AudioRequestError(503, 'audio_provider_key_missing', 'The local audio API key is not configured.')
        response = await sendTranscription(target, upload, controller.signal, context.transport)
        bytes = await readResponse(response, limits.maxResponseBytes, controller.signal)
      }
      catch (error) {
        if (controller.signal.aborted || error instanceof AudioRequestError)
          throw error
        // A network failure moves only to a local model. It does not retry the same cloud service.
        const localIndex = targets.findIndex((next, position) => position > index && next.locality === 'local')
        if (localIndex >= 0) {
          index = localIndex - 1
          continue
        }
        throw new AudioRequestError(502, 'audio_provider_unreachable', 'The audio provider is unreachable.')
      }
      if (response.ok)
        break
      const next = targets[index + 1]
      if (!next)
        break
      const providerCode = errorFields(bytes).code
      const modelUnavailable = response.status === 503 || ([400, 404].includes(response.status) && ['model_not_found', 'model_not_available', 'unsupported_model'].includes(providerCode))
      const localFallback = next.locality === 'local' && (response.status === 429 || response.status >= 500 || modelUnavailable)
      if (next.locality === 'cloud' && !modelUnavailable) {
        // A rate limit is returned unless the chain holds a local model. No cloud quota is bypassed.
        const localIndex = targets.findIndex((candidate, position) => position > index && candidate.locality === 'local')
        if (localIndex >= 0 && (response.status === 429 || response.status >= 500)) {
          index = localIndex - 1
          continue
        }
        break
      }
      if (next.locality === 'local' && !localFallback)
        break
    }
    controller.signal.throwIfAborted()
    if (!response || !bytes)
      throw new AudioRequestError(502, 'audio_provider_unreachable', 'The audio provider is unreachable.')
    if (!response.ok) {
      const error = errorFields(bytes)
      const message = redactInput(context.redact(error.message)).replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 512)
      const sanitizedCode = redactInput(context.redact(error.code))
      const sanitizedType = redactInput(context.redact(error.type))
      const retryAfter = response.headers.get('retry-after')
      const headers: Record<string, string> = {}
      if (retryAfter && (/^\d{1,8}$/.test(retryAfter) || (retryAfter.length < 80 && Number.isFinite(Date.parse(retryAfter)))))
        headers['retry-after'] = retryAfter
      res.setHeader('access-control-expose-headers', 'retry-after')
      sendError(res, response.status, /^[\w-]{1,64}$/.test(sanitizedType) ? sanitizedType : 'upstream_error', /^[\w-]{1,64}$/.test(sanitizedCode) ? sanitizedCode : 'audio_provider_error', message, headers)
      log(response.status, 'upstream_error', 'audio_provider_error')
      return
    }
    if (upload.responseFormat !== 'text') {
      let value: unknown
      try {
        value = JSON.parse(bytes.toString('utf8'))
      }
      catch {
        throw new AudioRequestError(502, 'invalid_audio_response', 'The audio provider returned invalid JSON.')
      }
      if (!value || typeof value !== 'object' || typeof (value as Record<string, unknown>).text !== 'string')
        throw new AudioRequestError(502, 'invalid_audio_response', 'The audio provider response has no transcript.')
    }
    res.writeHead(200, { 'content-type': upload.responseFormat === 'text' ? 'text/plain; charset=utf-8' : 'application/json' })
    res.end(bytes)
    log(200, 'ok')
  }
  catch (error) {
    if (timedOut) {
      res.setHeader('connection', 'close')
      sendError(res, 504, 'upstream_error', 'audio_timeout', 'The audio request timed out.')
      log(504, 'upstream_error', 'audio_timeout')
    }
    else if (controller.signal.aborted) {
      log(499, 'cancelled', 'audio_client_closed')
    }
    else if (error instanceof AudioRequestError) {
      if (!req.complete)
        res.setHeader('connection', 'close')
      sendError(res, error.status, error.status < 500 ? 'invalid_request_error' : 'upstream_error', error.code, error.message)
      log(error.status, error.status < 500 ? 'rejected' : 'upstream_error', error.code)
    }
    else {
      sendError(res, 502, 'upstream_error', 'audio_request_failed', 'The audio request failed.')
      log(502, 'upstream_error', 'audio_request_failed')
    }
  }
  finally {
    clearTimeout(timeout)
    req.off('aborted', clientClosed)
    req.off('error', clientClosed)
    res.off('close', clientClosed)
  }
}

/** A cloud model without its key is skipped. A chain with nothing left is a visible configuration error. */
function routingTargets(chain: readonly TranscriptionModel[], providerKeys: ReadonlyMap<string, string>): RoutedTarget[] {
  const targets: RoutedTarget[] = []
  for (const model of chain) {
    const apiKey = model.keyRef ? providerKeys.get(model.keyRef) : undefined
    if (model.locality === 'cloud' && !apiKey)
      continue
    targets.push({ url: model.url, model: model.model, apiKey, keyRef: model.keyRef, locality: model.locality })
  }
  if (targets.length === 0)
    throw new AudioRequestError(503, 'audio_provider_key_missing', 'The cloud audio API key is not configured.')
  return targets
}

async function readResponse(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  if (!response.body)
    return Buffer.alloc(0)
  const reader = response.body.getReader()
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done)
        break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new AudioRequestError(502, 'audio_response_too_large', 'The audio provider response is too large.')
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, size)
  }
  finally {
    signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

function errorFields(bytes: Buffer): { message: string, code: string, type: string } {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  }
  catch {
    return { message: bytes.toString('utf8') || 'The audio provider rejected the request.', code: 'audio_provider_error', type: 'upstream_error' }
  }
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined
  const error = record?.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : undefined
  return {
    message: typeof error?.message === 'string' ? error.message : 'The audio provider rejected the request.',
    code: typeof error?.code === 'string' && /^[\w-]{1,64}$/.test(error.code) ? error.code : 'audio_provider_error',
    type: typeof error?.type === 'string' && /^[\w-]{1,64}$/.test(error.type) ? error.type : 'upstream_error',
  }
}
