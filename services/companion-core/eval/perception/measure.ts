import type { ObservationFacts, ScreenFrame, VisionObservationPort } from '../../src/perception/ports/contracts'

import process from 'node:process'

import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'

import { sampleLuminance } from '../../src/perception/capture/luminance'
import { OwnedScreenCapture } from '../../src/perception/capture/owner'
import { ChangeDetector } from '../../src/perception/change-detection/detector'
import { PrivacyGate } from '../../src/perception/privacy/gate'
import { PerceptionService } from '../../src/perception/service'
import { VisionChain } from '../../src/perception/vision/chain'

/**
 * Measures deterministic local work and a real idle scheduler with a synthetic capture backend.
 * No cloud requests, native desktop capture, or GPU inference occur in this benchmark.
 *
 * Call stack:
 * measure
 *   -> sampleLuminance / ChangeDetector
 *   -> PerceptionService.start -> synthetic capture -> stub vision
 */
async function measure(): Promise<void> {
  const rgba = new Uint8Array(1920 * 1080 * 4).fill(100)
  const times: number[] = []
  for (let i = 0; i < 1200; i++) {
    const start = performance.now()
    sampleLuminance(rgba, 1920, 1080)
    if (i >= 200)
      times.push(performance.now() - start)
  }
  rgba.fill(0)
  const makeFrame = (): ScreenFrame => ({
    capture_id: 'synthetic',
    captured_at: Date.now(),
    width: 1920,
    height: 1080,
    source: { kind: 'reference', id: 'benchmark', generation: 1, foreground_app: 'fixture' },
    samples: new Uint8Array(2304).fill(100),
    image: { mime_type: 'image/png', bytes: new Uint8Array([1, 2, 3]) },
    safety: { private_context: false, locked: false, sensitive: false },
  })
  const detector = new ChangeDetector()
  const reference = makeFrame()
  detector.accept(detector.inspect(reference).signature)
  const detection: number[] = []
  for (let i = 0; i < 1200; i++) {
    const start = performance.now()
    detector.inspect(reference)
    if (i >= 200)
      detection.push(performance.now() - start)
  }
  const facts: ObservationFacts = { confidence: 1, scene_type: 'desktop', activity: 'static', visible_text_summary: '', notable_objects: [], media: { detected: false, playback: 'unknown', title_like_text: '', subtitle_like_text: '' }, warnings: [], concise_summary: 'Synthetic desktop.' }
  const adapter: VisionObservationPort = { id: 'stub', locality: 'cloud', capabilities: { vision: true, structured_output: true }, observe: async () => facts }
  const service = new PerceptionService({ capture: new OwnedScreenCapture({ capture: async () => makeFrame(), shutdown: async () => {} }), privacy: new PrivacyGate(), vision: new VisionChain({ profile: 'cloud', adapters: [adapter] }) })
  const cpuStart = process.cpuUsage()
  const wallStart = performance.now()
  const memoryStart = process.memoryUsage()
  service.start(1000)
  await setTimeout(10100)
  await service.shutdown()
  const wall = performance.now() - wallStart
  const cpu = process.cpuUsage(cpuStart)
  const memoryEnd = process.memoryUsage()
  const quantiles = (values: number[]) => {
    values.sort((a, b) => a - b)
    return { p50_ms: values[Math.floor(values.length * 0.5)], p95_ms: values[Math.floor(values.length * 0.95)] }
  }
  console.info(JSON.stringify({ kind: 'synthetic-local-and-idle', sample_iterations: times.length, sampling_1080p: quantiles(times), detection_2304_cells: quantiles(detection), wall_ms: wall, cpu_ms: (cpu.user + cpu.system) / 1000, one_core_cpu_percent: (cpu.user + cpu.system) / (wall * 10), rss_start_bytes: memoryStart.rss, rss_end_bytes: memoryEnd.rss, heap_start_bytes: memoryStart.heapUsed, heap_end_bytes: memoryEnd.heapUsed, metrics: service.metrics(), native_capture_measured: false, cloud_latency_measured: false, gpu_measured: false }))
}

void measure().catch(() => {
  console.error('Perception measurement failed')
  process.exitCode = 1
})
