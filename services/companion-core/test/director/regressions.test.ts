import type { SpeechIntent, VisualIntent, WatchReactionPort } from '../../src/director'

import { describe, expect, it, vi } from 'vitest'

import { Director } from '../../src/director'
import { observation } from '../perception/helpers'
import { conversation, fixture, identity, settle, speechEvent } from './helpers'

describe('director evidence and lifecycle regressions', () => {
  it('removes a queued screen reaction on privacy revocation before typing ends', async () => {
    const f = fixture()
    const director = new Director(f.options)
    director.submit({ type: 'activity', id: 'typing', identity, observedAt: f.clock.now(), source: 'input-activity', activity: 'working', confidence: 1 })
    director.submit({ type: 'screen', id: 'frame', identity, observedAt: f.clock.now(), observationKey: 'editor', noteworthy: true, world: { status: 'fresh', observation: observation({ captured_at: f.clock.now(), valid_until: f.clock.now() + 10000, activity: 'coding' }) } })
    director.flush()
    expect(director.status().resources.candidates).toBe(1)
    director.submit({ type: 'screen', id: 'private', identity, observedAt: f.clock.now(), observationKey: 'editor', noteworthy: false, world: { status: 'blocked-by-privacy' } })
    expect(director.status().resources.candidates).toBe(0)
    director.flush()
    f.clock.advance(6000)
    director.advance()
    await settle()
    expect(f.visual.request).not.toHaveBeenCalled()
  })

  it('revokes a screen reaction when the host changes its opaque source-generation key', async () => {
    let intent: VisualIntent | undefined
    const f = fixture({ visual: { request: (input) => {
      intent = input
      return 'started'
    }, cancel: vi.fn() } })
    const director = new Director(f.options)
    const world = { status: 'fresh', observation: observation({ captured_at: f.clock.now(), valid_until: f.clock.now() + 10000, activity: 'coding' }) }
    director.submit({ type: 'screen', id: 'source-1', identity, observedAt: f.clock.now(), observationKey: 'source-1-editor', noteworthy: true, world })
    director.flush()
    await settle()
    director.submit({ type: 'screen', id: 'source-2', identity, observedAt: f.clock.now(), observationKey: 'source-2-editor', noteworthy: false, world })
    expect(intent?.signal.aborted).toBe(true)
    expect(intent?.guard()).toBe(false)
    director.dispose()
  })

  it.each(['blocked-by-privacy', 'stale', 'unavailable'] as const)('revokes an owned screen reaction immediately when R5 reports %s', async (status) => {
    let intent: VisualIntent | undefined
    const f = fixture({ visual: { request: (input) => {
      intent = input
      return 'started'
    }, cancel: vi.fn() } })
    const director = new Director(f.options)
    director.submit(conversation(f.clock, 'presence', { addressed: false, significant: false, unresolved: false }))
    director.submit({ type: 'screen', id: 'frame', identity, observedAt: f.clock.now(), observationKey: 'editor', noteworthy: true, world: { status: 'fresh', observation: observation({ captured_at: f.clock.now(), valid_until: f.clock.now() + 10000, activity: 'coding' }) } })
    director.flush()
    await settle()
    expect(intent?.guard()).toBe(true)
    director.submit({ type: 'screen', id: 'revoked', identity, observedAt: f.clock.now(), observationKey: 'editor', noteworthy: false, world: { status } })
    expect(intent?.signal.aborted).toBe(true)
    expect(intent?.guard()).toBe(false)
    expect(director.status().resources.activeVisual).toBe(0)
  })

  it('does not defer screen capture freshness to inference completion time', async () => {
    let intent: VisualIntent | undefined
    const f = fixture({ visual: { request: (input) => {
      intent = input
      return 'started'
    }, cancel: vi.fn() } })
    const director = new Director(f.options)
    const captured = f.clock.now()
    f.clock.advance(29000)
    director.submit({ type: 'screen', id: 'frame', identity, observedAt: f.clock.now(), observationKey: 'editor', noteworthy: true, world: { status: 'fresh', observation: observation({ captured_at: captured, valid_until: f.clock.now() + 10000, activity: 'coding' }) } })
    director.flush()
    await settle()
    expect(intent?.signal.aborted).toBe(false)
    f.clock.advance(1001)
    expect(intent?.signal.aborted).toBe(true)
    director.dispose()
  })

  it('keeps unknown media dialogue conservative after watch evidence expires until an explicit stop', async () => {
    const watch: WatchReactionPort = { offerReaction: vi.fn<WatchReactionPort['offerReaction']>(async () => 'delivered') }
    const f = fixture({ watch })
    const director = new Director(f.options)
    const snapshot = { status: 'watching', revision: 1, valid_until: f.clock.now() + 1000, playback: { value: 'playing', confidence: 0.9, observed_at: f.clock.now(), valid_until: f.clock.now() + 1000 }, dialogue_active: 'unknown', confidence: 0.9, perception_blocked: false }
    director.submit({ type: 'watch', id: 'media', identity, observedAt: f.clock.now(), snapshot })
    director.flush()
    f.clock.advance(1001)
    director.submit(conversation(f.clock, 'fresh-question'))
    director.flush()
    await settle()
    expect(f.speech.deliver).not.toHaveBeenCalled()
    expect(director.status().attention.watching).toBe(true)
    expect(director.status().attention.watchEvidence).toBe('uncertain')
    expect(director.status().lastDecision?.reason).toBe('media-dialogue')
    director.submit({ type: 'watch', id: 'stopped', identity, observedAt: f.clock.now(), snapshot: { ...snapshot, status: 'cancelled' } })
    director.flush()
    await settle()
    expect(f.speech.deliver).toHaveBeenCalledOnce()
    expect(director.status().attention.watchEvidence).toBe('none')
  })

  it('does not bypass R6 when a known media identity has low-confidence watch evidence', async () => {
    const f = fixture()
    const director = new Director(f.options)
    const snapshot = { status: 'watching', revision: 1, valid_until: f.clock.now() + 10000, dialogue_active: 'unknown', confidence: 0.2, perception_blocked: false }
    director.submit({ type: 'watch', id: 'uncertain-media', identity, observedAt: f.clock.now(), snapshot })
    director.submit(conversation(f.clock))
    director.flush()
    await settle()
    expect(f.speech.deliver).not.toHaveBeenCalled()
    expect(director.status().attention.watchEvidence).toBe('uncertain')
  })

  it('keeps owned speech valid through its own companion voice activity and prevents overlap', async () => {
    let intent: SpeechIntent | undefined
    const f = fixture({ speech: { deliver: async (input) => {
      intent = input
      return new Promise(() => {})
    } } })
    const director = new Director(f.options)
    director.submit(conversation(f.clock, 'answer'))
    director.flush()
    await settle()
    director.submit({ type: 'speech', id: 'own-start', identity, observedAt: f.clock.now(), speaker: 'companion', active: true, outputId: intent?.outputId })
    director.flush()
    expect(intent?.signal.aborted).toBe(false)
    expect(intent?.guard()).toBe(true)
    expect(director.status().attention.companionSpeaking).toBe(true)
    director.submit(conversation(f.clock, 'second'))
    director.flush()
    expect(director.status().lastDecision?.reason).toBe('companion-speaking')
    f.clock.advance(5000)
    director.submit({ type: 'speech', id: 'own-pulse', identity, observedAt: f.clock.now(), speaker: 'companion', active: true, outputId: intent?.outputId })
    director.flush()
    expect(intent?.guard()).toBe(true)
    director.submit(speechEvent(f.clock, true, 'user-barge-in'))
    expect(intent?.signal.aborted).toBe(true)
    director.dispose()
  })

  it('preempts speech when companion playback belongs to another output owner', async () => {
    let signal: AbortSignal | undefined
    const f = fixture({ speech: { deliver: async (input) => {
      signal = input.signal
      return new Promise(() => {})
    } } })
    const director = new Director(f.options)
    director.submit(conversation(f.clock))
    director.flush()
    await settle()
    director.submit({ type: 'speech', id: 'other-start', identity, observedAt: f.clock.now(), speaker: 'companion', active: true, outputId: 'other-owner' })
    expect(signal?.aborted).toBe(true)
    director.dispose()
  })

  it('does not renew emotion from suppressed observations or low-confidence screen hints', async () => {
    const f = fixture()
    const director = new Director(f.options)
    const initial = director.status().mood
    const send = (key: string, confidence: number, id: string) => {
      const world = { status: 'fresh', observation: observation({ captured_at: f.clock.now(), valid_until: f.clock.now() + 10000, confidence, activity: 'coding' }) }
      expect(director.submit({ type: 'screen', id, identity, observedAt: f.clock.now(), observationKey: key, world, noteworthy: true, affect: 'amused' })).toBe('accepted')
      director.flush()
    }
    send('uncertain', 0.2, 'uncertain')
    expect(director.status().mood).toEqual(initial)
    expect(director.status().reaction).toBeUndefined()
    send('editor', 0.9, 'first')
    await settle()
    for (let i = 0; i < 12; i++) {
      f.clock.advance(2000)
      send('editor', 0.9, `repeat-${i}`)
      await settle()
    }
    expect(director.status().reaction).toBeUndefined()
    expect(f.visual.request).toHaveBeenCalledOnce()
  })

  it('rejects oversized invalidation collections before traversing their elements', () => {
    const f = fixture()
    const director = new Director(f.options)
    const itemIds = Array.from({ length: 10000 }).fill('item')
    Object.defineProperty(itemIds, 0, { get: () => {
      throw new Error('unbounded traversal')
    } })
    expect(director.submit({ type: 'memory-invalidated', id: 'large', identity, observedAt: f.clock.now(), itemIds })).toBe('invalid')
  })

  it('rejects oversized quiet-period collections before traversing their elements', () => {
    const f = fixture()
    const director = new Director(f.options)
    const quietPeriods = Array.from({ length: 10000 }, () => ({ startMinute: 0, endMinute: 1 }))
    Object.defineProperty(quietPeriods, 0, { get: () => {
      throw new Error('unbounded traversal')
    } })
    expect(director.configure({ quietPeriods }, 'user')).toBe(false)
  })

  it('updates engagement energy from activity independently of emotional mood', () => {
    const f = fixture()
    const director = new Director(f.options)
    const initial = director.status()
    director.submit(conversation(f.clock, 'presence', { addressed: false, unresolved: false, significant: false }))
    director.flush()
    f.clock.advance(60000)
    director.advance()
    expect(director.status().energy).toBeGreaterThan(initial.energy)
    expect(director.status().mood.valence).toBe(initial.mood.valence)
    director.submit({ type: 'activity', id: 'idle', identity, observedAt: f.clock.now(), activity: 'idle', source: 'user-declared', confidence: 1 })
    director.flush()
    expect(director.status().attention.activity).toBe('idle')
  })

  it('keeps a started visual request valid for its bounded lease and cancels it at expiry', async () => {
    let intent: VisualIntent | undefined
    const cancel = vi.fn()
    const f = fixture({ visual: { request: (input) => {
      intent = input
      return 'started'
    }, cancel } })
    const director = new Director(f.options)
    director.submit(conversation(f.clock, 'continuation', { addressed: false, unresolved: false, affect: 'curious' }))
    director.flush()
    await settle()
    expect(intent?.guard()).toBe(true)
    f.clock.advance(6001)
    expect(intent?.guard()).toBe(false)
    expect(intent?.signal.aborted).toBe(true)
    expect(cancel).toHaveBeenCalled()
  })

  it('blocks speech on an expired dialogue-gap claim even when playback remains fresh', async () => {
    const f = fixture()
    const offerReaction = vi.fn<WatchReactionPort['offerReaction']>(async () => 'delivered')
    const director = new Director({ ...f.options, watch: { offerReaction } })
    director.submit({ type: 'watch', id: 'watch', identity, observedAt: f.clock.now(), snapshot: { status: 'watching', revision: 1, confidence: 0.9, perception_blocked: false, conflicts: [], valid_until: f.clock.now() + 35000, playback: { value: 'playing', source: 'browser', confidence: 0.9, observed_at: f.clock.now(), valid_until: f.clock.now() + 35000 }, dialogue_active: 'gap', gap_since: f.clock.now() - 2000, dialogue_valid_until: f.clock.now() - 1 } })
    director.submit(conversation(f.clock))
    director.flush()
    await settle()
    expect(offerReaction).not.toHaveBeenCalled()
    expect(director.status().lastDecision?.reason).toBe('media-dialogue')
  })

  it('preempts an active non-watch utterance when new media dialogue begins', async () => {
    let signal: AbortSignal | undefined
    const f = fixture({ speech: { deliver: async (input) => {
      signal = input.signal
      return new Promise(() => {})
    } } })
    const director = new Director(f.options)
    director.submit(conversation(f.clock))
    director.flush()
    await settle()
    director.submit({ type: 'watch', id: 'watch', identity, observedAt: f.clock.now(), snapshot: { status: 'watching', revision: 1, confidence: 0.9, perception_blocked: false, conflicts: [], valid_until: f.clock.now() + 35000, playback: { value: 'playing', source: 'browser', confidence: 0.9, observed_at: f.clock.now(), valid_until: f.clock.now() + 35000 }, dialogue_active: 'active', dialogue_valid_until: f.clock.now() + 5000 } })
    director.flush()
    expect(signal?.aborted).toBe(true)
  })

  it('treats screen activity as tentative and discards stale and repeated visual evidence', async () => {
    const f = fixture()
    const director = new Director(f.options)
    const world = { status: 'fresh' as const, observation: observation({ captured_at: f.clock.now(), valid_until: f.clock.now() + 10000, activity: 'coding', concise_summary: 'PRIVATE SCREEN SUMMARY' }), uncertain_objects: [] }
    director.submit({ type: 'screen', id: 'screen-1', identity, observedAt: f.clock.now(), world, observationKey: 'same', noteworthy: true, affect: 'focused' })
    director.flush()
    await settle()
    expect(director.status().attention.activity).toBe('working')
    expect(director.status().attention.tentative).toBe(true)
    expect(director.status().attention.confidence).toBeLessThan(1)
    for (let i = 0; i < 1000; i++) {
      director.submit({ type: 'screen', id: `screen-repeat-${i}`, identity, observedAt: f.clock.now(), world, observationKey: 'same', noteworthy: true, affect: 'focused' })
      director.flush()
    }
    await settle()
    expect(f.visual.request).toHaveBeenCalledOnce()
    expect(JSON.stringify(director.status())).not.toContain('PRIVATE SCREEN SUMMARY')
    f.clock.advance(10001)
    director.advance()
    expect(director.status().attention.activity).toBe('unknown')
    expect(director.submit({ type: 'screen', id: 'stale', identity, observedAt: f.clock.now(), world, observationKey: 'different', noteworthy: true })).toBe('stale')
  })

  it('honors working, typing, absent, quiet periods, and disabled frequency', async () => {
    const f = fixture()
    const director = new Director(f.options)
    director.configure({ proactiveSpeech: true }, 'user')
    director.submit({ type: 'activity', id: 'typing', identity, observedAt: f.clock.now(), activity: 'working', source: 'input-activity', confidence: 1 })
    director.submit(conversation(f.clock))
    director.flush()
    expect(director.status().lastDecision?.reason).toBe('typing')
    f.clock.advance(6000)
    director.configure({ quietPeriods: [{ startMinute: 900, endMinute: 960 }], utcOffsetMinutes: 330 }, 'user')
    director.advance()
    expect(director.status().lastDecision?.reason).toBe('quiet-period')
    director.configure({ quietPeriods: [], reactionFrequency: 'off' }, 'user')
    director.cancel()
    director.submit(conversation(f.clock, 'visual', { addressed: false, unresolved: false }))
    director.configure({ proactiveSpeech: false }, 'user')
    director.flush()
    expect(director.status().lastDecision?.reason).toBe('frequency-off')
    expect(f.speech.deliver).not.toHaveBeenCalled()
    expect(f.visual.request).not.toHaveBeenCalled()
  })

  it('does not replay cancelled requests after the user finishes speaking', async () => {
    const f = fixture()
    const director = new Director(f.options)
    director.submit(conversation(f.clock))
    director.cancel()
    director.submit(speechEvent(f.clock, true))
    director.submit(speechEvent(f.clock, false, 'end'))
    director.flush()
    await settle()
    expect(f.speech.deliver).not.toHaveBeenCalled()
    expect(director.status().resources.candidates).toBe(0)
  })
})
