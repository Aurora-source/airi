#!/usr/bin/env tsx
import process from 'node:process'

import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { CompanionDirector } from '../../src/companion/director'
import { CompanionWatch } from '../../src/companion/watch'
import { parseConfig } from '../../src/config/config'
import { FakeStage } from '../../test/support/stage'
import { FakeChannel, FakeExtension } from '../../test/support/watch'

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms))
async function settle() {
  for (let i = 0; i < 4; i++)
    await new Promise(done => setImmediate(done))
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 1000) / 1000
}

function config() {
  return parseConfig({
    providers: { fake: { baseURL: 'http://127.0.0.1:9/v1/', keyRef: 'provider-fake' } },
    models: { 'fake-model': { provider: 'fake', model: 'none', capabilities: { contextWindow: 32_000 } } },
    aliases: { 'companion-chat': { chain: ['fake-model'] } },
    watch: { reactionCooldownMs: 10_000 },
  })
}

/** One host with a real CompanionWatch, R6 policy, and a fake stage over fake channels. */
function stack(withDirector: boolean) {
  const parsed = config()
  const watchChannel = new FakeChannel()
  const stage = new FakeStage()
  const director = withDirector ? new CompanionDirector({ config: parsed, createClient: stage.channel.connect }) : undefined
  const watch = new CompanionWatch({ config: parsed, createClient: watchChannel.connect, reactionOutput: director?.reactionOutput() ?? { deliver: () => {} } })
  director?.connect({ watch })
  watchChannel.ready(true)
  stage.ready()
  const extension = new FakeExtension(watchChannel, Date.now)
  return { director, watch, stage, watchChannel, extension, close: async () => {
    await director?.close()
    await watch.shutdown()
  } }
}

/**
 * Measures the Director host inside the Core with the real CompanionWatch and R6 ReactionPolicy: per-event cost,
 * Watch update cost with and without the host, the moment-to-stage reaction handoff, interruption latency, and heap.
 * The stage is a fake channel peer. Nothing touches a network or a model.
 *
 * Usage: tsx eval/director/perf-host.mts [--out <result.json>]
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string' } } })
  const results: Record<string, unknown> = {}

  // Watch update overhead: caption observations with and without a subscribed, bound Director host.
  for (const withDirector of [false, true]) {
    const s = stack(withDirector)
    s.director?.beginTurn({ sessionId: 's', roundId: 'r0', characterId: 'mura' }, { model: 'companion-chat', messages: [{ role: 'user', content: 'hi' }] })
    s.extension.sendVideo({ isPlaying: true, currentTimeSec: 10 })
    const samples: number[] = []
    for (let i = 0; i < 20_000; i++) {
      const start = performance.now()
      s.extension.sendSubtitle(`line ${i}`, { language: 'ja', startMs: 10_000 + i * 10, endMs: 10_000 + i * 10 + 5 })
      samples.push(performance.now() - start)
      if (i % 500 === 0)
        await settle()
    }
    await settle()
    results[withDirector ? 'watchUpdateWithDirector' : 'watchUpdateWithoutDirector'] = { p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), p99Ms: percentile(samples, 0.99), directorAccepted: s.director?.status() && (s.director.status().director as { metrics: { accepted: number } }).metrics.accepted }
    await s.close()
  }

  // Host event cost: canonical turns (submit + recall-free conversation event) and speech reports, flushed in batches.
  {
    const s = stack(true)
    const turnSamples: number[] = []
    const speechSamples: number[] = []
    globalThis.gc?.()
    const heapBefore = process.memoryUsage().heapUsed
    for (let i = 0; i < 20_000; i++) {
      let start = performance.now()
      const entry = s.director!.beginTurn({ sessionId: 's', roundId: `r${i}`, characterId: 'mura' }, { model: 'companion-chat', messages: [{ role: 'user', content: 'hello' }] })
      turnSamples.push(performance.now() - start)
      entry.finish({ status: 'complete', reply: { text: 'ok', toolCalls: [], truncated: false } })
      start = performance.now()
      s.stage.speak(`r${i}`, i % 2 === 0, 's')
      speechSamples.push(performance.now() - start)
      if (i % 100 === 0)
        await settle()
    }
    await settle()
    globalThis.gc?.()
    const status = s.director!.status() as { director: { resources: Record<string, number> }, conversation: Record<string, number> }
    results.hostEvents = {
      beginTurnP50Ms: percentile(turnSamples, 0.5),
      beginTurnP95Ms: percentile(turnSamples, 0.95),
      speechReportP50Ms: percentile(speechSamples, 0.5),
      speechReportP95Ms: percentile(speechSamples, 0.95),
      heapGrowthKb: Math.round((process.memoryUsage().heapUsed - heapBefore) / 1024),
      resources: status.director.resources,
      ledger: status.conversation,
    }
    await s.close()
  }

  // Interruption: user voice to aborted Director output, measured as the synchronous handler time.
  {
    const s = stack(true)
    const samples: number[] = []
    for (let i = 0; i < 200; i++) {
      s.director!.beginTurn({ sessionId: 's', roundId: `i${i}`, characterId: 'mura' }, { model: 'companion-chat', messages: [{ role: 'user', content: 'hi' }] })
      await settle()
      const start = performance.now()
      s.stage.channel.emit('input:voice:activity', { active: true, inputId: `v${i}` })
      const aborted = (s.director!.status().director as { resources: { activeOutput: number } }).resources.activeOutput === 0
      samples.push(aborted ? performance.now() - start : Number.NaN)
      s.stage.channel.emit('input:voice:activity', { active: false, inputId: `v${i}` })
      await settle()
    }
    results.interruption = { p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), abortedEveryTime: samples.every(value => Number.isFinite(value)) }
    await s.close()
  }

  // Handoff: a pause moment to the stage's visual request through Director, relay, and R6 admission.
  {
    const samples: number[] = []
    for (let i = 0; i < 5; i++) {
      const s = stack(true)
      s.director!.beginTurn({ sessionId: 's', roundId: `h${i}`, characterId: 'mura' }, { model: 'companion-chat', messages: [{ role: 'user', content: 'hi' }] })
      s.extension.sendVideo({ isPlaying: true, currentTimeSec: 10 })
      await sleep(300)
      s.extension.sendVideo({ isPlaying: false, currentTimeSec: 10.3 })
      const paused = performance.now()
      while (s.stage.behaviors().length === 0 && performance.now() - paused < 5000)
        await sleep(5)
      // R6 requires a 1.5 s proven gap and admits on its 1 s tick, so the time includes that policy wait.
      samples.push(performance.now() - paused)
      await s.close()
    }
    results.pauseToStageRequest = { samplesMs: samples.map(value => Math.round(value)), note: 'includes the R6 1.5 s dialogue gap and its 1 s admission tick' }
  }

  console.info(JSON.stringify(results, null, 2))
  if (values.out)
    await writeFile(values.out, `${JSON.stringify(results, null, 2)}\n`, 'utf8')
  process.exit(0)
}

void main()
