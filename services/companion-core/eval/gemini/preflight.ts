import type { Model } from './protocol'

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as v from 'valibot'

import { fingerprint, PRICES } from './corpus'

const here = dirname(fileURLToPath(import.meta.url))
export const CORE = join(here, '../..')
export const PRICE_VALID_UNTIL = '2026-10-10T00:00:00.000Z'

/** Source and safeguard tests bind the receipt to the exact implementation. No environment values enter this digest. */
export function sourceDigest(): string {
  const files = [
    ...readdirSync(here).filter(name => name.endsWith('.ts')).map(name => `eval/gemini/${name}`),
    ...readdirSync(join(CORE, 'src'), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.ts')).map(entry => join(entry.parentPath, entry.name).slice(CORE.length + 1).replaceAll('\\', '/')),
    'eval/persona/prompt.ts',
    'eval/persona/checks.ts',
    'eval/persona/scenarios.ts',
    'eval/persona/client.ts',
    'test/gemini-benchmark.test.ts',
    'test/gemini-thinking.test.ts',
    'test/fixtures/airi-tools.json',
    'test/support/harness.ts',
    'package.json',
    '../../pnpm-lock.yaml',
  ].toSorted()
  return fingerprint(files.map(name => [name, readFileSync(join(CORE, name), 'utf8')]))
}

const positive = v.pipe(v.number(), v.safeInteger(), v.minValue(1))
const discoverySchema = v.object({
  capturedAt: v.string(),
  projectId: v.literal('gen-lang-client-0341576079'),
  projectNumber: v.literal('825264326503'),
  projectSource: v.literal('user-confirmed'),
  inferenceCalls: v.literal(0),
  models: v.array(v.object({ name: v.pipe(v.string(), v.regex(/^models\/[a-z0-9.-]+$/)), inputTokenLimit: positive, outputTokenLimit: positive, supportedGenerationMethods: v.array(v.string()) })),
})
const receiptSchema = v.object({
  schemaVersion: v.literal(1),
  capturedAt: v.string(),
  sourceSha256: v.string(),
  discoverySha256: v.string(),
  pricesSha256: v.string(),
  testsPassed: positive,
  paidCalls: v.literal(0),
  ceilingUsd: v.pipe(v.number(), v.minValue(0.000001), v.maxValue(5)),
  concurrency: v.picklist([1, 2]),
  priceValidUntil: v.literal(PRICE_VALID_UNTIL),
})

/** Validates metadata freshness and the zero-inference test receipt before paid dispatch. */
export function validatePreflight(receiptValue: unknown, discoveryValue: unknown, now = Date.now()): Model[] {
  const receipt = v.parse(receiptSchema, receiptValue)
  const discovery = v.parse(discoverySchema, discoveryValue)
  const receiptAge = now - Date.parse(receipt.capturedAt)
  const discoveryAge = now - Date.parse(discovery.capturedAt)
  if (!Number.isFinite(receiptAge) || receiptAge < 0 || receiptAge > 24 * 3600_000 || !Number.isFinite(discoveryAge) || discoveryAge < 0 || discoveryAge > 24 * 3600_000)
    throw new Error('Preflight or discovery is stale')
  if (now >= Date.parse(PRICE_VALID_UNTIL))
    throw new Error('Refresh official prices before paid testing')
  if (receipt.sourceSha256 !== sourceDigest() || receipt.discoverySha256 !== fingerprint(discoveryValue) || receipt.pricesSha256 !== fingerprint(PRICES))
    throw new Error('Preflight fingerprints changed')
  if (receipt.testsPassed < 42 || new Set(discovery.models.map(model => model.name)).size !== discovery.models.length)
    throw new Error('Incomplete preflight validation')
  return discovery.models
}
