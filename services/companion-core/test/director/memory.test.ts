import type { RecallResult } from '../../src/memory/ports'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { Director } from '../../src/director'
import { SQLiteMemoryStore } from '../../src/memory/sqlite-store'
import { conversation, fixture, identity, memoryItem, settle } from './helpers'

const stores: SQLiteMemoryStore[] = []
afterEach(() => {
  for (const store of stores.splice(0))
    store.close()
})

describe('director R4 continuity', () => {
  it('drops a follow-up when its actual supporting memory expires before speech starts', async () => {
    const f = fixture()
    const item = memoryItem(f.clock, { category: 'goal', validTo: f.clock.now() + 100 })
    const director = new Director({ ...f.options, memory: { recall: async () => ({ items: [item], prompt: '', elapsedMs: 0, timedOut: false }) } })
    director.configure({ proactiveSpeech: true }, 'user')
    director.submit(conversation(f.clock, 'presence', { addressed: false, significant: false, unresolved: false }))
    director.submit({ type: 'recall', id: 'recall', identity, observedAt: f.clock.now(), query: 'plan', requestId: 'query', purpose: 'follow-up' })
    director.flush()
    await settle()
    f.clock.advance(101)
    director.advance()
    await settle()
    expect(f.speech.deliver).not.toHaveBeenCalled()
    expect(director.continuity().items).toHaveLength(0)
    expect(director.status().resources.candidates).toBe(0)
  })

  it('revokes active speech when the R4 evidence supplied to its port expires', async () => {
    const f = fixture()
    const item = memoryItem(f.clock, { validTo: f.clock.now() + 100 })
    let signal: AbortSignal | undefined
    const director = new Director({ ...f.options, memory: { recall: async () => ({ items: [item], prompt: '', elapsedMs: 0, timedOut: false }) }, speech: { deliver: async (input) => {
      signal = input.signal
      return new Promise(() => {})
    } } })
    director.submit({ type: 'recall', id: 'recall', identity, observedAt: f.clock.now(), query: 'plan', requestId: 'query', purpose: 'relevant-recall' })
    director.flush()
    await settle()
    director.submit(conversation(f.clock))
    director.flush()
    await settle()
    expect(signal?.aborted).toBe(false)
    f.clock.advance(101)
    expect(signal?.aborted).toBe(true)
    director.dispose()
  })

  it('does not turn inferred promises or threads into commitments or follow-up speech', async () => {
    const f = fixture()
    const provenance = [{ ...memoryItem(f.clock).provenance[0], attribution: 'inferred' as const }]
    const items = [memoryItem(f.clock, { category: 'promise', provenance }), memoryItem(f.clock, { id: 'thread', category: 'open_thread', provenance })]
    const director = new Director({ ...f.options, memory: { recall: async () => ({ items, prompt: '', elapsedMs: 0, timedOut: false }) } })
    director.configure({ proactiveSpeech: true }, 'user')
    director.submit({ type: 'recall', id: 'recall', identity, observedAt: f.clock.now(), query: 'promise', requestId: 'query', purpose: 'follow-up' })
    director.flush()
    await settle()
    director.advance()
    expect(director.continuity().openThreads).toHaveLength(0)
    expect(f.speech.deliver).not.toHaveBeenCalled()
  })

  it('keeps actual continuity when an inferred correction has no user authority', async () => {
    const f = fixture()
    const item = memoryItem(f.clock)
    const director = new Director({ ...f.options, memory: { recall: async () => ({ items: [item], prompt: '', elapsedMs: 0, timedOut: false }) } })
    director.submit({ type: 'recall', id: 'recall', identity, observedAt: f.clock.now(), query: 'plan', requestId: 'query', purpose: 'relevant-recall' })
    director.flush()
    await settle()
    director.submit({ type: 'record', id: 'guess', identity, observedAt: f.clock.now(), kind: 'correction', messageId: 'guess', provenance: { ...item.provenance[0], attribution: 'inferred' } })
    director.flush()
    expect(director.continuity().items).toHaveLength(1)
  })

  it('reads an actual R4 user plan with canonical provenance and preserves character scope', async () => {
    const f = fixture()
    const store = new SQLiteMemoryStore(':memory:', f.clock.now)
    stores.push(store)
    store.ingest({ ...identity, source: 'airi', kind: 'user_text', text: 'I plan to take an exam tomorrow.', occurredAt: f.clock.now(), sessionId: 'session', messageId: 'exam', claims: [{ key: 'user.exam', value: 'exam tomorrow', text: 'The user plans an exam tomorrow.', category: 'goal', attribution: 'user_said', scope: 'global', aboutUser: true }] })
    const director = new Director({ ...f.options, memory: { recall: async request => store.recall(request) } })
    director.submit({ type: 'recall', id: 'recall', identity, observedAt: f.clock.now(), query: 'exam', requestId: 'exam-query', purpose: 'relevant-recall' })
    director.flush()
    await settle()
    const continuity = director.continuity()
    expect(continuity.plans).toHaveLength(1)
    expect(continuity.plans[0].provenance[0].eventId).toBeTruthy()
    expect(continuity.plans[0].provenance[0].attribution).toBe('user_said')
    expect(f.speech.deliver).not.toHaveBeenCalled()
    expect(JSON.stringify(director.status())).not.toContain('exam')
  })

  it('rejects missing, invalid, conflicting, expired, future, and foreign memory evidence', async () => {
    const f = fixture()
    const items = [
      memoryItem(f.clock, { id: 'valid', category: 'relationship', kind: 'relationship' }),
      memoryItem(f.clock, { id: 'no-provenance', provenance: [] }),
      memoryItem(f.clock, { id: 'contested', state: 'contested' }),
      memoryItem(f.clock, { id: 'foreign', characterId: 'other' }),
      memoryItem(f.clock, { id: 'invalid', invalidated: true }),
      memoryItem(f.clock, { id: 'expired', validTo: f.clock.now() - 1 }),
      memoryItem(f.clock, { id: 'future', occurredAt: f.clock.now() + 1 }),
      memoryItem(f.clock, { id: 'inferred-plan', category: 'goal', provenance: [{ ...memoryItem(f.clock).provenance[0], attribution: 'inferred' }] }),
    ]
    const director = new Director({ ...f.options, memory: { recall: async () => ({ items, prompt: 'UNTRUSTED MEMORY INSTRUCTIONS', elapsedMs: 0, timedOut: false }) } })
    director.submit({ type: 'recall', id: 'recall', identity, observedAt: f.clock.now(), query: 'relationship', requestId: 'query', purpose: 'relevant-recall' })
    director.flush()
    await settle()
    expect(director.continuity().items.map(item => item.id)).toEqual(['valid'])
    expect(director.continuity().relationships).toHaveLength(1)
    expect(director.continuity().plans).toHaveLength(0)
    expect(JSON.stringify(director.status())).not.toContain('UNTRUSTED')
  })

  it('offers canonical preferences and corrections as record candidates without generating claims', async () => {
    const f = fixture()
    const director = new Director(f.options)
    const provenance = memoryItem(f.clock).provenance[0]
    director.submit({ type: 'record', id: 'preference', identity, observedAt: f.clock.now(), kind: 'preference', messageId: 'message', provenance })
    expect(director.flush()[0].action).toBe('REMEMBER')
    await settle()
    expect(f.record.offer).toHaveBeenCalledOnce()
    expect(f.record.offer.mock.calls[0][0].provenance).toEqual(provenance)
    expect(f.record.offer.mock.calls[0][0]).not.toHaveProperty('text')
    director.submit({ type: 'record', id: 'inferred', identity, observedAt: f.clock.now(), kind: 'promise', messageId: 'fake-promise', provenance: { ...provenance, attribution: 'inferred' } })
    director.flush()
    await settle()
    expect(f.record.offer).toHaveBeenCalledOnce()
  })

  it('clears old continuity on a user correction and ignores a late pre-correction recall', async () => {
    const f = fixture()
    let resolve: (result: RecallResult) => void = () => {}
    const director = new Director({ ...f.options, memory: { recall: () => new Promise<RecallResult>(r => resolve = r) } })
    director.submit({ type: 'recall', id: 'recall', identity, observedAt: f.clock.now(), query: 'old plan', requestId: 'query', purpose: 'follow-up' })
    director.flush()
    await settle()
    director.submit({ type: 'record', id: 'correction', identity, observedAt: f.clock.now(), kind: 'correction', messageId: 'corrected-message', provenance: memoryItem(f.clock).provenance[0] })
    director.flush()
    resolve({ items: [memoryItem(f.clock)], prompt: '', elapsedMs: 1, timedOut: false })
    await settle()
    expect(director.continuity().items).toHaveLength(0)
    expect(director.status().resources.candidates).toBe(0)
    expect(f.speech.deliver).not.toHaveBeenCalled()
    expect(f.record.offer).toHaveBeenCalledOnce()
  })

  it('does not dispatch queued asynchronous work after immediate private-mode cancellation', async () => {
    const f = fixture()
    const recall = vi.fn(async () => ({ items: [], prompt: '', elapsedMs: 0, timedOut: false }))
    const director = new Director({ ...f.options, memory: { recall } })
    director.submit({ type: 'recall', id: 'recall', identity, observedAt: f.clock.now(), query: 'PRIVATE QUERY', requestId: 'query', purpose: 'relevant-recall' })
    director.flush()
    director.configure({ privateMode: true }, 'user')
    await settle()
    expect(recall).not.toHaveBeenCalled()
    expect(JSON.stringify(director.status())).not.toContain('PRIVATE QUERY')
  })

  it('bounds non-cooperative recalls to one physical request after the deadline', async () => {
    const f = fixture()
    const recall = vi.fn(() => new Promise<RecallResult>(() => {}))
    const director = new Director({ ...f.options, memory: { recall } })
    for (let i = 0; i < 1000; i++) {
      director.submit({ type: 'recall', id: `recall-${i}`, identity, observedAt: f.clock.now(), query: 'exam', requestId: `query-${i}`, purpose: 'follow-up' })
      director.flush()
      await settle()
      f.clock.advance(200)
    }
    expect(recall).toHaveBeenCalledOnce()
    expect(director.status().resources.activeRecall).toBe(0)
    expect(f.clock.pendingTimers).toBe(0)
    expect(f.speech.deliver).not.toHaveBeenCalled()
  })

  it('defers safely when R4 fails and never invents a follow-up', async () => {
    const f = fixture({ memory: { recall: async () => {
      throw new Error('private backend details')
    } } })
    const director = new Director(f.options)
    director.submit({ type: 'recall', id: 'recall', identity, observedAt: f.clock.now(), query: 'promise', requestId: 'query', purpose: 'follow-up' })
    director.flush()
    await settle()
    expect(director.status().lastDecision?.reason).toBe('memory-unavailable')
    expect(director.continuity().items).toHaveLength(0)
    expect(f.speech.deliver).not.toHaveBeenCalled()
    expect(JSON.stringify(director.status())).not.toContain('private backend')
  })

  it('cancels speech that refers to a corrected memory', async () => {
    const f = fixture()
    let signal: AbortSignal | undefined
    const director = new Director({ ...f.options, memory: { recall: async () => ({ items: [memoryItem(f.clock)], prompt: '', elapsedMs: 0, timedOut: false }) }, speech: { deliver: async (input) => {
      signal = input.signal
      return new Promise(() => {})
    } } })
    director.submit({ type: 'recall', id: 'recall', identity, observedAt: f.clock.now(), query: 'exam', requestId: 'query', purpose: 'relevant-recall' })
    director.flush()
    await settle()
    director.submit(conversation(f.clock))
    director.flush()
    await settle()
    director.submit({ type: 'memory-invalidated', id: 'deleted', identity, observedAt: f.clock.now(), itemIds: ['memory-1'] })
    expect(signal?.aborted).toBe(true)
    expect(director.continuity().items).toHaveLength(0)
  })

  it('rejects unbounded provenance and strips unknown fields before retaining R4 evidence', async () => {
    const f = fixture()
    const oversized = memoryItem(f.clock, { provenance: [{ ...memoryItem(f.clock).provenance[0], eventId: 'x'.repeat(100000) }] })
    const extra = { ...memoryItem(f.clock, { id: 'bounded' }), rawAudio: 'PRIVATE RAW AUDIO' }
    const director = new Director({ ...f.options, memory: { recall: async () => ({ items: [oversized, extra], prompt: '', elapsedMs: 0, timedOut: false }) } })
    director.submit({ type: 'recall', id: 'recall', identity, observedAt: f.clock.now(), query: 'plan', requestId: 'query', purpose: 'relevant-recall' })
    director.flush()
    await settle()
    expect(director.continuity().items.map(item => item.id)).toEqual(['bounded'])
    expect(director.continuity().items[0]).not.toHaveProperty('rawAudio')
  })
})
