import { describe, expect, it } from 'vitest'

import { ChangeDetector } from '../../src/perception/change-detection/detector'
import { parseObservation } from '../../src/perception/observations/schema'
import { PrivacyGate } from '../../src/perception/privacy/gate'
import { Scheduler } from '../../src/perception/scheduler/scheduler'
import { WorldState } from '../../src/perception/world-state/store'
import { facts, frame, observation } from './helpers'

describe('local change detection', () => {
  it('suppresses identical and duplicate frames', () => {
    const detector = new ChangeDetector()
    const a = detector.inspect(frame())
    detector.accept(a.signature)
    expect(detector.inspect(frame()).level).toBe('unchanged')
    expect(detector.inspect(frame()).duplicate).toBe(true)
  })

  it('classifies cursor, UI and scene changes deterministically', () => {
    const detector = new ChangeDetector()
    detector.accept(detector.inspect(frame()).signature)
    const cursor = frame()
    cursor.samples[0] = 250
    expect(detector.inspect(cursor).level).toBe('minor')
    expect(detector.inspect(frame({ samples: new Uint8Array(2304).fill(115) })).level).toBe('meaningful')
    expect(detector.inspect(frame({ samples: new Uint8Array(2304).fill(230) })).level).toBe('major')
    const uiText = frame()
    uiText.samples.fill(230, 0, 240)
    expect(detector.inspect(uiText).level).toBe('meaningful')
  })

  it('treats app, window, source and display changes as major', () => {
    const detector = new ChangeDetector()
    detector.accept(detector.inspect(frame()).signature)
    for (const source of [
      { ...frame().source, foreground_app: 'browser' },
      { ...frame().source, window_id: 'other' },
      { ...frame().source, generation: 2 },
      { ...frame().source, display_id: 'other' },
    ]) expect(detector.inspect(frame({ source })).level).toBe('major')
  })

  it('blocks protected black video frames', () => {
    expect(new ChangeDetector().inspect(frame({ media_hint: 'video', samples: new Uint8Array(2304) })).protected).toBe(true)
  })
})

describe('privacy before upload', () => {
  it('fails closed for unknown contexts and allows an explicit manual authorization', () => {
    const gate = new PrivacyGate()
    const unknown = frame({ safety: {} })
    expect(gate.evaluate(unknown).state).toBe('UNKNOWN')
    expect(gate.evaluate(unknown, { authorize_unknown: true }).state).toBe('ALLOW')
  })

  it('never bypasses pause, deny lists, private contexts or lock screens', () => {
    const gate = new PrivacyGate({ excluded_apps: ['password-manager'], excluded_windows: ['secret'] })
    for (const blocked of [
      frame({ safety: { ...frame().safety, private_context: true } }),
      frame({ safety: { ...frame().safety, locked: true } }),
      frame({ safety: { ...frame().safety, sensitive: true } }),
      frame({ source: { ...frame().source, foreground_app: 'Password-Manager' } }),
      frame({ source: { ...frame().source, window_title: 'my SECRET vault' } }),
    ]) expect(gate.evaluate(blocked, { authorize_unknown: true }).state).toBe('BLOCK')
    gate.update({ paused: true })
    expect(gate.evaluate(frame(), { authorize_unknown: true }).state).toBe('BLOCK')
  })

  it('keeps limited applications capture-only and revisions observable', () => {
    const gate = new PrivacyGate({ limited_apps: ['editor'] })
    expect(gate.evaluate(frame()).state).toBe('LIMITED')
    const revision = gate.revision
    gate.update({ paused: true })
    expect(gate.revision).toBeGreaterThan(revision)
  })
})

