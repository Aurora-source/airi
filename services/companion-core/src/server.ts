import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { AudioConfigInput } from './audio/audio-config'
import type { GatewayCredentials } from './auth/credentials'
import type { CompanionConfig } from './config/config'
import type { GatewayLogEvent } from './gateway/http'
import type { GatewayRuntimeOptions } from './gateway/runtime'

import process from 'node:process'

import { createServer } from 'node:http'

import { parseAudioConfig } from './audio/audio-config'
import { proxyTranscription } from './audio/transcriptions'
import { createBearerCheck } from './auth/credentials'
import { LOOPBACK_HOST } from './config/config'
import { proxyChatCompletion } from './gateway/chat-completions'
import { sendError } from './gateway/http'
import { opsStatus } from './gateway/ops-status'
import { GatewayRuntime } from './gateway/runtime'
import { createRedactor } from './logging/redact'

/** Request headers that a browser client can send in a CORS preflight. Anything else fails the preflight. */
const ALLOWED_REQUEST_HEADERS = new Set(['authorization', 'content-type', 'accept'])

export interface GatewayOptions {
  config: CompanionConfig
  credentials: GatewayCredentials
  /** Provider API keys by `keyRef`. */
  providerKeys: ReadonlyMap<string, string>
  /** Separate audio configuration. An absent value disables STT. */
  audioConfig?: AudioConfigInput
  /** Network boundary for audio providers. @default globalThis.fetch */
  audioFetch?: typeof fetch
  /** Receives one redacted line per request. Defaults to stderr. */
  writeLog?: (line: string) => void
  /** Capabilities that a probe measured, and a clock. Tests replace the clock. */
  runtime?: Pick<GatewayRuntimeOptions, 'capabilitiesOf' | 'now'>
}

export interface RunningGateway {
  server: Server
  /** Base URL that clients configure, for example `http://127.0.0.1:11980/v1/`. */
  baseURL: string
  close: () => Promise<void>
}

/**
 * Starts the Companion Gateway on the loopback interface.
 *
 * Request policy, in order:
 * 1. `Host` must name this loopback listener. This blocks DNS-rebinding pages.
 * 2. A request with an `Origin` header must come from `config.allowedOrigins`, even when it has a valid token.
 * 3. `GET /livez` needs no token and reveals nothing but liveness.
 * 4. `/v1/*` needs the inference token. The ops token is rejected there.
 * 5. `/ops/*` needs the ops token. The inference token is rejected there.
 *
 * Call stack:
 *
 * {@link startGateway}
 *   -> handleRequest
 *     -> {@link proxyChatCompletion} (./gateway/chat-completions)
 */
