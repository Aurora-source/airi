import { describe, expect, it } from 'vitest'

import { checkServer, isPrivateAddress, serverBase } from '../../src/companion/sources/network'

describe('serverBase', () => {
  it('keeps scheme, host, port, and a base path, with a trailing slash', () => {
    expect(serverBase('https://media.example.com/jellyfin').href).toBe('https://media.example.com/jellyfin/')
    expect(serverBase('http://192.168.1.20:8096/').href).toBe('http://192.168.1.20:8096/')
  })

  it('refuses credentials, queries, fragments, and other schemes', () => {
    expect(() => serverBase('https://user:pass@media.example.com')).toThrow(/credentials/i)
    expect(() => serverBase('https://media.example.com/?api_key=x')).toThrow(/query/i)
    expect(() => serverBase('https://media.example.com/#x')).toThrow(/query/i)
    expect(() => serverBase('ftp://media.example.com')).toThrow(/http/i)
    expect(() => serverBase('not a url')).toThrow(/url/i)
  })
})

describe('isPrivateAddress', () => {
  it('accepts loopback, private, link-local, Tailscale, and unique local addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.5', '172.31.255.1', '192.168.1.20', '169.254.3.4', '100.64.0.1', '100.127.1.1', '::1', 'fd7a:115c:a1e0::1', 'fe80::1', '::ffff:192.168.1.2'])
      expect(isPrivateAddress(ip), ip).toBe(true)
  })

  it('refuses public addresses', () => {
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '1.1.1.1', '2001:4860:4860::8888', '::ffff:8.8.8.8'])
      expect(isPrivateAddress(ip), ip).toBe(false)
  })
})

describe('checkServer', () => {
  const lookup = (addresses: string[]) => async () => addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))

  it('allows https to any host without a lookup', async () => {
    await expect(checkServer(serverBase('https://media.example.com'), lookup(['8.8.8.8']))).resolves.toBe('ok')
  })

  it('allows plain http only when every address of the host is private', async () => {
    await expect(checkServer(serverBase('http://192.168.1.20:8096'), lookup([]))).resolves.toBe('ok')
    await expect(checkServer(serverBase('http://nas.lan:8096'), lookup(['192.168.1.20']))).resolves.toBe('ok')
    await expect(checkServer(serverBase('http://nas.tailnet.ts.net'), lookup(['100.101.102.103']))).resolves.toBe('ok')
    await expect(checkServer(serverBase('http://media.example.com'), lookup(['192.168.1.20', '8.8.8.8']))).resolves.toBe('insecure-http')
    await expect(checkServer(serverBase('http://8.8.8.8:8096'), lookup([]))).resolves.toBe('insecure-http')
  })

  it('treats a failed lookup as unreachable, not as allowed', async () => {
    await expect(checkServer(serverBase('http://nas.lan'), async () => {
      throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
    })).resolves.toBe('unresolved')
  })
})
