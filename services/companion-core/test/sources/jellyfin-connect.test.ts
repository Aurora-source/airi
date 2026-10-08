import { afterEach, describe, expect, it } from 'vitest'

import { JellyfinClient } from '../../src/companion/sources/jellyfin-client'
import { quickConnect } from '../../src/companion/sources/jellyfin-connect'
import { serverBase } from '../../src/companion/sources/network'
import { FakeJellyfin, TOKEN } from '../support/fake-jellyfin'

let jellyfin: FakeJellyfin | undefined

afterEach(async () => {
  await jellyfin?.close()
  jellyfin = undefined
})

async function client() {
  jellyfin = new FakeJellyfin()
  const base = await jellyfin.listen()
  return new JellyfinClient({ base: serverBase(base), hostname: 'LIVING-PC', lookup: async () => [] })
}

describe('quickConnect', () => {
  it('shows the code, waits for approval, and returns the user token', async () => {
    const jellyfinClient = await client()
    const codes: string[] = []
    let polls = 0
    const result = await quickConnect(jellyfinClient, {
      show: code => codes.push(code),
      now: Date.now,
      sleep: async () => {
        polls++
        if (polls === 2)
          jellyfin!.quickConnect = 'approved'
      },
    })
    expect(codes).toEqual(['123456'])
    expect(result).toEqual({ token: TOKEN, user: 'viewer', admin: false })
    // No request carried a password, and no request before the exchange carried a token.
    expect(jellyfin!.requests.every(request => !/pw|password/i.test(request.url))).toBe(true)
    expect(jellyfin!.requests.every(request => !request.authorization?.includes('Token='))).toBe(true)
  })

  it('stops when Quick Connect is off on the server', async () => {
    const jellyfinClient = await client()
    jellyfin!.quickConnect = 'off'
    await expect(quickConnect(jellyfinClient, { show: () => {}, now: Date.now, sleep: async () => {} })).rejects.toThrow(/Quick Connect is off/)
  })

  it('times out when nobody approves the code', async () => {
    const jellyfinClient = await client()
    let clock = 0
    await expect(quickConnect(jellyfinClient, { show: () => {}, now: () => clock, sleep: async () => {
      clock += 100_000
    }, timeoutMs: 250_000 })).rejects.toThrow(/timed out/)
  })
})