describe('scheduler', () => {
  it('debounces meaningful changes and enforces a cooldown', () => {
    const scheduler = new Scheduler({ debounce_ms: 100, minimum_interval_ms: 1000 })
    const changed = { available: true, allowed: true, level: 'meaningful' as const, duplicate: false }
    expect(scheduler.decide({ ...changed, now: 0 })).toBe('capture-only')
    expect(scheduler.decide({ ...changed, now: 100 })).toBe('vision-request')
    scheduler.attempted(100)
    expect(scheduler.decide({ ...changed, now: 500 })).toBe('capture-only')
    expect(scheduler.decide({ ...changed, now: 1100 })).toBe('vision-request')
  })

  it('does no constant vision polling and supports optional idle refresh', () => {
    const input = { available: true, allowed: true, level: 'unchanged' as const, duplicate: true, now: 120000, last_success_at: 0 }
    expect(new Scheduler().decide(input)).toBe('capture-only')
    expect(new Scheduler({ maximum_idle_refresh_ms: 60000 }).decide(input)).toBe('vision-request')
    expect(new Scheduler().decide({ ...input, allowed: false })).toBe('capture-only')
    expect(new Scheduler().decide({ ...input, available: false })).toBe('skip')
  })

  it('respects rate-limit backoff even for manual look-now', () => {
    const scheduler = new Scheduler()
    scheduler.failed(100, 5000)
    expect(scheduler.decide({ now: 1000, available: true, allowed: true, manual: true, level: 'major', duplicate: false })).toBe('capture-only')
  })
})

describe('bounded observations and current world', () => {
  it('strictly rejects malformed, excessive and speculative provider output', () => {
    for (const value of [{}, { ...facts(), confidence: 2 }, { ...facts(), concise_summary: 'a'.repeat(321) }, { ...facts(), identity: 'Alice' }])
      expect(() => parseObservation(value)).toThrow()
    expect(parseObservation(JSON.stringify(facts())).concise_summary).toBe('An editor is visible.')
    expect(parseObservation({ ...facts(), people_count: null }).people_count).toBeUndefined()
  })

  it('expires observations at the capture-based TTL', () => {
    const state = new WorldState()
    state.accept(observation(), 100)
    expect(state.query(1099).status).toBe('fresh')
    expect(state.query(1100).status).toBe('stale')
    expect('observation' in state.query(1100)).toBe(false)
  })

  it('rejects older completion and already expired observations', () => {
    const state = new WorldState()
    state.accept(observation({ captured_at: 200, valid_until: 1200 }), 200)
    expect(state.accept(observation(), 300)).toBe(false)
    expect(state.accept(observation({ captured_at: 400, valid_until: 500 }), 500)).toBe(false)
    const current = state.query(300)
    expect(current.status === 'fresh' && current.observation.captured_at).toBe(200)
  })

  it('reduces low-confidence detail and keeps one disappearing object uncertain', () => {
    const state = new WorldState()
    state.accept(observation({ notable_objects: ['dialog'] }), 100)
    state.accept(observation({ captured_at: 200, valid_until: 1200, notable_objects: [] }), 200)
    const current = state.query(200)
    expect(current.status === 'fresh' && current.uncertain_objects).toEqual(['dialog'])
    state.accept(observation({ captured_at: 300, valid_until: 1300, confidence: 0.2, visible_text_summary: 'GUESS', notable_objects: ['guess'] }), 300)
    const low = state.query(300)
    expect(low.status === 'fresh' && low.observation.visible_text_summary).toBe('')
    expect(low.status === 'fresh' && low.observation.notable_objects).toEqual([])
  })

  it('clears uncertainty on an app switch and protects snapshots from mutation', () => {
    const state = new WorldState()
    state.accept(observation({ notable_objects: ['dialog'] }), 100)
    state.accept(observation({ captured_at: 200, valid_until: 1200, source: { ...frame().source, foreground_app: 'browser' } }), 200)
    const current = state.query(200)
    expect(current.status === 'fresh' && current.uncertain_objects).toEqual([])
    if (current.status === 'fresh')
      current.observation.notable_objects.push('mutated')
    const next = state.query(200)
    expect(next.status === 'fresh' && next.observation.notable_objects).not.toContain('mutated')
  })
})
