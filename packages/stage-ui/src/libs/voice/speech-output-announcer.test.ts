import type { OutputVoiceActivityEvent } from '@proj-airi/server-sdk'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SpeechOutputAnnouncer } from './speech-output-announcer'

describe('speechOutputAnnouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports a turn once from its first audio, renews it, and ends it when the turn settles', () => {
    const reports: OutputVoiceActivityEvent[] = []
    const announcer = new SpeechOutputAnnouncer(activity => reports.push(activity), 1000)
    const turn = { sessionId: 'session-1', turnId: 'round-1' }

    announcer.started(turn)
    announcer.started(turn)
    expect(reports).toEqual([{ active: true, outputId: 'round-1', sessionId: 'session-1' }])

    vi.advanceTimersByTime(2500)
    expect(reports.filter(report => report.active)).toHaveLength(3)

    announcer.settled([turn])
    expect(reports.at(-1)?.active).toBe(true)
    announcer.settled([])
    expect(reports.at(-1)).toEqual({ active: false, outputId: 'round-1', sessionId: 'session-1' })

    vi.advanceTimersByTime(5000)
    expect(reports.at(-1)?.active).toBe(false)
  })

  it('keeps other turns apart and ends all of them on dispose', () => {
    const reports: OutputVoiceActivityEvent[] = []
    const announcer = new SpeechOutputAnnouncer(activity => reports.push(activity), 1000)
    announcer.started({ sessionId: 'session-1', turnId: 'round-1' })
    announcer.started({ sessionId: 'session-1', turnId: 'spark:notify-1' })
    announcer.dispose()
    expect(reports.filter(report => !report.active).map(report => report.outputId).sort()).toEqual(['round-1', 'spark:notify-1'])
  })
})
