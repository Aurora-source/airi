import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { GatewayCredentials } from './auth/credentials'
import type { CompanionMemory } from './companion/memory'
import type { CompanionPerception } from './companion/perception'
import type { CompanionWatch } from './companion/watch'
import type { CompanionConfig } from './config/config'
import type { GatewayLogEvent } from './gateway/http'
import type { GatewayRuntimeOptions } from './gateway/runtime'
import type { TurnHooks } from './gateway/turn-hooks'

import process from 'node:process'

import { createServer } from 'node:http'

import { resolveAudioRoutes } from './audio/audio-config'
import { proxyTranscription } from './audio/transcriptions'
import { createBearerCheck } from './auth/credentials'
import { TURN_IDENTITY_HEADERS } from './companion/turn-identity'
import { LOOPBACK_HOST, servesChatCompletions } from './config/config'
import { proxyChatCompletion } from './gateway/chat-completions'
import { handleCompanionTool, handleOpsMemory, handleOpsPerception, handleOpsWatch } from './gateway/companion-api'
import { sendError } from './gateway/http'
import { opsStatus } from './gateway/ops-status'
import { GatewayRuntime } from './gateway/runtime'
import { createRedactor } from './logging/redact'
import { SYSTEM_OUTPUT_AUDIO_HEADER } from './watch'

/** Model tools for the MCP server, under the inference token. */
const COMPANION_TOOL_PREFIX = '/v1/companion/tools/'

/**
 * Request headers that a browser client can send in a CORS preflight. Anything else fails the preflight.
 * The AIRI turn identity headers carry ids only. Memory uses them to scope recall to the right character.
 */
const ALLOWED_REQUEST_HEADERS = new Set(['authorization', 'content-type', 'accept', ...TURN_IDENTITY_HEADERS])

/** The companion services next to the gateway. Without them the gateway only routes. */
export interface GatewayCompanion extends TurnHooks {
  memory?: CompanionMemory
  perception?: CompanionPerception
  watch?: CompanionWatch
}

export interface GatewayOptions {
  config: CompanionConfig
  credentials: GatewayCredentials
  /** Provider API keys by `keyRef`. */
  providerKeys: ReadonlyMap<string, string>
  /** Network boundary for audio providers. @default globalThis.fetch */
  audioFetch?: typeof fetch
  /** Receives one redacted line per request. Defaults to stderr. */
  writeLog?: (line: string) => void
  /** Capabilities that a probe measured, and a clock. Tests replace the clock. */
  runtime?: Pick<GatewayRuntimeOptions, 'capabilitiesOf' | 'now'>
  /** Memory, perception, and watch. The caller owns their lifecycle. */
  companion?: GatewayCompanion
  /** Folder for memory backups that Ops requests. */
  backupDirectory?: string
}

export interface RunningGateway {
  server: Server
  /** Base URL that clients configure, for example `http://127.0.0.1:11980/v1/`. */
  baseURL: string
  /** Router, quota ledger, and health. Perception attaches to it, so vision shares the chat routing state. */
  runtime: GatewayRuntime
  close: () => Promise<void>
}

/**
 * Starts the Companion Gateway on the loopback interface.
 *
 * Request policy, in order:
 * 1. `Host` must name this loopback listener. This blocks DNS-rebinding pages.
 * 2. A request with an `Origin` header must come from `config.allowedOrigins`, even when it has a valid token.
 * 3. `GET /livez` needs no token and reveals nothing but liveness.
 * 4. `/v1/*` needs the inference token. The ops token is rejected there. This includes the companion tools.
 * 5. `/ops/*` needs the ops token. The inference token is rejected there. This includes memory, perception, and watch administration.
 *
 * Call stack:
 *
 * {@link startGateway}
 *   -> handleRequest
 *     -> {@link proxyChatCompletion} (./gateway/chat-completions)
 */
export async function startGateway(options: GatewayOptions): Promise<RunningGateway> {
  const { config } = options
  const audioRoutes = resolveAudioRoutes(config)
  const redact = createRedactor([options.credentials.inference, options.credentials.ops, ...options.providerKeys.values()])
  const writeLog = options.writeLog ?? (line => process.stderr.write(`${line}\n`))
  const log = (event: GatewayLogEvent) => writeLog(redact(JSON.stringify({ time: new Date().toISOString(), ...event })))
  const isInferenceToken = createBearerCheck(options.credentials.inference)
  const isOpsToken = createBearerCheck(options.credentials.ops)
  const runtime = new GatewayRuntime({ config, providerKeys: options.providerKeys, ...options.runtime })
  const allowedOrigins = new Set(config.allowedOrigins)
  const companionApi = { memory: options.companion?.memory, perception: options.companion?.perception, watch: options.companion?.watch, backupDirectory: options.backupDirectory }

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
      if (await handleOpsMemory(req, res, path, companionApi) || await handleOpsPerception(req, res, path, companionApi) || await handleOpsWatch(req, res, path, companionApi)) {
        log({ method, path, status: res.statusCode, outcome: res.statusCode < 400 ? 'ok' : 'rejected', durationMs: Math.round(performance.now() - startedAt) })
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
      // `alias:model` names pin one model of a chat chain, which is how a user overrides the routing from AIRI's model list.
      // A speech-recognition alias has no pins, because its fallback rules are fixed.
      const ids = Object.entries(config.aliases).flatMap(([name, alias]) => [name, ...(servesChatCompletions(alias) ? alias.chain.map(model => `${name}:${model}`) : [])])
      const data = ids.map(id => ({ id, object: 'model', created: 0, owned_by: 'companion-core' }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data }))
      log({ method, path, status: 200, outcome: 'ok', durationMs: Math.round(performance.now() - startedAt) })
      return
    }

    if (method === 'POST' && path === '/v1/audio/transcriptions') {
      if (!audioRoutes)
        return reject(503, 'audio_not_configured', 'Audio transcription is not configured.')
      // A microphone upload means the user spoke, so watch stops pending reactions and audio work. Watch's own
      // system-output uploads carry a marker and never count.
      if (req.headers[SYSTEM_OUTPUT_AUDIO_HEADER] !== 'system-output')
        options.companion?.watch?.userSpeech()
      await proxyTranscription(req, res, { routes: audioRoutes, providerKeys: options.providerKeys, redact, log, transport: options.audioFetch })
      return
    }

    if (method === 'POST' && path === '/v1/chat/completions') {
      await proxyChatCompletion(req, res, { runtime, redact, log, turns: options.companion })
      return
    }

    if (method === 'POST' && path.startsWith(COMPANION_TOOL_PREFIX)) {
      await handleCompanionTool(req, res, path.slice(COMPANION_TOOL_PREFIX.length), companionApi)
      log({ method, path, status: res.statusCode, outcome: res.statusCode < 400 ? 'ok' : 'rejected', durationMs: Math.round(performance.now() - startedAt) })
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
    runtime,
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
