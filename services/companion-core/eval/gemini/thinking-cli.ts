import type { WireMessage, WireRequest } from '../../src/budget/wire'
import type { Model } from './protocol'

import process from 'node:process'

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { errorMessageFrom } from '@moeru/std'

import { clockContinuation, TOOL_SYSTEM } from './capabilities'
import { DIALOGUES, fingerprint, history, PRICES, SYSTEM } from './corpus'
import { CORE, PRICE_VALID_UNTIL, sourceDigest, validatePreflight } from './preflight'
import { discover } from './protocol'
import { Benchmark } from './runner'
import { assertThinking, campaign, counterbalanced } from './thinking'
import { thinkingReport } from './thinking-report'
import { EXTRA_DIALOGUES } from './thinking-scenes'

interface Variant { model: string, effort: string }

const PRIMARY: readonly Variant[] = [
  { model: 'gemini-3.6-flash', effort: 'minimal' },
  { model: 'gemini-3.5-flash', effort: 'minimal' },
  { model: 'gemini-3.8-flash', effort: 'low' },
  { model: 'gemini-3.8-flash', effort: 'medium' },
  { model: 'gemini-3.8-flash', effort: 'high' },
  { model: 'gemini-3.1-flash-lite', effort: 'minimal' },
]
const SECONDARY: readonly Variant[] = [
  { model: 'gemini-3.6-flash', effort: 'low' },
  { model: 'gemini-3.6-flash', effort: 'medium' },
  { model: 'gemini-3.7-flash', effort: 'medium' },
  { model: 'gemini-3.7-flash', effort: 'high' },
  { model: 'gemini-3.5-flash', effort: 'low' },
]
const LATENCY_MESSAGE: WireMessage[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Hey Mura, I finally have a quiet evening. Give me one warm, playful sentence about making tea together.' }]

function read(directory: string, name: string): unknown {
  return JSON.parse(readFileSync(resolve(directory, name), 'utf8'))
}

function write(directory: string, name: string, value: unknown): void {
  writeFileSync(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`)
}

function body(variant: Variant, messages: WireMessage[]): WireRequest {
  return { model: variant.model, messages, max_tokens: 4096, reasoning_effort: variant.effort }
}

/**
 * Runs the existing Gateway benchmark with an independently authorized USD 5 campaign.
 * Temperature is omitted uniformly because current 3.5 Flash documentation rejects explicit sampling controls.
 *
 * Call stack:
 * main -> validatePreflight -> campaign -> Benchmark.request -> SpendLedger.reserve
 *   -> existing R2B Gateway -> terminal usage -> SpendLedger.settle -> thinkingReport
 */
async function main(): Promise<void> {
  const [phase, directory, ...flags] = process.argv.slice(2)
  const phases = ['discover', 'preflight', 'pilot', 'latency', 'latency-topup', 'quality', 'quality-repeat', 'quality-extension', 'secondary', 'finalists', 'context', 'direct', 'report']
  if (!directory || !phases.includes(phase))
    throw new Error('Usage: thinking-cli.ts <phase> <campaign-directory> [--paid]')
  const output = resolve(directory)
  mkdirSync(output, { recursive: true })
  if (phase === 'report') {
    await thinkingReport(output)
    return
  }
  if (phase === 'preflight') {
    const run = spawnSync(process.execPath, [resolve(CORE, '../../node_modules/vitest/vitest.mjs'), 'run', 'test/gemini-benchmark.test.ts', 'test/gemini-thinking.test.ts', '--no-file-parallelism', '--maxWorkers', '1'], { cwd: CORE, encoding: 'utf8' })
    writeFileSync(resolve(output, `preflight-tests-${Date.now()}.txt`), `${run.stdout}\n${run.stderr}`)
    const passed = Number(/Tests\s+(\d+) passed/.exec(run.stdout)?.[1])
    if (run.status !== 0 || passed < 59)
      throw new Error('Simulated safeguard tests failed')
    const discovery = read(output, 'discovery.json')
    const receipt = { schemaVersion: 1, capturedAt: new Date().toISOString(), sourceSha256: sourceDigest(), discoverySha256: fingerprint(discovery), pricesSha256: fingerprint(PRICES), testsPassed: passed, paidCalls: 0, ceilingUsd: 5, concurrency: 1, priceValidUntil: PRICE_VALID_UNTIL }
    validatePreflight(receipt, discovery)
    write(output, `preflight-${Date.now()}.json`, receipt)
    write(output, 'preflight.json', receipt)
    console.info(JSON.stringify({ preflight: 'passed', ...receipt }))
    return
  }
  const key = process.env.GEMINI_API_KEY
  if (!key)
    throw new Error('The Windows User GEMINI_API_KEY credential is unavailable')
  if (phase === 'discover') {
    const models = await discover(key)
    write(output, 'discovery.json', { capturedAt: new Date().toISOString(), projectId: 'gen-lang-client-0341576079', projectNumber: '825264326503', projectSource: 'user-confirmed', inferenceCalls: 0, models })
    console.info(JSON.stringify({ metadataModels: models.length, inferenceCalls: 0 }))
    return
  }
  if (flags.length !== 1 || flags[0] !== '--paid')
    throw new Error('Paid phases require exactly --paid')
  const receipt = read(output, 'preflight.json')
  const models: Model[] = validatePreflight(receipt, read(output, 'discovery.json'))
  if (!receipt || typeof receipt !== 'object' || !('ceilingUsd' in receipt) || receipt.ceilingUsd !== 5 || !('concurrency' in receipt) || receipt.concurrency !== 1)
    throw new Error('V2 needs a fresh five-dollar, single-request receipt')
  for (const variant of [...PRIMARY, ...SECONDARY])
    assertThinking(models, variant.model, variant.effort)
  const identity = 'gemini-thinking-v2-2026-10-09'
  campaign(output, identity, phase)
  const bench = new Benchmark(output, key, models, undefined, { ceilingNano: 5_000_000_000, concurrency: 1 })
  const campaignRunId = randomUUID()
  let calls = 0
  const request = async (variant: Variant, scenario: string, requestBody: WireRequest, extras: Partial<Parameters<Benchmark['request']>[0]> = {}) => {
    assertThinking(models, variant.model, variant.effort)
    if (bench.ledger.snapshot().spentNano > 2_000_000_000)
      throw new Error('Research target reached. Review evidence before allocating further authorized headroom.')
    const sample = await bench.request({ ...extras, model: variant.model, path: extras.path ?? 'gateway-paid', scenario, body: requestBody, campaignRunId })
    calls++
    console.info(JSON.stringify({ phase, call: calls, model: variant.model, effort: variant.effort, scenario, firstTextMs: sample.firstTextMs, totalMs: sample.totalMs, thinking: sample.usage?.thinking, costUsd: (sample.costNano ?? 0) / 1e9, spentUsd: bench.ledger.snapshot().spentNano / 1e9 }))
    await setTimeout(250)
    return sample
  }
  try {
    if (phase === 'pilot') {
      for (const variant of PRIMARY)
        await request(variant, 'warmup', body(variant, LATENCY_MESSAGE), { cold: true })
    }
    if (phase === 'latency') {
      for (const variant of PRIMARY)
        await request(variant, 'warmup', body(variant, LATENCY_MESSAGE), { cold: true })
      for (let round = 0; round < 20; round++) {
        for (const variant of counterbalanced(PRIMARY, round))
          await request(variant, 'latency', body(variant, LATENCY_MESSAGE))
      }
    }
    if (phase === 'latency-topup') {
      for (const variant of PRIMARY)
        await request(variant, 'warmup', body(variant, LATENCY_MESSAGE), { cold: true })
      for (const variant of counterbalanced(PRIMARY, 1))
        await request(variant, 'latency', body(variant, LATENCY_MESSAGE))
    }
    if (phase === 'quality' || phase === 'quality-repeat' || phase === 'secondary' || phase === 'quality-extension') {
      const variants = phase === 'secondary' ? SECONDARY : PRIMARY
      const dialogues = phase === 'quality-extension' ? EXTRA_DIALOGUES : DIALOGUES
      for (const [index, dialogue] of dialogues.entries()) {
        for (const variant of counterbalanced(variants, index + (phase === 'quality-repeat' ? 6 : 0))) {
          const messages: WireMessage[] = [{ role: 'system', content: SYSTEM }]
          for (const [turn, text] of dialogue.turns.entries()) {
            messages.push({ role: 'user', content: text })
            const sample = await request(variant, `persona/${dialogue.id}/${turn}`, body(variant, [...messages]), { units: dialogue.units })
            messages.push({ role: 'assistant', content: sample.text })
          }
        }
      }
    }
    if (phase === 'finalists') {
      const variants = PRIMARY
      const tool = { type: 'function', function: { name: 'synthetic_clock', description: 'Returns a fixed fictional time. No external access.', parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } } }
      for (const variant of variants) {
        const messages: WireMessage[] = [{ role: 'system', content: TOOL_SYSTEM }, { role: 'user', content: 'Use synthetic_clock to read the fictional time in Kyoto, then tell me casually.' }]
        const first = await request(variant, 'capability/native-tool-initiation', { ...body(variant, messages), tools: [tool], tool_choice: 'auto' })
        const completed = clockContinuation(messages, first)
        if (completed)
          await request(variant, 'capability/tool-continuation', { ...body(variant, completed), tools: [tool] })
        await request(variant, 'capability/structured', { ...body(variant, [{ role: 'user', content: 'Return JSON only: mood calm, activity tea. Use exactly the keys mood and activity.' }]), response_format: { type: 'json_schema', json_schema: { name: 'mood', strict: true, schema: { type: 'object', properties: { mood: { type: 'string' }, activity: { type: 'string' } }, required: ['mood', 'activity'], additionalProperties: false } } } })
      }
    }
    if (phase === 'context') {
      for (const [index, characters] of [2000, 14000, 38000].entries()) {
        for (const variant of counterbalanced([PRIMARY[0], PRIMARY[2], PRIMARY[3], PRIMARY[5]], index)) {
          for (let repeat = 0; repeat < 2; repeat++)
            await request(variant, `context/history-${characters}`, body(variant, history(characters)))
        }
      }
    }
    if (phase === 'direct') {
      for (let round = 0; round < 5; round++) {
        for (const variant of counterbalanced([PRIMARY[0], PRIMARY[2], PRIMARY[3], PRIMARY[5]], round)) {
          for (const path of round % 2 ? ['gateway-paid', 'direct'] as const : ['direct', 'gateway-paid'] as const)
            await request(variant, 'direct-comparison', body(variant, LATENCY_MESSAGE), { path })
        }
      }
    }
    write(output, `completed-v2-${phase}.json`, { at: new Date().toISOString(), campaignRunId, calls, warmedInProcess: phase === 'latency', ledger: bench.ledger.snapshot() })
  }
  finally {
    await bench.close()
  }
}

main().catch((error: unknown) => {
  const message = errorMessageFrom(error) ?? 'Benchmark stopped'
  // Provider errors are not printed because they can contain credential-bearing request context.
  console.error(JSON.stringify({ stopped: true, safeReason: /budget|ceiling|campaign|preflight|receipt|research target|fingerprint|unsupported|metadata/i.test(message) ? message : 'Delivery or accounting failed. Inspect the preserved ledger. No retries occur.' }))
  process.exitCode = 1
})
