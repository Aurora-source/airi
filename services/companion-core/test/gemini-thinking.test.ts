import type { Sample } from '../eval/gemini/runner'

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { costNano, parseUsage, SpendLedger } from '../eval/gemini/accounting'
import { worksheet } from '../eval/gemini/report'
import { Benchmark } from '../eval/gemini/runner'
import { assertThinking, campaign, counterbalanced } from '../eval/gemini/thinking'
import { thinkingReport } from '../eval/gemini/thinking-report'
import { replayVoiceText } from '../eval/gemini/voice'

describe('incremental thinking campaign safeguards', () => {
  it('binds campaign identity and rejects a changed or repeated campaign', () => {
    const directory = mkdtempSync(join(tmpdir(), 'thinking-campaign-'))
    try {
      campaign(directory, 'v2-fixture', 'latency')
      expect(() => campaign(directory, 'different', 'quality')).toThrow(/campaign/i)
      expect(() => campaign(directory, 'v2-fixture', 'latency')).toThrow(/repeat|started/i)
      expect(JSON.parse(readFileSync(join(directory, 'campaign.json'), 'utf8')).ceilingUsd).toBe(5)
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps minimal distinct from off and rejects unsupported levels or metadata', () => {
    const models = [{ name: 'models/gemini-3.6-flash', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] }]
    expect(() => assertThinking(models, 'gemini-3.6-flash', 'minimal')).not.toThrow()
    expect(() => assertThinking(models, 'gemini-3.6-flash', 'none')).toThrow(/unsupported/i)
    expect(() => assertThinking(models, 'gemini-3.8-flash', 'low')).toThrow(/metadata/i)
    expect(() => assertThinking([...models, { ...models[0], name: 'models/gemini-3.8-flash' }], 'gemini-3.8-flash', 'minimal')).toThrow(/unsupported/i)
  })

  it('counts positive thinking under minimal and actual zero without changing the requested level', () => {
    expect(parseUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 35 }).thinking).toBe(5)
    expect(parseUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }).thinking).toBe(0)
  })

  it('counterbalances every configuration without silent substitutions', () => {
    const rows = ['minimal', 'low', 'medium', 'high']
    const positions = rows.map(() => new Set<string>())
    for (let round = 0; round < rows.length * 2; round++) {
      const ordered = counterbalanced(rows, round)
      expect(new Set(ordered).size).toBe(rows.length)
      ordered.forEach((row, index) => positions[index].add(row))
    }
    expect(positions.every(position => position.size === rows.length)).toBe(true)
  })

  it('rejects a request beyond the remaining five-dollar budget before provider dispatch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'thinking-budget-'))
    const models = [{ name: 'models/gemini-3.5-flash', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] }]
    const bench = new Benchmark(directory, 'synthetic-key', models, undefined, { ceilingNano: 5_000_000_000, concurrency: 1 })
    const price = { input: 1.5, cached: 0.15, output: 9 }
    for (let i = 0; i < 3; i++) {
      bench.ledger.reserve(`prior-${i}`, 'gemini-3.5-flash', price, 800000, 1000)
      bench.ledger.settle(`prior-${i}`, { input: 800000, cached: 0, output: 1000, thinking: 0 })
    }
    let called = false
    try {
      await expect(bench.request({ model: 'gemini-3.5-flash', path: 'direct', scenario: 'budget-blocked', body: { model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'Tea?' }], max_tokens: 4096, reasoning_effort: 'minimal' }, transport: async () => {
        called = true
        return new Response('')
      } })).rejects.toThrow(/budget/i)
      expect(called).toBe(false)
      expect(bench.ledger.snapshot().exposureNano).toBe(3_627_000_000)
      expect(JSON.parse(readFileSync(join(directory, 'ledger.json'), 'utf8')).ceilingNano).toBe(5_000_000_000)
    }
    finally {
      await bench.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('preserves spending and unknown reservations when an explicit authorization raises the ceiling', () => {
    const directory = mkdtempSync(join(tmpdir(), 'thinking-authorization-'))
    const path = join(directory, 'ledger.json')
    const ledger = new SpendLedger(path, 1_000_000_000, 1)
    const price = { input: 0.75, cached: 0.075, output: 3.75 }
    try {
      ledger.reserve('settled', 'fixture', price, 1000, 1000)
      ledger.settle('settled', { input: 100, cached: 0, output: 100, thinking: 50 })
      ledger.reserve('unknown', 'fixture', price, 1000, 1000)
      ledger.settle('unknown', undefined)
      const before = ledger.snapshot()
      ledger.authorizeCeiling(5_000_000_000, 'Explicit user authorization on 2026-10-09')
      expect(ledger.snapshot()).toEqual(before)
      expect(() => ledger.reserve('later', 'fixture', price, 1, 1)).toThrow(/halted/i)
      expect(() => ledger.authorizeCeiling(5_000_000_001, 'Invalid increase')).toThrow()
      const stored = JSON.parse(readFileSync(path, 'utf8'))
      expect(stored.entries).toHaveLength(2)
      expect(stored.ceilingNano).toBe(5_000_000_000)
      expect(stored.authorizations[0].previousCeilingNano).toBe(1_000_000_000)
    }
    finally {
      ledger.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('admits 3.5 Flash short requests at five dollars while reserving full provider capacity and capped output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'thinking-admission-'))
    const models = [{ name: 'models/gemini-3.5-flash', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] }]
    const bench = new Benchmark(directory, 'synthetic-key', models, undefined, { ceilingNano: 5_000_000_000, concurrency: 1 })
    try {
      const sample = await bench.request({ model: 'gemini-3.5-flash', path: 'direct', scenario: 'bounded-short-fixture', body: { model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'Tea?' }], max_tokens: 4096, reasoning_effort: 'minimal' }, transport: async (_url, options) => {
        expect(bench.ledger.snapshot().exposureNano).toBe(1_609_728_000)
        expect(JSON.parse(String(options?.body)).max_tokens).toBe(4096)
        return new Response('data: {"choices":[{"delta":{"content":"Tea!"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":17}}\n\ndata: [DONE]\n\n')
      } })
      expect(sample.usage?.thinking).toBe(2)
      expect(sample.costNano).toBe(78_000)
      expect(bench.ledger.snapshot().halted).toBe(false)
    }
    finally {
      await bench.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('thinking report measurement boundaries', () => {
  const price = { input: 0.75, cached: 0.075, output: 3.75 }
  const usage = { input: 10, cached: 0, output: 5, thinking: 0 }
  const record: Sample = { id: 'sample', model: 'gemini-3.6-flash', reasoningEffort: 'minimal', path: 'gateway-paid', scenario: 'context/history-2000', cold: false, at: '2026-10-09T00:00:00Z', requestSha256: 'synthetic', preparationMs: 0, headersMs: 1, status: 200, maxTokens: 4096, text: '<|ACT {"emotion":{"name":"happy","intensity":0.8}}|> One two three four.', textChunks: [{ text: '<|ACT {"emotion":{"name":"happy","intensity":0.8}}|> One two three four.', atMs: 2 }], firstByteMs: 1, firstTextMs: 2, totalMs: 3, calls: [], usage, costNano: costNano(price, usage), done: true, missingIndices: 0, reasoningChannel: false }

  async function report(rows: Sample[], before?: (directory: string) => void) {
    const directory = mkdtempSync(join(tmpdir(), 'thinking-report-'))
    try {
      writeFileSync(join(directory, 'samples.ndjson'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
      writeFileSync(join(directory, 'ledger.json'), JSON.stringify({ ceilingNano: 5_000_000_000, halted: false, entries: rows.map(row => ({ status: 'settled', costNano: row.costNano, reservedNano: row.costNano })) }))
      before?.(directory)
      await thinkingReport(directory)
      return { ...JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8')), reviewText: readFileSync(join(directory, 'human-review.md'), 'utf8') }
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  it('preserves spoken words when an ACT opener arrives across text fragments', async () => {
    const replay = await replayVoiceText([{ text: '<', atMs: 1 }, { text: '|ACT {}|>One two three four.', atMs: 2 }], 3)
    expect(replay.chunks.join(' ')).toBe('One two three four.')
    // This short sentence requires the upstream chunker's EOF lookahead, which arrives at 3 ms.
    expect(replay.firstChunkAtMs).toBe(3)
  })

  it('keeps short and long context distributions separate', async () => {
    const results = await report([record, { ...record, id: 'long', scenario: 'context/history-38000', totalMs: 20 }])
    expect(results.contextGroups).toHaveLength(2)
    expect(results.contextGroups.map((row: { scenario: string }) => row.scenario)).toEqual(['context/history-2000', 'context/history-38000'])
  })

  it('preserves billed malformed-ACT evidence when no voice chunk is usable', async () => {
    const results = await report([{ ...record, scenario: 'latency', text: '<|ACT broken', textChunks: [{ text: '<|ACT broken', atMs: 2 }], firstTextMs: undefined }])
    expect(results.voiceLatency[0].firstUsableChunkMs).toBeUndefined()
    expect(results.voiceLatency[0].missingChunkSamples).toBe(1)
    expect(results.costs.v2KnownUsd).toBe(record.costNano! / 1e9)
  })

  it('excludes initial matrix transport requests while preserving raw samples and their costs', async () => {
    const results = await report([{ ...record, id: 'initial', scenario: 'latency', campaignRunId: 'original-matrix' }, { ...record, id: 'steady', scenario: 'latency', campaignRunId: 'original-matrix' }], directory => writeFileSync(join(directory, 'completed-v2-latency.json'), JSON.stringify({ campaignRunId: 'original-matrix' })))
    expect(results.latency[0].n).toBe(1)
    expect(results.cold.some((row: { id: string }) => row.id === 'initial')).toBe(true)
    expect(results.sampleCount).toBe(2)
  })

  it('marks incomplete delivery as unscorable in the blinded worksheet', () => {
    const failed = { ...record, scenario: 'persona/casual-humor/0', status: 502, done: false, text: '', error: 'http-network-or-stream-failure', usage: undefined, costNano: undefined }
    const blind = worksheet([failed])
    expect(blind.markdown).toContain('Incomplete conversation')
    expect(blind.markdown).toContain('Do not score this dialogue')
    expect(blind.markdown).toContain('No completed response')
    expect(blind.markdown).not.toContain(failed.model)
  })

  it('compares only completed dialogue blocks shared by all primary configurations', async () => {
    const variants = [{ model: 'gemini-3.6-flash', reasoningEffort: 'minimal' }, { model: 'gemini-3.8-flash', reasoningEffort: 'low' }]
    const latency = variants.map((variant, index) => ({ ...record, ...variant, id: `latency-${index}`, scenario: 'latency' }))
    const completed = variants.flatMap((variant, index) => [0, 1, 2].map(turn => ({ ...record, ...variant, id: `persona-${index}-${turn}`, campaignRunId: 'completed', scenario: `persona/casual-humor/${turn}` })))
    const results = await report([...latency, ...completed, { ...record, id: 'partial', campaignRunId: 'interrupted', scenario: 'persona/casual-humor/0' }])
    expect(results.matchedPrimaryPersona).toHaveLength(2)
    expect(results.matchedPrimaryPersona.map((row: { n: number }) => row.n)).toEqual([3, 3])
    expect(results.unmatchedPrimaryPersonaIds).toEqual(['partial'])
    expect(results.reviewText.match(/User: /g)).toHaveLength(6)
  })

  it('reports known costs separately from locked exposure after a terminal-usage failure', async () => {
    const failed = { ...record, id: 'unknown', scenario: 'persona/casual-humor/0', status: 502, done: false, text: '', textChunks: undefined, error: 'http-network-or-stream-failure', usage: undefined, costNano: undefined }
    const results = await report([record, failed], directory => writeFileSync(join(directory, 'ledger.json'), JSON.stringify({ ceilingNano: 5_000_000_000, halted: true, entries: [{ status: 'settled', costNano: record.costNano, reservedNano: record.costNano }, { status: 'unknown', reservedNano: 801_792_000 }] })))
    expect(results.costs.v2KnownUsd).toBe(record.costNano! / 1e9)
    expect(results.costs.unresolvedExposureUsd).toBe(0.801792)
    expect(results.costs.v2WorstCaseUsd).toBe((record.costNano! + 801_792_000) / 1e9)
    expect(results.costs.accountingComplete).toBe(false)
    expect(results.costs.halted).toBe(true)
    expect(results.matrix[0].accountedSamples).toBe(1)
    expect(results.matrix[0].unknownUsageSamples).toBe(1)
    expect(results.matrix[0].meanKnownCostUsd).toBe(record.costNano! / 1e9)
  })
})
