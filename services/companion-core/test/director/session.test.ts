import { describe, expect, it } from 'vitest'

import { simulateSession } from '../../eval/director/session'
import { Director } from '../../src/director'
import { conversation, fixture, identity, settle } from './helpers'

describe('synthetic long companion sessions', () => {
  it('runs eight hours with conversation, work, anime, idle, absence, and quiet periods', async () => {
    const result = await simulateSession()
    expect(result.virtualHours).toBe(8)
    expect(result.events).toBeGreaterThan(1000)
    expect(result.reactiveSpeech).toBeGreaterThan(0)
    expect(result.watchVisuals).toBeGreaterThan(0)
    expect(result.idleSpeech).toBe(0)
    expect(result.absentSpeech).toBe(0)
    expect(result.quietSpeech).toBe(0)
    expect(result.watchSpeech).toBe(0)
    expect(result.reasoningRequests).toBe(0)
    expect(result.peak.queue).toBeLessThanOrEqual(128)
    expect(result.peak.eventIds).toBeLessThanOrEqual(256)
    expect(result.peak.candidates).toBeLessThanOrEqual(16)
    expect(result.peak.history).toBeLessThanOrEqual(64)
    expect(result.peak.timers).toBeLessThanOrEqual(4)
    expect(result.remainingTimers).toBe(0)
  })

  it('keeps six idle hours silent after proactive speech is explicitly enabled', async () => {
    const f = fixture()
    const director = new Director(f.options)
    director.configure({ proactiveSpeech: true }, 'user')
    director.submit({ type: 'activity', id: 'idle', identity, observedAt: f.clock.now(), activity: 'idle', source: 'user-declared', confidence: 1 })
    director.flush()
    for (let i = 0; i < 10800; i++) {
      f.clock.advance(2000)
      director.advance()
    }
    await settle()
    expect(f.speech.deliver).not.toHaveBeenCalled()
    expect(f.visual.request).not.toHaveBeenCalled()
    expect(f.clock.pendingTimers).toBe(0)
  })

  it('caps proactive attempts at four per rolling hour while allowing direct user requests', async () => {
    const f = fixture()
    const director = new Director(f.options)
    director.configure({ proactiveSpeech: true }, 'user')
    for (let i = 0; i < 20; i++) {
      director.submit(conversation(f.clock, `continuation-${i}`, { addressed: false, unresolved: false }))
      director.flush()
      await settle()
      f.clock.advance(180001)
    }
    expect(f.speech.deliver).toHaveBeenCalledTimes(4)
    director.submit(conversation(f.clock, 'direct'))
    director.flush()
    await settle()
    expect(f.speech.deliver).toHaveBeenCalledTimes(5)
    expect(f.speech.deliver.mock.calls[4][0].intent).toBe('respond-user')
  })

  it('isolates two simultaneous character identities and their mood and cancellation', async () => {
    const f = fixture()
    const other = { userId: identity.userId, characterId: 'character-2' }
    const a = new Director(f.options)
    const b = new Director({ ...f.options, identity: other })
    const baseline = b.status().mood
    a.submit(conversation(f.clock, 'reaction', { addressed: false, unresolved: false, significant: false, affect: 'concerned' }))
    a.flush()
    expect(a.status().mood.valence).toBeLessThan(baseline.valence)
    expect(b.status().mood).toEqual(baseline)
    expect(b.submit(conversation(f.clock))).toBe('wrong-identity')
    b.submit(conversation(f.clock, 'other', { identity: other }))
    a.cancel()
    b.flush()
    await settle()
    expect(f.speech.deliver).toHaveBeenCalledOnce()
    expect(f.speech.deliver.mock.calls[0][0].identity.characterId).toBe('character-2')
  })
})
