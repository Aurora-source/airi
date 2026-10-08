import { describe, expect, it } from 'vitest'

import { allowedJellyfinOrigin, deviceIdOf, itemIdFromStream, originOf, videoIdOf } from './jellyfin'

describe('jellyfin page helpers', () => {
  it('normalizes the origin of an http or https page', () => {
    expect(originOf('https://media.example.com/web/#/video')).toBe('https://media.example.com')
    expect(originOf('http://192.168.1.20:8096/web/index.html')).toBe('http://192.168.1.20:8096')
    expect(originOf('chrome-extension://abc/popup.html')).toBeUndefined()
    expect(originOf('not a url')).toBeUndefined()
  })

  it('treats a page as Jellyfin only on an origin that the user allowed', () => {
    const allowed = ['https://media.example.com', 'http://nas.tailnet.ts.net:8096']
    expect(allowedJellyfinOrigin('https://media.example.com/web/#/home', allowed)).toBe(true)
    expect(allowedJellyfinOrigin('http://nas.tailnet.ts.net:8096/web/', allowed)).toBe(true)
    expect(allowedJellyfinOrigin('https://other.example.com/web/', allowed)).toBe(false)
    expect(allowedJellyfinOrigin('http://localhost:8096/web/', allowed)).toBe(false)
  })

  it('reads the item id from a stream path and never the query', () => {
    expect(itemIdFromStream('https://media.example.com/Videos/0123456789ABCDEF0123456789abcdef/stream.mkv?Static=true&api_key=secret')).toBe('0123456789abcdef0123456789abcdef')
    expect(itemIdFromStream('https://media.example.com/videos/0123456789abcdef0123456789abcdef/master.m3u8?api_key=secret')).toBe('0123456789abcdef0123456789abcdef')
    expect(itemIdFromStream('blob:https://media.example.com/5b1c')).toBeUndefined()
    expect(itemIdFromStream('https://media.example.com/stream?id=0123456789abcdef0123456789abcdef')).toBeUndefined()
  })

  it('accepts only device ids that the web client generates', () => {
    expect(deviceIdOf('TW96aWxsYS81LjAgfDE3MDAwMDAwMDAwMDA1')).toBe('TW96aWxsYS81LjAgfDE3MDAwMDAwMDAwMDA1')
    expect(deviceIdOf('bad id"')).toBeUndefined()
    expect(deviceIdOf(null)).toBeUndefined()
  })

  it('names the media by item id, or by title while the item id is unknown', () => {
    expect(videoIdOf('0123456789abcdef0123456789abcdef', 'Frieren')).toBe('0123456789abcdef0123456789abcdef')
    expect(videoIdOf(undefined, 'Sousou no Frieren')).toBe('t:Sousou no Frieren')
    expect(videoIdOf(undefined, '')).toBeUndefined()
  })
})
