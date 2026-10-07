import { describe, expect, it } from 'vitest'

import { VoiceLatencyTrace } from './voice-latency'

describe('voice latency measurements', () => {
  it('measures one correlated AIRI turn through actual playback scheduling', () => {
    let now = 0
    const trace = new VoiceLatencyTrace(() => now)
    const id = trace.beginInput()
    now = 100
    trace.markSpeechEnd(id)
    now = 400
    trace.markSttResult(id)
    trace.bindTurn(id, 'turn-1')
    now = 600
    trace.markFirstToken('turn-1')
    now = 1000
    trace.markFirstAudio('turn-1')
    now = 1100
    trace.markPlaybackStarted('turn-1', 20)
    expect(trace.summary()).toMatchObject({
      completed: 1,
      stt: { p50: 300, p95: null },
      llm: { p50: 200, p95: null },
      tts: { p50: 400, p95: null },
      total: { p50: 1020, p95: null },
    })
  })

  it('ignores later chunks and isolates overlapping turns', () => {
    let now = 0
    const trace = new VoiceLatencyTrace(() => now)
    const a = trace.beginInput()
    const b = trace.beginInput()
    trace.markSpeechEnd(a)
    trace.markSpeechEnd(b)
    now = 100
    trace.markSttResult(a)
    trace.bindTurn(a, 'a')
    now = 200
    trace.markSttResult(b)
    trace.bindTurn(b, 'b')
    now = 300
    trace.markFirstToken('b')
    trace.markFirstAudio('b')
    trace.markPlaybackStarted('b')
    now = 400
    trace.markFirstToken('a')
    trace.markFirstAudio('a')
    trace.markPlaybackStarted('a')
    now = 900
    trace.markFirstAudio('a')
    trace.markPlaybackStarted('a')
    expect(trace.snapshot().find(turn => turn.turnId === 'a')?.playbackStartedAt).toBe(400)
    expect(trace.summary().completed).toBe(2)
  })

  it('reports incomplete and interrupted turns without inventing total latency', () => {
    let now = 0
    const trace = new VoiceLatencyTrace(() => now)
    const id = trace.beginInput()
    trace.markSpeechEnd(id)
    now = 300
    trace.markSttResult(id)
    trace.bindTurn(id, 'cancelled')
    trace.interrupt('cancelled')
    expect(trace.summary().completed).toBe(0)
    expect(trace.summary().total.p50).toBeNull()
    expect(trace.summary().interrupted).toBe(1)
    expect(trace.summary().stt.p50).toBe(300)
  })

  it('requires enough samples for p95 and keeps only bounded metadata', () => {
    let now = 0
    const trace = new VoiceLatencyTrace(() => now)
    for (let i = 1; i <= 25; i++) {
      now = 0
      const id = trace.beginInput()
      trace.markSpeechEnd(id)
      trace.markSttResult(id)
      trace.bindTurn(id, String(i))
      trace.markFirstToken(String(i))
      trace.markFirstAudio(String(i))
      now = i * 10
      trace.markPlaybackStarted(String(i))
    }
    expect(trace.summary().total.p50).toBe(130)
    expect(trace.summary().total.p95).toBe(240)
    for (let i = 0; i < 300; i++)
      trace.beginInput()
    expect(trace.snapshot().length).toBeLessThanOrEqual(256)
    trace.reset()
    expect(trace.summary().completed).toBe(0)
  })
})