export async function startGateway(options: GatewayOptions): Promise<RunningGateway> {
  const { config } = options
  const audioConfig = options.audioConfig === undefined ? undefined : parseAudioConfig(options.audioConfig)
  const redact = createRedactor([options.credentials.inference, options.credentials.ops, ...options.providerKeys.values()])
  const writeLog = options.writeLog ?? (line => process.stderr.write(`${line}\n`))
  const log = (event: GatewayLogEvent) => writeLog(redact(JSON.stringify({ time: new Date().toISOString(), ...event })))
  const isInferenceToken = createBearerCheck(options.credentials.inference)
  const isOpsToken = createBearerCheck(options.credentials.ops)
  const runtime = new GatewayRuntime({ config, providerKeys: options.providerKeys, ...options.runtime })
  const allowedOrigins = new Set(config.allowedOrigins)

  let allowedHosts = new Set<string>()

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      sendError(res, 500, 'server_error', 'internal_error', 'Internal gateway error.')
      log({ method: req.method ?? '', path: pathOf(req), status: 500, outcome: 'rejected', reason: redact(String(error)), durationMs: 0 })
    })
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = performance.now()
    const method = req.method ?? ''
    const path = pathOf(req)
    const reject = (status: number, code: string, message: string, headers?: Record<string, string>) => {
      sendError(res, status, status === 401 ? 'authentication_error' : 'invalid_request_error', code, message, headers)
      log({ method, path, status, outcome: 'rejected', reason: code, durationMs: Math.round(performance.now() - startedAt) })
    }

    // Small chunks, such as single SSE events, must leave without Nagle delay.
    req.socket.setNoDelay(true)

    if (!allowedHosts.has(req.headers.host ?? ''))
      return reject(421, 'invalid_host', 'Host header does not match this gateway.')

    const origin = req.headers.origin
    if (origin !== undefined) {
      if (!allowedOrigins.has(origin))
        return reject(403, 'origin_not_allowed', 'Origin is not allowed.')
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'Origin')
    }

    if (method === 'OPTIONS') {
      if (origin === undefined)
        return reject(400, 'not_a_preflight', 'OPTIONS is only for CORS preflight requests.')
      const requested = String(req.headers['access-control-request-headers'] ?? '')
        .split(',')
        .map(header => header.trim().toLowerCase())
        .filter(Boolean)
      if (!requested.every(header => ALLOWED_REQUEST_HEADERS.has(header)))
        return reject(403, 'header_not_allowed', 'A requested header is not allowed.')
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': [...ALLOWED_REQUEST_HEADERS].join(', '),
        'access-control-max-age': '600',
      })
      res.end()
      return
    }

    if (method === 'GET' && path === '/livez') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }

    if (path.startsWith('/ops/')) {
      if (!isOpsToken(req.headers.authorization))
        return reject(401, 'invalid_token', 'A valid ops token is required.', { 'www-authenticate': 'Bearer' })
      if (method === 'GET' && path === '/ops/status') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(opsStatus(runtime)))
        log({ method, path, status: 200, outcome: 'ok', durationMs: Math.round(performance.now() - startedAt) })
        return
      }
      return reject(404, 'not_found', 'Not found.')
    }

    if (!path.startsWith('/v1/'))
      return reject(404, 'not_found', 'Not found.')

    if (!isInferenceToken(req.headers.authorization))
      return reject(401, 'invalid_token', 'A valid inference token is required.', { 'www-authenticate': 'Bearer' })

    if (method === 'GET' && path === '/v1/models') {
      // AIRI lists models when it validates the provider and when the user picks a model.
      // `alias:model` names pin one model of the chain, which is how a user overrides the routing from AIRI's model list.
      const ids = Object.entries(config.aliases).flatMap(([name, alias]) => [name, ...alias.chain.map(model => `${name}:${model}`)])
      const data = ids.map(id => ({ id, object: 'model', created: 0, owned_by: 'companion-core' }))
      if (audioConfig && !data.some(model => model.id === 'companion-stt'))
        data.push({ id: 'companion-stt', object: 'model', created: 0, owned_by: 'companion-core' })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data }))
      log({ method, path, status: 200, outcome: 'ok', durationMs: Math.round(performance.now() - startedAt) })
      return
    }

    if (method === 'POST' && path === '/v1/audio/transcriptions') {
      if (!audioConfig)
        return reject(503, 'audio_not_configured', 'Audio transcription is not configured.')
      await proxyTranscription(req, res, { config: audioConfig, providerKeys: options.providerKeys, redact, log, transport: options.audioFetch })
      return
    }

    if (method === 'POST' && path === '/v1/chat/completions') {
      await proxyChatCompletion(req, res, { runtime, redact, log })
      return
    }

    return reject(404, 'not_found', 'Not found.')
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, LOOPBACK_HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const { port } = server.address() as AddressInfo
  allowedHosts = new Set([`${LOOPBACK_HOST}:${port}`, `localhost:${port}`])

  return {
    server,
    baseURL: `http://${LOOPBACK_HOST}:${port}/v1/`,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => {
        runtime.close()
        if (error)
          reject(error)
        else
          resolve()
      })
    }),
  }
}

function pathOf(req: IncomingMessage): string {
  return (req.url ?? '/').split('?')[0]
}
