import { Buffer } from 'node:buffer'
import { isIP } from 'node:net'

/** A host lookup that returns every address. `node:dns/promises` lookup with `all: true` has this shape. */
export type HostLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string, family: number }>>

/**
 * Validates a media server URL from the user's configuration and returns its base with a trailing slash.
 * Credentials, a query, or a fragment in the URL are refused, so no secret can hide in configuration or logs.
 *
 * @example
 * serverBase('https://media.example.com/jellyfin').href
 * // => 'https://media.example.com/jellyfin/'
 */
export function serverBase(input: string): URL {
  let url: URL
  try {
    url = new URL(input)
  }
  catch {
    throw new Error('The server URL is not a valid URL.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('The server URL must use http or https.')
  if (url.username || url.password)
    throw new Error('The server URL must not contain credentials. Store the token with companion-core instead.')
  if (url.search || url.hash || input.includes('#') || input.includes('?'))
    throw new Error('The server URL must not contain a query or fragment.')
  if (!url.pathname.endsWith('/'))
    url.pathname = `${url.pathname}/`
  return url
}

function ipv4Number(ip: string): number {
  return ip.split('.').reduce((value, part) => value * 256 + Number(part), 0)
}

function inRange(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0
  return ((ipv4Number(ip) & mask) >>> 0) === ((ipv4Number(base) & mask) >>> 0)
}

/**
 * Whether an address stays inside this machine or a private network: loopback, RFC 1918, link-local, the shared
 * address space that Tailscale uses (100.64.0.0/10), and IPv6 unique local and link-local addresses.
 */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4)
    return [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16], ['100.64.0.0', 10]].some(([base, bits]) => inRange(ip, base as string, bits as number))
  if (version !== 6)
    return false
  const lower = ip.toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped)
    return isPrivateAddress(mapped[1])
  if (lower === '::1')
    return true
  const first = Number.parseInt(lower.split(':')[0] || '0', 16)
  // fc00::/7 unique local, fe80::/10 link-local.
  return (first & 0xFE00) === 0xFC00 || (first & 0xFFC0) === 0xFE80
}

/**
 * Decides whether the Core can send a credential to the server.
 * - `ok`: https, or plain http to a host whose every address is private.
 * - `insecure-http`: plain http that can leave the private network. A token would cross it in clear text.
 * - `unresolved`: the host name did not resolve. Nothing is sent.
 */
export async function checkServer(base: URL, lookup: HostLookup): Promise<'ok' | 'insecure-http' | 'unresolved'> {
  if (base.protocol === 'https:')
    return 'ok'
  const host = base.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host))
    return isPrivateAddress(host) ? 'ok' : 'insecure-http'
  let addresses: ReadonlyArray<{ address: string }>
  try {
    addresses = await lookup(host)
  }
  catch {
    return 'unresolved'
  }
  if (addresses.length === 0)
    return 'unresolved'
  return addresses.every(entry => isPrivateAddress(entry.address)) ? 'ok' : 'insecure-http'
}

/** Reads at most `limit` bytes of a response body. A larger body throws, so a hostile peer cannot fill memory. */
export async function readBounded(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader)
    return ''
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done)
      break
    size += value.length
    if (size > limit) {
      await reader.cancel()
      throw new Error('body-too-large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}
