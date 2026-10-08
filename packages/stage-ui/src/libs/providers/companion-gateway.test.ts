import { describe, expect, it } from 'vitest'

import { isCompanionGatewayURL } from './companion-gateway'

describe('isCompanionGatewayURL', () => {
  it('matches the loopback gateway port only', () => {
    expect(isCompanionGatewayURL('http://127.0.0.1:11980/v1/')).toBe(true)
    expect(isCompanionGatewayURL('http://localhost:11980/v1/')).toBe(true)
    expect(isCompanionGatewayURL(new URL('http://[::1]:11980/v1/'))).toBe(true)

    expect(isCompanionGatewayURL('http://127.0.0.1:11434/v1/')).toBe(false)
    expect(isCompanionGatewayURL('https://api.openai.com/v1/')).toBe(false)
    expect(isCompanionGatewayURL('http://192.168.1.5:11980/v1/')).toBe(false)
    expect(isCompanionGatewayURL('https://127.0.0.1:11980/v1/')).toBe(false)
    expect(isCompanionGatewayURL(undefined)).toBe(false)
    expect(isCompanionGatewayURL('not a url')).toBe(false)
  })
})
