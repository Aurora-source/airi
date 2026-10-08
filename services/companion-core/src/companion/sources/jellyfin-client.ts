import type { HostLookup } from './network'

import { createHash } from 'node:crypto'

import { checkServer, readBounded } from './network'

/** Product name that Jellyfin shows for the Core's device in Dashboard > Devices. */
export const JELLYFIN_CLIENT = 'AIRI Companion'
const CLIENT_VERSION = '1.0.0'
const REQUEST_TIMEOUT_MS = 5000
/** One request body bound. A session list of one household fits easily. */
const MAX_BODY_BYTES = 2 * 1024 * 1024
/** Jellyfin access tokens are 32 hexadecimal characters. Other characters can break the header, so they are refused. */
const TOKEN = /^[\w-]{16,128}$/

/** Why a request did not return data. Codes only, so no URL, token, or body reaches a log. */
export type JellyfinFailure = 'unauthorized' | 'insecure-http' | 'unresolved' | 'redirect-refused' | 'body-too-large' | 'invalid-json' | 'unreachable' | 'timeout' | `http-${number}`

export type JellyfinReply<T> = { ok: true, data: T, serverDate?: number } | { ok: false, failure: JellyfinFailure }

/**
 * Deterministic device id of this Core for one machine. Jellyfin binds access tokens to a device, so the id must not
 * change between runs.
 *
 * @example
 * deviceIdOf('LUCIFER-PC')
 * // => 'airi-<32 hex characters>'
 */
export function deviceIdOf(hostname: string): string {
  return `airi-${createHash('sha256').update(`${hostname.toLowerCase()}|airi-companion-core`).digest('hex').slice(0, 32)}`
}

/** Normalizes a Jellyfin GUID, which appears with or without dashes. */
export function guidOf(value: unknown): string | undefined {
  if (typeof value !== 'string')
    return undefined
  const id = value.replace(/-/g, '').toLowerCase()
  return /^[0-9a-f]{32}$/.test(id) ? id : undefined
}

/**
 * Authenticated, read-only requests to one configured Jellyfin server.
 *
 * Security: the token goes only in the `Authorization` header, never in a URL. Paths are fixed strings with validated
 * ids, and the final URL must keep the configured origin. Redirects are refused, so a token cannot follow one to
 * another host. Plain http needs a host whose every address is private, checked before each request.
 */
export class JellyfinClient {
  readonly deviceId: string
  private readonly device: string

  constructor(private readonly options: { base: URL, token?: string, hostname: string, lookup: HostLookup }) {
    this.deviceId = deviceIdOf(options.hostname)
    this.device = options.hostname.replace(/[^\w.-]/g, '').slice(0, 64) || 'computer'
    if (options.token !== undefined && !TOKEN.test(options.token))
      throw new Error('The stored Jellyfin token has an invalid format.')
  }

  get hasToken(): boolean {
    return Boolean(this.options.token)
  }

  /** The `Authorization` header. Without a token it still names the client, as Quick Connect needs. */
  header(token = this.options.token): string {
    return `MediaBrowser Client="${JELLYFIN_CLIENT}", Device="${this.device}", DeviceId="${this.deviceId}", Version="${CLIENT_VERSION}"${token ? `, Token="${token}"` : ''}`
  }

  async get<T>(path: string, query: Record<string, string | number | boolean> = {}): Promise<JellyfinReply<T>> {
    return this.request<T>('GET', path, query)
  }

  async post<T>(path: string, body?: unknown, options: { token?: string | null } = {}): Promise<JellyfinReply<T>> {
    return this.request<T>('POST', path, {}, body, options.token)
  }

  private async request<T>(method: 'GET' | 'POST', path: string, query: Record<string, string | number | boolean>, body?: unknown, token?: string | null): Promise<JellyfinReply<T>> {
    const base = this.options.base
    const allowed = await checkServer(base, this.options.lookup)
    if (allowed !== 'ok')
      return { ok: false, failure: allowed }
    const url = new URL(path.replace(/^\//, ''), base)
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
      throw new Error('Jellyfin path left the configured server.')
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, String(value))
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers: { Authorization: this.header(token === null ? undefined : token ?? this.options.token), Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    }
    catch (error) {
      return { ok: false, failure: (error as Error).name === 'TimeoutError' ? 'timeout' : 'unreachable' }
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      return { ok: false, failure: 'redirect-refused' }
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel()
      return { ok: false, failure: 'unauthorized' }
    }
    if (!response.ok) {
      await response.body?.cancel()
      return { ok: false, failure: `http-${response.status}` }
    }
    const serverDate = Date.parse(response.headers.get('date') ?? '')
    let text: string
    try {
      text = await readBounded(response, MAX_BODY_BYTES)
    }
    catch {
      return { ok: false, failure: 'body-too-large' }
    }
    if (!text)
      return { ok: true, data: undefined as T, ...(Number.isFinite(serverDate) ? { serverDate } : {}) }
    try {
      return { ok: true, data: JSON.parse(text) as T, ...(Number.isFinite(serverDate) ? { serverDate } : {}) }
    }
    catch {
      return { ok: false, failure: 'invalid-json' }
    }
  }
}
