import type { IncomingMessage, ServerResponse } from 'node:http'

import { Buffer } from 'node:buffer'

/**
 * One structured log record per request.
 *
 * It holds metadata only. Headers, bodies, prompts, images, and credentials are never logged.
 */
export interface GatewayLogEvent {
  method: string
  path: string
  status: number
  outcome: 'ok' | 'rejected' | 'cancelled' | 'upstream_error' | 'network_error'
  reason?: string
  alias?: string
  /** The model that answered, as a key of `models`. */
  model?: string
  /** `full` or `first-round-only`. See the eligibility preflight. */
  tier?: string
  /** One `model=outcome` entry per model that the gateway tried, in order. */
  attempts?: string[]
  /** One `model=reason` entry per model that the preflight skipped before sending. */
  skipped?: string[]
  /** Estimated prompt size by part, in tokens. Counts only. */
  tokens?: { system: number, conversation: number, tools: number, memory?: number, awareness?: number, output: number, total: number }
  stream?: boolean
  /** The thinking effort that the Gateway sent, and who chose it, for example `low (selection)`. */
  effort?: string
  /** Milliseconds from request start to the first provider body byte. */
  firstByteMs?: number
  bytesOut?: number
  durationMs: number
}

export class RequestBodyTooLargeError extends Error {}

/** Sends an error in the OpenAI error shape, so OpenAI-compatible clients show the message. */
export function sendError(res: ServerResponse, status: number, type: string, code: string, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { ...headers, 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message, type, code } }))
}

/** Reads the whole request body. Rejects with {@link RequestBodyTooLargeError} after `limit` bytes. */
export function readRequestBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > limit) {
        req.pause()
        reject(new RequestBodyTooLargeError(`Request body exceeds ${limit} bytes.`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('Request aborted.')))
  })
}
