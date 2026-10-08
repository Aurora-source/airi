import { describe, expect, it } from 'vitest'

import { Director } from '../../src/director'
import { conversation, fixture, identity, settle, speechEvent } from './helpers'

describe('director local policy', () => {
  it('defaults to silence through twelve hours of idle without scheduling model polls', () => {
    const f = fixture()
    const director = new Director(f.options)
    director.submit({ type: 'activity', id: 'idle', identity, observedAt: f.clock.now(), activity: 'idle', source: 'user-declared', confidence: 1 })
    director.flush()
    for (let i = 0; i < 21600; i++) {
      f.clock.advance(2000)
      director.advance()
    }
    expect(f.speech.deliver).not.toHaveBeenCalled()
    expect(f.visual.request).not.toHaveBeenCalled()
    expect(director.status().configuration.proactiveSpeech).toBe(false)
    expect(f.clock.pendingTimers).toBe(0)
    expect(director.status().attention.activity).toBe('unknown')
  })

  it('answers an actual direct request while proactive speech remains disabled', async () => {
    const f = fixture()
    const director = new Director(f.options)
    expect(director.submit(conversation(f.clock))).toBe('accepted')
    expect(director.flush()[0].action).toBe('SPEAK')
    await settle()
    expect(f.speech.deliver).toHaveBeenCalledOnce()
    expect(f.speech.deliver.mock.calls[0][0].intent).toBe('respond-user')
    expect(director.status().configuration.proactiveSpeech).toBe(false)
  })

  it('preempts immediately on user speech even before the queue drains', async () => {
    let signal: AbortSignal | undefined
    const f = fixture({ speech: { deliver: async (input) => {
      signal = input.signal
      return new Promise(() => {})
    } } })
    const director = new Director(f.options)
    director.submit(conversation(f.clock))
    director.flush()
    await settle()
    expect(signal?.aborted).toBe(false)
    director.submit(speechEvent(f.clock, true))
    expect(signal?.aborted).toBe(true)
    expect(director.status().attention.activity).toBe('user-speaking')
    expect(director.status().resources.activeOutput).toBe(0)
  })

  it('waits while a user speaks and releases a fresh unresolved request after the end edge', async () => {
    const f = fixture()
    const director = new Director(f.options)
    director.submit(speechEvent(f.clock, true))
    director.submit(conversation(f.clock))
    director.flush()
    expect(f.speech.deliver).not.toHaveBeenCalled()
    expect(director.status().lastDecision?.reason).toBe('user-speaking')
    f.clock.advance(1000)
    director.submit(speechEvent(f.clock, false, 'speech-end'))
    director.flush()
    await settle()
    expect(f.speech.deliver).toHaveBeenCalledOnce()
  })

  it('never treats an expired speech lease as a fresh presence signal', () => {
    const f = fixture()
    const director = new Director(f.options)
    director.submit(speechEvent(f.clock, true))
    director.flush()
    f.clock.advance(60001)
    director.advance()
    expect(director.status().attention.activity).toBe('unknown')
    expect(f.speech.deliver).not.toHaveBeenCalled()
  })

  it('preserves gradual mood through 1500 consecutive alternating reactions', () => {
    const f = fixture()
    const director = new Director(f.options)
    const initial = director.status().mood
    for (let i = 0; i < 1500; i++) {
      director.submit(conversation(f.clock, `turn-${i}`, { addressed: false, unresolved: false, significant: false, affect: i % 2 ? 'concerned' : 'amused' }))
      director.flush()
    }
    const mood = director.status().mood
    expect(Math.abs(mood.valence - initial.valence)).toBeLessThanOrEqual(0.04)
    expect(mood.arousal).toBeGreaterThanOrEqual(0)
    expect(mood.arousal).toBeLessThanOrEqual(1)
    expect(f.speech.deliver).not.toHaveBeenCalled()
    f.clock.advance(2 * 60 * 60 * 1000)
    director.advance()
    expect(director.status().reaction).toBeUndefined()
    expect(Math.abs(director.status().mood.valence - initial.valence)).toBeLessThan(0.01)
  })

  it('bounds an event storm and never lets queue overflow delay speech preemption', () => {
    const f = fixture()
    const director = new Director(f.options)
    for (let i = 0; i < 5000; i++)
      director.submit(conversation(f.clock, `storm-${i}`, { addressed: false, unresolved: false, significant: false }))
    expect(director.status().resources.queue).toBeLessThanOrEqual(128)
    expect(director.status().resources.eventIds).toBeLessThanOrEqual(256)
    expect(director.status().metrics.overflow).toBeGreaterThan(0)
    director.submit(speechEvent(f.clock, true))
    expect(director.status().attention.activity).toBe('user-speaking')
    while (director.status().resources.queue)
      expect(director.flush().length).toBeLessThanOrEqual(32)
    expect(director.status().resources.candidates).toBeLessThanOrEqual(16)
    expect(director.status().resources.history).toBeLessThanOrEqual(64)
    expect(f.speech.deliver).not.toHaveBeenCalled()
  })

  it('suppresses duplicate IDs and repeated canonical requests', async () => {
    const f = fixture()
    const director = new Director(f.options)
    const event = conversation(f.clock)
    expect(director.submit(event)).toBe('accepted')
    expect(director.submit(event)).toBe('duplicate')
    director.flush()
    await settle()
    director.submit(conversation(f.clock, 'retry', { requestId: 'request-1' }))
    director.flush()
    await settle()
    expect(f.speech.deliver).toHaveBeenCalledOnce()
  })

  it('honors quiet mode, private mode, and explicit user control', () => {
    const f = fixture()
    const director = new Director(f.options)
    expect(director.configure({ proactiveSpeech: true }, 'system')).toBe(false)
    expect(director.configure({ proactiveSpeech: true }, 'user')).toBe(true)
    director.configure({ quietMode: true }, 'user')
    director.submit(conversation(f.clock))
    director.flush()
    expect(director.status().lastDecision?.reason).toBe('quiet-mode')
    expect(f.speech.deliver).not.toHaveBeenCalled()
    expect(f.visual.request).not.toHaveBeenCalled()
    director.configure({ privateMode: true }, 'user')
    expect(director.submit(conversation(f.clock, 'private'))).toBe('disabled')
    expect(director.status().resources.queue).toBe(0)
    expect(director.continuity().items).toHaveLength(0)
  })

  it('isolates character identities and rejects stale, future, and malformed events', () => {
    const f = fixture()
    const director = new Director(f.options)
    expect(director.submit(conversation(f.clock, 'other', { identity: { userId: 'user-1', characterId: 'other' } }))).toBe('wrong-identity')
    expect(director.submit(conversation(f.clock, 'stale', { observedAt: f.clock.now() - 60000 }))).toBe('stale')
    expect(director.submit(conversation(f.clock, 'future', { observedAt: f.clock.now() + 1 }))).toBe('stale')
    expect(director.submit({ type: 'configure', proactiveSpeech: true })).toBe('invalid')
    expect(director.status().resources.queue).toBe(0)
    expect(f.speech.deliver).not.toHaveBeenCalled()
  })
})
