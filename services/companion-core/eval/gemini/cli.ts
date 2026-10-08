import type { WireMessage, WireRequest } from '../../src/budget/wire'
import type { Path, Sample } from './runner'

import process from 'node:process'

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { costNano } from './accounting'
import { clockContinuation, TOOL_SYSTEM } from './capabilities'
import { DIALOGUES, fingerprint, history, MODELS, PRICES, SYSTEM, VISION_PNG } from './corpus'
import { airiEnvelope } from './envelope'
import { measureFixtures } from './fixtures'
import { monthlyCosts } from './monthly'
import { CORE, PRICE_VALID_UNTIL, sourceDigest, validatePreflight } from './preflight'
import { discover } from './protocol'
import { aggregate, worksheet } from './report'
import { Benchmark } from './runner'
import { replayVoiceText } from './voice'

function read(directory: string, name: string): unknown {
  return JSON.parse(readFileSync(resolve(directory, name), 'utf8'))
}

function write(directory: string, name: string, value: unknown): void {
  writeFileSync(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`)
}

function effort(model: string): string {
  return /3\.[78]-flash$/.test(model) ? 'low' : 'minimal'
}

function body(model: string, messages: WireMessage[], maxTokens = 2048, reasoning = effort(model)): WireRequest {
  return { model, messages, max_tokens: maxTokens, reasoning_effort: reasoning, temperature: 1 }
}

/**
 * Runs isolated metadata, simulated preflight, bounded paid campaigns, or local reports.
 *
 * Call stack:
 * main -> validatePreflight -> Benchmark.request -> SpendLedger.reserve -> existing Gateway or provider -> SpendLedger.settle
 */
async function main(): Promise<void> {
  const [command, directory, ...flags] = process.argv.slice(2)
  if (!directory || !['discover', 'preflight', 'pilot', 'latency', 'optimization', 'quality', 'context', 'capabilities', 'concurrency', 'voice-text', 'envelope', 'fixtures', 'report'].includes(command))
    throw new Error('Usage: cli.ts <command> <isolated-directory> [--paid] [--small]')
  const output = resolve(directory)
  mkdirSync(output, { recursive: true })
  if (command === 'fixtures') {
    write(output, 'fixture-timings.json', await measureFixtures(flags.includes('--small') ? 1 : 3))
    console.info('Loopback cancellation, failover, and retry timings saved. Paid calls: zero.')
    return
  }
  if (command === 'report') {
    const samples: Sample[] = readFileSync(resolve(output, 'samples.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    write(output, 'results.json', aggregate(samples))
    write(output, 'monthly-costs.json', monthlyCosts(samples))
    write(output, 'prices.json', { capturedAt: '2026-10-08', source: 'https://ai.google.dev/gemini-api/docs/pricing', currency: 'USD per million tokens', standard: PRICES, futureFlashMultiplier: { startsAt: '2027-01-01', models: ['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash'], factor: 2 } })
    const voiceRows = []
    for (const sample of samples.filter(sample => sample.scenario === 'voice-text' && sample.textChunks))
      voiceRows.push({ id: sample.id, model: sample.model, path: sample.path, firstTextMs: sample.firstTextMs, totalMs: sample.totalMs, ...await replayVoiceText(sample.textChunks!, sample.totalMs) })
    write(output, 'voice-text-replay.json', { mode: 'offline text replay through upstream chunkTtsInput after strict ACT removal', physicalAudioMeasured: false, rows: voiceRows })
    const blind = worksheet(samples)
    writeFileSync(resolve(output, 'human-review.md'), blind.markdown)
    write(output, 'human-review-key.json', blind.key)
    console.info(JSON.stringify({ samples: samples.length, knownCostUsd: samples.reduce((sum, sample) => sum + (sample.costNano ?? 0), 0) / 1e9 }))
    return
  }
  if (command === 'preflight') {
    const run = spawnSync(process.execPath, [resolve(CORE, '../../node_modules/vitest/vitest.mjs'), 'run', 'test/gemini-benchmark.test.ts', '--no-file-parallelism', '--maxWorkers', '1'], { cwd: CORE, encoding: 'utf8' })
    writeFileSync(resolve(output, 'preflight-tests.txt'), `${run.stdout}\n${run.stderr}`)
    const passed = Number(/Tests\s+(\d+) passed/.exec(run.stdout)?.[1])
    if (run.status !== 0 || passed < 42)
      throw new Error('Simulated guard tests failed')
    const discovery = read(output, 'discovery.json')
    const receipt = { schemaVersion: 1, capturedAt: new Date().toISOString(), sourceSha256: sourceDigest(), discoverySha256: fingerprint(discovery), pricesSha256: fingerprint(PRICES), testsPassed: passed, paidCalls: 0, ceilingUsd: 4.5, concurrency: 2, priceValidUntil: PRICE_VALID_UNTIL }
    validatePreflight(receipt, discovery)
    write(output, 'preflight.json', receipt)
    write(output, `preflight-${Date.now()}.json`, receipt)
    console.info(JSON.stringify({ preflight: 'passed', tests: passed, paidCalls: 0, ceilingUsd: 4.5, concurrency: 2 }))
    return
  }
  const key = process.env.GEMINI_API_KEY
  if (!key)
    throw new Error('GEMINI_API_KEY is unavailable in this process')
  if (command === 'discover') {
    const models = await discover(key)
    write(output, 'discovery.json', { capturedAt: new Date().toISOString(), projectId: 'gen-lang-client-0341576079', projectNumber: '825264326503', projectSource: 'user-confirmed', inferenceCalls: 0, models })
    console.info(JSON.stringify({ metadataModels: models.length, relevant: models.filter(model => PRICES[model.name.replace('models/', '')]) }))
    return
  }
  if (!flags.includes('--paid') || flags.some(flag => !['--paid', '--small'].includes(flag)))
    throw new Error('Paid phases require the explicit --paid flag')
  const models = validatePreflight(read(output, 'preflight.json'), read(output, 'discovery.json'))
  if (MODELS.some(id => !models.some(model => model.name === `models/${id}`)))
    throw new Error('A candidate is not available in project metadata')
  const small = flags.includes('--small')
  const completedFile = resolve(output, `completed-${command}${small ? '-small' : ''}.json`)
  if (existsSync(completedFile))
    throw new Error('This phase is already complete. Use retained evidence instead of paying again.')
  const bench = new Benchmark(output, key, models)
  const campaignRunId = randomUUID()
  let calls = 0
  const run = async (model: string, path: Path, scenario: string, requestBody: WireRequest, extras: Partial<Parameters<Benchmark['request']>[0]> = {}) => {
    const metadata = models.find(item => item.name === `models/${model}`)!
    const price = PRICES[model]
    // Full input capacity and combined generated-token cap reserve the worst possible bill before dispatch.
    const worstUsd = costNano(price, { input: metadata.inputTokenLimit, cached: 0, output: Number(requestBody.max_tokens), thinking: 0 }) / 1e9
    const approximateInput = Math.ceil(JSON.stringify(requestBody).length / 4)
    const expectedUsd = (approximateInput * price.input + (effort(model) === 'low' ? 1024 : 256) * price.output) / 1e6
    console.info(JSON.stringify({ dispatch: calls + 1, model, path, scenario, approximateExpectedUsd: expectedUsd, worstReservedUsd: worstUsd, ledger: bench.ledger.snapshot() }))
    const sample = await bench.request({ ...extras, model, path, scenario, body: requestBody, campaignRunId })
    calls++
    console.info(JSON.stringify({ completed: calls, firstTextMs: sample.firstTextMs, totalMs: sample.totalMs, input: sample.usage?.input, output: sample.usage?.output, thinking: sample.usage?.thinking, costUsd: (sample.costNano ?? 0) / 1e9 }))
    return sample
  }
  const latencyMessages: WireMessage[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Hey Mura, I finally have a quiet evening. Give me one warm, playful sentence about making tea together.' }]
  try {
    if (command === 'pilot') {
      for (const model of small ? [MODELS[1]] : MODELS)
        await run(model, 'direct', 'pilot', body(model, latencyMessages), { cold: true })
    }
    if (command === 'latency') {
      const count = small ? 3 : 20
      for (const model of MODELS) {
        for (const path of ['direct', 'gateway-paid', 'gateway-baseline'] as const)
          await run(model, path, 'warmup', body(model, latencyMessages), { cold: true })
      }
      for (let round = 0; round < count; round++) {
        for (let index = 0; index < MODELS.length; index++) {
          const model = MODELS[(index + round) % MODELS.length]
          const paths: Path[] = round % 2 === 0 ? ['direct', 'gateway-paid'] : ['gateway-paid', 'direct']
          if (round < (small ? 3 : 8))
            paths.splice(1, 0, 'gateway-baseline')
          for (const path of paths)
            await run(model, path, 'latency', body(model, latencyMessages))
        }
      }
    }
    if (command === 'quality') {
      const variants: { model: string, reasoning: string, path: Path }[] = MODELS.map(model => ({ model, reasoning: effort(model), path: 'gateway-paid' }))
      if (!small)
        variants.push({ model: 'gemini-3.5-flash-lite', reasoning: 'low', path: 'gateway-paid' }, { model: 'gemini-3.8-flash', reasoning: 'medium', path: 'gateway-paid' }, { model: 'gemini-3.5-flash-lite', reasoning: 'minimal', path: 'gateway-optimized' }, { model: 'gemini-3.8-flash', reasoning: 'low', path: 'gateway-baseline' })
      for (const variant of variants) {
        for (const dialogue of small ? DIALOGUES.slice(0, 2) : DIALOGUES) {
          const messages: WireMessage[] = [{ role: 'system', content: SYSTEM }]
          for (const [turn, text] of dialogue.turns.entries()) {
            messages.push({ role: 'user', content: text })
            const result = await run(variant.model, variant.path, `persona/${dialogue.id}/${turn}`, body(variant.model, [...messages], 4096, variant.reasoning), { units: dialogue.units })
            messages.push({ role: 'assistant', content: result.text })
            if (variant.path === 'gateway-baseline')
              await setTimeout(4000)
          }
        }
      }
    }
    if (command === 'optimization') {
      for (let round = 0; round < (small ? 3 : 20); round++)
        await run(MODELS[1], 'gateway-optimized', 'optimization', body(MODELS[1], latencyMessages))
    }
    if (command === 'context') {
      for (const model of small ? [MODELS[1]] : [MODELS[1], MODELS[3]]) {
        for (const characters of small ? [0, 4000] : [0, 4000, 40_000, 160_000]) {
          for (const path of ['gateway-baseline', 'gateway-paid'] as const)
            await run(model, path, `context/history-${characters}`, body(model, history(characters)))
        }
        if (!small) {
          for (const dialogue of DIALOGUES.filter(item => item.units?.length))
            await run(model, 'gateway-paid', `context/${dialogue.id}`, body(model, [{ role: 'system', content: SYSTEM }, { role: 'user', content: dialogue.turns[0] }]), { units: dialogue.units })
        }
      }
    }
    if (command === 'capabilities') {
      const tool = { type: 'function', function: { name: 'synthetic_clock', description: 'Returns a fixed fictional time. No external access.', parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } } }
      for (const model of small ? [MODELS[1]] : MODELS) {
        for (const path of small ? ['gateway-paid'] as const : ['direct', 'gateway-paid'] as const) {
          const messages: WireMessage[] = [{ role: 'system', content: TOOL_SYSTEM }, { role: 'user', content: 'Use synthetic_clock to read the fictional time in Kyoto, then tell me casually.' }]
          const first = await run(model, path, 'capability/native-tool-initiation', { ...body(model, messages), tools: [tool], tool_choice: 'auto' })
          let completed = clockContinuation(messages, first)
          if (!completed) {
            // A forced function probe measures transport compatibility separately from automatic tool selection.
            const forced = await run(model, path, 'capability/forced-tool-initiation', { ...body(model, messages), tools: [tool], tool_choice: { type: 'function', function: { name: 'synthetic_clock' } } })
            completed = clockContinuation(messages, forced)
          }
          if (completed)
            await run(model, path, 'capability/tool-continuation', { ...body(model, completed), tools: [tool] })
          await run(model, path, 'capability/structured', { ...body(model, [{ role: 'user', content: 'Return JSON only: mood calm, activity tea. Use exactly the keys mood and activity.' }]), response_format: { type: 'json_schema', json_schema: { name: 'mood', strict: true, schema: { type: 'object', properties: { mood: { type: 'string' }, activity: { type: 'string' } }, required: ['mood', 'activity'], additionalProperties: false } } } })
          await run(model, path, 'capability/vision', body(model, [{ role: 'user', content: [{ type: 'text', text: 'Describe the colors on the left and right halves of this synthetic image. One short sentence.' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${VISION_PNG}` } }] }]))
        }
      }
    }
    if (command === 'concurrency') {
      for (const model of small ? [MODELS[1]] : [MODELS[1], MODELS[3]]) {
        for (let round = 0; round < (small ? 1 : 3); round++) {
          const results = await Promise.allSettled([run(model, 'gateway-paid', 'concurrency', body(model, latencyMessages)), run(model, 'gateway-paid', 'concurrency', body(model, latencyMessages))])
          if (results.some(result => result.status === 'rejected'))
            throw new Error('Concurrent campaign stopped')
          await setTimeout(1000)
        }
      }
    }
    if (command === 'voice-text') {
      for (const model of [MODELS[0], MODELS[1], MODELS[3]]) {
        for (let round = 0; round < (small ? 2 : 5); round++)
          await run(model, model === MODELS[1] ? 'gateway-optimized' : 'gateway-paid', 'voice-text', body(model, latencyMessages))
      }
    }
    if (command === 'envelope') {
      const { tools, messages } = airiEnvelope()
      for (let round = 0; round < (small ? 2 : 5); round++) {
        for (const model of round % 2 ? [MODELS[3], MODELS[0]] : [MODELS[0], MODELS[3]]) {
          for (const path of round % 2 ? ['gateway-paid', 'direct'] as const : ['direct', 'gateway-paid'] as const)
            await run(model, path, 'airi-envelope', { ...body(model, messages), tools, tool_choice: 'auto' })
        }
      }
    }
    writeFileSync(completedFile, `${JSON.stringify({ capturedAt: new Date().toISOString(), calls, ledger: bench.ledger.snapshot() }, null, 2)}\n`)
    console.info(JSON.stringify({ phase: command, calls, ledger: bench.ledger.snapshot() }))
  }
  finally {
    await bench.close()
  }
}

main().catch(() => {
  // Provider exceptions can contain credentials. Preserve only a fixed message at this reporting boundary.
  console.error('Benchmark stopped. Inspect the local receipt and ledger. Unknown usage must remain reserved. No automatic retries occur.')
  process.exitCode = 1
})
