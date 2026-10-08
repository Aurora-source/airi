import process from 'node:process'

import { Director } from '../../src/director'
import { simulateSession } from './session'
import { VirtualClock } from './virtual-clock'

/**
 * Emits content-free performance evidence. Optional exposed GC improves retained-heap repeatability.
 *
 * Call stack:
 *
 * measure.ts
 *   -> measureEvents -> Director.submit and flush
 *   -> measureIdle -> Director.advance
 *   -> simulateSession (./session) -> Director and existing R6 ReactionPolicy
 */
function measureEvents(events: number, storm: boolean) {
  const clock = new VirtualClock()
  const identity = { userId: 'benchmark', characterId: 'mura' }
  const director = new Director({ identity, profile: 'local', clock })
  globalThis.gc?.()
  const heapBefore = process.memoryUsage().heapUsed
  const cpuBefore = process.cpuUsage()
  const start = performance.now()
  for (let i = 0; i < events; i++) {
    director.submit({ type: 'conversation', id: `event-${i}`, identity, observedAt: clock.now(), requestId: `request-${i}`, addressed: false, significant: false, unresolved: false, affect: i % 2 ? 'amused' : 'concerned' })
    if (!storm)
      director.flush()
  }
  const queuedBeforeDrain = director.status().resources.queue
  while (director.status().resources.queue)
    director.flush()
  const elapsedMs = performance.now() - start
  const cpu = process.cpuUsage(cpuBefore)
  globalThis.gc?.()
  const retainedHeapBytes = process.memoryUsage().heapUsed - heapBefore
  const status = director.status()
  director.dispose()
  return { events, storm, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, eventsPerSecond: events / elapsedMs * 1000, retainedHeapBytes, queuedBeforeDrain, resources: status.resources, overflow: status.metrics.overflow }
}

function measureIdle() {
  const clock = new VirtualClock()
  const director = new Director({ identity: { userId: 'benchmark', characterId: 'idle' }, profile: 'local', clock })
  director.configure({ proactiveSpeech: true }, 'user')
  const start = performance.now()
  const cpuBefore = process.cpuUsage()
  for (let i = 0; i < 21600; i++) {
    clock.advance(2000)
    director.advance()
  }
  const cpu = process.cpuUsage(cpuBefore)
  const elapsedMs = performance.now() - start
  const status = director.status()
  director.dispose()
  return { virtualHours: 12, advances: 21600, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, speechAttempts: status.metrics.speechAttempts, reasoningAttempts: status.metrics.reasoningAttempts, timers: clock.pendingTimers, resources: status.resources }
}

async function main() {
  measureEvents(2000, false)
  const consecutive = measureEvents(100000, false)
  const storm = measureEvents(100000, true)
  const idle = measureIdle()
  const start = performance.now()
  const cpuBefore = process.cpuUsage()
  const session = await simulateSession()
  const cpu = process.cpuUsage(cpuBefore)
  console.info(JSON.stringify({ node: process.version, platform: process.platform, architecture: process.arch, exposedGc: typeof globalThis.gc === 'function', consecutive, storm, idle, session: { ...session, elapsedMs: performance.now() - start, cpuMs: (cpu.user + cpu.system) / 1000 } }, null, 2))
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
