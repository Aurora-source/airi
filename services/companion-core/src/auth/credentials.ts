import type { SecretStore } from './secret-store'

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Bearer tokens that local clients present to the gateway.
 *
 * The two tokens are separate on purpose. AIRI holds only `inference`, so a leaked AIRI setting
 * cannot change configuration, keys, profiles, quotas, or memory.
 */
export interface GatewayCredentials {
  /** Accepted only on `/v1/*` inference routes. */
  inference: string
  /** Reserved for `/ops/*` administration routes. R2A defines no ops routes. */
  ops: string
}

export const INFERENCE_TOKEN_SECRET = 'gateway-inference-token'
export const OPS_TOKEN_SECRET = 'gateway-ops-token'

function generateToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`
}

/** Reads both tokens, and creates and stores each one that is missing. */
export async function loadOrCreateCredentials(store: SecretStore): Promise<GatewayCredentials> {
  let inference = await store.read(INFERENCE_TOKEN_SECRET)
  if (!inference) {
    inference = generateToken('cc_inf')
    await store.write(INFERENCE_TOKEN_SECRET, inference)
  }
  let ops = await store.read(OPS_TOKEN_SECRET)
  if (!ops) {
    ops = generateToken('cc_ops')
    await store.write(OPS_TOKEN_SECRET, ops)
  }
  return { inference, ops }
}

/**
 * Returns a check for one expected bearer token.
 *
 * Both sides are hashed first, so `timingSafeEqual` always compares equal lengths and the
 * comparison time does not reveal the token length or a matching prefix.
 */
export function createBearerCheck(expected: string): (authorization: string | undefined) => boolean {
  const expectedDigest = createHash('sha256').update(expected).digest()
  return (authorization) => {
    const match = /^Bearer (\S+)$/.exec(authorization ?? '')
    if (!match)
      return false
    return timingSafeEqual(createHash('sha256').update(match[1]).digest(), expectedDigest)
  }
}
