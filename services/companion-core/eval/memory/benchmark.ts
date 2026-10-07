import type { MemoryObservation } from '../../src/memory/ports'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { MemoryClient } from '../../src/memory'

/**
 * Measures disk-backed port latency after worker initialization. It writes JSON evidence when given an output path.
 *
 * Call stack:
 *
 * benchmark
 *   -> MemoryClient
 *     -> SQLiteMemoryStore
 */
async function benchmark(): Promise<void> {
  const requested = Number(process.argv[2] ?? 2000)
  if (!Number.isInteger(requested) || requested < 100 || requested > 20_000)
    throw new Error('Choose an event count between 100 and 20000')
  const folder = mkdtempSync(join(tmpdir(), 'airi-memory-benchmark-'))
  const databasePath = join(folder, 'memory.db')
  const memory = new MemoryClient(databasePath)
  try {
    const start = performance.now()
    await memory.ready()
    const startupMs = performance.now() - start
    const ingestLatencies: number[] = []
    for (let index = 0; index < requested; index++) {
      const event: MemoryObservation = {
        userId: 'benchmark-user',
        characterId: 'mura',
        source: 'airi',
        kind: 'user_text',
        sessionId: `session-${Math.floor(index / 20)}`,
        messageId: `message-${index}`,
        occurredAt: Date.now() - (requested - index) * 60_000,
        text: `We discussed telescope astronomy observation number ${index}.`,
        claims: [{ key: `interest.${index}`, value: `telescope ${index}`, text: `The user enjoys telescope astronomy topic ${index}.`, category: 'interest', attribution: 'user_said', aboutUser: true, scope: 'global' }],
      }
      const began = performance.now()
      await memory.ingest(event)
      ingestLatencies.push(performance.now() - began)
    }
    await memory.consolidate(100)
    const recallLatencies: number[] = []
    let timeouts = 0
    let maximumBytes = 0
    let maximumItems = 0
    for (let index = 0; index < 120; index++) {
      const began = performance.now()
      const result = await memory.recall({ userId: 'benchmark-user', characterId: 'mura', query: `telescope astronomy ${index * 7}`, deadlineMs: 150 })
      recallLatencies.push(performance.now() - began)
      timeouts += Number(result.timedOut)
      maximumBytes = Math.max(maximumBytes, Buffer.byteLength(result.prompt))
      maximumItems = Math.max(maximumItems, result.items.length)
    }
    function percentiles(values: number[]) {
      const ordered = [...values].sort((a, b) => a - b)
      const percentile = (fraction: number) => Number(ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))].toFixed(3))
      return { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), maximum: percentile(1) }
    }
    await memory.backup(join(folder, 'snapshot.db'))
    const evidence = {
      measuredAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      eventCount: requested,
      recallQueries: recallLatencies.length,
      startupMs: Number(startupMs.toFixed(3)),
      ingestMs: percentiles(ingestLatencies),
      recallMs: percentiles(recallLatencies),
      timeouts,
      maximumBytes,
      maximumItems,
      snapshotBytes: statSync(join(folder, 'snapshot.db')).size,
      limitation: 'Synthetic lexical workload. Worker startup is measured separately. This is not the multi-day companion trial.',
    }
    if (process.argv[3])
      writeFileSync(resolve(process.argv[3]), `${JSON.stringify(evidence, null, 2)}\n`)
    console.info(JSON.stringify(evidence))
  }
  finally {
    await memory.close()
    rmSync(folder, { recursive: true, force: true })
  }
}

void benchmark()
