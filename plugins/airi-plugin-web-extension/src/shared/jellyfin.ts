/** A Jellyfin stream path names its library item. Query parameters, which can hold `api_key`, are never read. */
const STREAM_ITEM = /^\/(?:[^/?#]+\/)*videos\/([0-9a-f]{32})\//i
/** Device ids that jellyfin-web generates: base64 text with `=` replaced. */
const DEVICE_ID = /^[\w=+/.-]{1,256}$/

/**
 * The origin of an http or https page, or `undefined` for any other URL.
 *
 * @example
 * originOf('https://media.example.com/web/#/video')
 * // => 'https://media.example.com'
 */
export function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined
  }
  catch {
    return undefined
  }
}

/**
 * Whether the page is on an origin that the user allowed as Jellyfin in the popup. No host name is guessed, so a
 * server behind a reverse proxy, a private name, or a Tailscale name works the same way.
 */
export function allowedJellyfinOrigin(url: string, allowed: readonly string[]): boolean {
  const origin = originOf(url)
  return origin !== undefined && allowed.includes(origin)
}

/**
 * The library item id in the path of a Jellyfin stream URL. Blob URLs of transcoded streams give none.
 *
 * @example
 * itemIdFromStream('https://media.example.com/Videos/0123456789abcdef0123456789abcdef/stream.mkv?api_key=x')
 * // => '0123456789abcdef0123456789abcdef'
 */
export function itemIdFromStream(src: string): string | undefined {
  try {
    const parsed = new URL(src)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return undefined
    return STREAM_ITEM.exec(parsed.pathname)?.[1]?.toLowerCase()
  }
  catch {
    return undefined
  }
}

/** The web client's device id, when it has the expected shape. */
export function deviceIdOf(value: string | null | undefined): string | undefined {
  return value && DEVICE_ID.test(value) ? value : undefined
}

/**
 * The media name that the stamp and AIRI's Core use. The item id is exact. A title stands in until the item id is
 * known, and AIRI matches the page with its server session by device id anyway.
 */
export function videoIdOf(itemId: string | undefined, title: string): string | undefined {
  if (itemId)
    return itemId
  return title ? `t:${title}`.slice(0, 120) : undefined
}
