#!/usr/bin/env tsx
import type { PlayerObservation, PlayerRef } from '../../src/watch/sources'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'

import { errorMessageFrom } from '@moeru/std'

import { JellyfinAdapter } from '../../src/companion/sources/jellyfin'
import { MpvAdapter } from '../../src/companion/sources/mpv'
import { serverBase } from '../../src/companion/sources/network'
import { VlcAdapter } from '../../src/companion/sources/vlc'
import { watchUnit } from '../../src/companion/watch-context'
import { MediaSourceManager } from '../../src/watch/source-manager'
import { WatchState } from '../../src/watch/state'
import { FakeJellyfin, TOKEN } from '../../test/support/fake-jellyfin'
import { FakeMpv } from '../../test/support/fake-mpv'

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits))
}

/** Heap after a full collection, when the run allows `--expose-gc`. */
function heap(): number {
  const gc = (globalThis as { gc?: () => void }).gc
  gc?.()
  return process.memoryUsage().heapUsed
}

/**
 * Measures the local media path: source manager plus WatchState per observation, heap over a long session, the WATCH
 * block, subtitle propagation through a real named pipe, and idle CPU of the three adapters.
 *
 * Usage: node --expose-gc --import tsx eval/watch/perf-sources.mts --out <result.json>
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string' } } })
  if (!values.out)
    throw new Error('Usage: perf-sources.mts --out <result.json>')
  const results: Record<string, unknown> = {}

  // 1. One player through manager and WatchState: one video per simulated second, one subtitle every two seconds.
  {
    let clock = 1_000_000
    const now = () => clock
    const manager = new MediaSourceManager({ now, staleMs: 120_000, takeoverMs: 35_000 })
    let state: WatchState | undefined
    const apply = (outputs: ReturnType<MediaSourceManager['observe']>) => {
      for (const output of outputs) {
        if (output.kind === 'start') {
          state = new WatchState({ now })
          state.connect(output.session)
        }
        else if (output.kind === 'update') {
          state!.ingest(output.update)
        }
      }
    }
    const ref: PlayerRef = { key: 'mpv:perf', kind: 'mpv', reach: 'direct', eligible: true, links: [] }
    let sequence = 0
    const video = (position: number): PlayerObservation => ({ player: ref, update: { kind: 'video', stamp: { session: 1, sequence: ++sequence, observed_at: clock, timeline: 0 }, media: { id: 'local:perf', site: 'local', player: 'mpv', title: { value: 'Sousou no Frieren', source: 'player', confidence: 0.6, observed_at: clock, valid_until: clock + 35_000 } }, playing: true, position, rate: 1, source: 'player', captions: { form: 'text', language: 'ja' } } })
    const subtitle = (index: number): PlayerObservation => ({ player: ref, update: { kind: 'subtitle', stamp: { session: 1, sequence: ++sequence, observed_at: clock, timeline: 0 }, media_id: 'local:perf', text: `フリーレン様、\n台詞 ${index % 500}`, language: 'ja', start_ms: index * 1000, end_ms: index * 1000 + 1500, automatic: false } })
    const total = 600_000
    // Preallocated, so the measurement itself does not grow the heap.
    const timings = new Float64Array(total)
    const heapPoints: Array<{ events: number, heapBytes: number }> = []
    for (let i = 0; i < total; i++) {
      clock += 500
      const observation = i % 2 === 0 ? video(i / 2) : subtitle(i)
      const started = performance.now()
      apply(manager.observe(observation))
      timings[i] = performance.now() - started
      if (i === 20_000 || i % 150_000 === 0)
        heapPoints.push({ events: i, heapBytes: heap() })
    }
    heapPoints.push({ events: total, heapBytes: heap() })
    const unitTimes: number[] = []
    for (let i = 0; i < 2000; i++) {
      const started = performance.now()
      watchUnit(state!.current(), { verifiedContext: [], spoilerBoundary: 'progress-unknown' }, clock)
      unitTimes.push(performance.now() - started)
    }
    const unit = watchUnit(state!.current(), { verifiedContext: [], spoilerBoundary: 'progress-unknown' }, clock)
    const sample = Array.from(timings)
    results.managerAndState = { events: total, p50Ms: round(percentile(sample, 0.5)), p95Ms: round(percentile(sample, 0.95)), p99Ms: round(percentile(sample, 0.99)), heap: heapPoints, refused: manager.refused }
    results.watchBlock = { p50Ms: round(percentile(unitTimes, 0.5)), p95Ms: round(percentile(unitTimes, 0.95)), bytes: Buffer.byteLength(String(unit?.message.content ?? '')) }
  }

  // 2. Subtitle propagation through a real named pipe: mpv's property change to the adapter's observation.
  {
    const mpv = new FakeMpv({ 'pause': false, 'speed': 1, 'duration': 1420, 'time-pos': 10, 'sid': 1, 'secondary-sid': false, 'track-list': [{ id: 1, type: 'sub', codec: 'ass', lang: 'jpn' }], 'sub-text': '', 'sub-delay': 0, 'sub-speed': 1, 'mpv-version': 'mpv v0.41.0', 'path': 'D:\\perf.mkv', 'media-title': 'Perf - 01.mkv' })
    await mpv.listen()
    const arrivals: number[] = []
    const adapter = new MpvAdapter({ endpoints: [{ pipe: mpv.pipe, player: 'mpv' }], now: Date.now, heartbeatMs: 60_000, retryMs: 50, maxRetryMs: 100 })
    adapter.start({ observe: (observation) => {
      if (observation.update.kind === 'subtitle')
        arrivals.push(performance.now())
    }, gone: () => {} })
    while (adapter.status().players === 0)
      await new Promise(done => setTimeout(done, 10))
    const latencies: number[] = []
    for (let i = 0; i < 300; i++) {
      const before = arrivals.length
      mpv.properties['sub-text/ass-full'] = `Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0000,0000,0000,,行 ${i}`
      mpv.properties['sub-end'] = 2 + i
      const sent = performance.now()
      mpv.set('sub-text', `行 ${i}`)
      while (arrivals.length === before)
        await new Promise(done => setImmediate(done))
      latencies.push(arrivals.at(-1)! - sent)
    }
    await adapter.stop()
    await mpv.close()
    results.mpvSubtitlePropagation = { samples: latencies.length, p50Ms: round(percentile(latencies, 0.5), 3), p95Ms: round(percentile(latencies, 0.95), 3), maxMs: round(Math.max(...latencies), 3) }
  }

  // 3. Idle cost: every adapter enabled, no player running, Jellyfin answering an empty session list.
  {
    const jellyfin = new FakeJellyfin()
    const base = await jellyfin.listen()
    const adapters = [
      new MpvAdapter({ endpoints: [{ pipe: 'airi-perf-missing', player: 'mpv' }], now: Date.now }),
      new VlcAdapter({ port: 1, password: 'perf', now: Date.now }),
      new JellyfinAdapter({ base: serverBase(base), token: TOKEN, now: Date.now, hostname: 'perf-host', lookup: async () => [], followThisComputer: true, devices: [], serverSubtitles: true }),
    ]
    for (const adapter of adapters)
      adapter.start({ observe: () => {}, gone: () => {} })
    const cpuBefore = process.cpuUsage()
    const wallBefore = performance.now()
    const heapBefore = heap()
    const heapSamples: number[] = []
    for (let i = 0; i < 6; i++) {
      await new Promise(done => setTimeout(done, 20_000))
      heapSamples.push(heap())
    }
    const cpu = process.cpuUsage(cpuBefore)
    const wall = performance.now() - wallBefore
    const requests = jellyfin.requests.length
    for (const adapter of adapters)
      await adapter.stop()
    await jellyfin.close()
    results.idle = { seconds: round(wall / 1000, 1), cpuPercentOfOneCore: round((cpu.user + cpu.system) / 1000 / wall * 100, 3), heapBefore, heapEvery20s: heapSamples, jellyfinRequestsPerMinute: round(requests / (wall / 60_000), 1) }
  }

  await mkdir(dirname(values.out), { recursive: true })
  await writeFile(values.out, `${JSON.stringify(results, null, 2)}\n`, 'utf8')
  console.info(JSON.stringify(results))
  process.exit(0)
}

main().catch((error: unknown) => {
  console.error(errorMessageFrom(error) ?? 'perf-sources failed')
  process.exit(1)
})
