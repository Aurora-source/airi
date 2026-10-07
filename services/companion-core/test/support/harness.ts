import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { RunningGateway } from '../../src'

import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'

import { parseConfig, startGateway } from '../../src'

/** A request that the fake provider received. */
export interface ReceivedRequest {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
  /** Resolves when the gateway closes this request's connection, for example after a client abort. */
  closed: Promise<void>
}

export type ProviderHandler = (req: IncomingMessage, res: ServerResponse, received: ReceivedRequest) => void | Promise<void>

/**
 * Starts a local HTTP server that plays an OpenAI-compatible provider.
 *
 * Each test sets `handler` to script the provider response, including slow streams and broken connections.
 */
export async function startFakeProvider() {
  const requests: ReceivedRequest[] = []
  let handler: ProviderHandler = (_req, res) => {
    res.writeHead(500)
    res.end('no handler')
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    let markClosed: () => void = () => {}
    const closed = new Promise<void>(resolve => markClosed = resolve)
    res.on('close', () => markClosed())
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const received: ReceivedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        closed,
      }
      requests.push(received)
      void handler(req, res, received)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    baseURL: `http://127.0.0.1:${port}/v1/`,
    requests,
    setHandler: (next: ProviderHandler) => {
      handler = next
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

export const TEST_PROVIDER_KEY = 'AIzaTESTKEY0000000000000000000000000000'
export const TEST_INFERENCE_TOKEN = 'cc_inf_test-inference-token-0000000000000000'
export const TEST_OPS_TOKEN = 'cc_ops_test-ops-token-00000000000000000000000'
export const ALLOWED_ORIGIN = 'http://localhost:5173'

/** Starts a gateway on a free port that forwards alias `companion-chat` to `providerBaseURL`. Log lines are captured. */
export async function startTestGateway(providerBaseURL: string): Promise<{ gateway: RunningGateway, logs: string[] }> {
  const logs: string[] = []
  const config = parseConfig({
    port: 0,
    allowedOrigins: [ALLOWED_ORIGIN],
    providers: { fake: { baseURL: providerBaseURL, keyRef: 'provider-fake' } },
    aliases: { 'companion-chat': { provider: 'fake', model: 'real-model-1' } },
  })
  const gateway = await startGateway({
    config,
    credentials: { inference: TEST_INFERENCE_TOKEN, ops: TEST_OPS_TOKEN },
    providerKeys: new Map([['provider-fake', TEST_PROVIDER_KEY]]),
    writeLog: line => logs.push(line),
  })
  return { gateway, logs }
}

export function authHeaders(token = TEST_INFERENCE_TOKEN): Record<string, string> {
  return { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' }
}

/** Writes server-sent events one by one, waiting `delayMs` between writes, then ends the response. */
export async function writeEvents(res: ServerResponse, events: string[], delayMs = 0): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const event of events) {
    res.write(event)
    if (delayMs > 0)
      await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  res.end()
}

/** Reads a response body as raw bytes, recording when each chunk arrived. */
export async function readChunks(response: Response): Promise<{ bytes: Buffer, arrivals: number[] }> {
  const parts: Buffer[] = []
  const arrivals: number[] = []
  for await (const chunk of response.body!) {
    parts.push(Buffer.from(chunk))
    arrivals.push(performance.now())
  }
  return { bytes: Buffer.concat(parts), arrivals }
}

/** Formats one SSE `data:` event the way OpenAI-compatible providers send it. */
export function sse(data: unknown): string {
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
}
