import type { SpeechRecognitionPort, SystemAudioPort } from '../../src/watch/contracts'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { normalizeSubtitle, normalizeVideo } from '../../src/watch/browser'
import { GatewaySpeechRecognition } from '../../src/watch/gateway-recognition'
import { WatchState } from '../../src/watch/state'
import { SystemAudioFallback } from '../../src/watch/system-audio'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(options: { capture?: SystemAudioPort['capture'], transcribe?: SpeechRecognitionPort['transcribe'] } = {}) {
  let now = 1000
  let sequence = 1
  const bytes = new Uint8Array([1, 2, 3])
  const state = new WatchState({ now: () => now })
  state.connect(1)
  const stamp = () => ({ session: 1, sequence: sequence++, observed_at: now, timeline: 0 })
  const video = (playing = true) => state.ingest(normalizeVideo({ site: 'youtube', url: 'https://youtube.com/watch?v=x', title: 'Sample Episode 1', videoId: 'x', isPlaying: playing, currentTimeSec: 10 }, stamp())!)
  const caption = () => state.ingest(normalizeSubtitle({ site: 'youtube', url: 'https://youtube.com/watch?v=x', videoId: 'x', text: 'Browser dialogue' }, stamp())!)
  video()
  const capture = vi.fn(async (input: Parameters<SystemAudioPort['capture']>[0]) => {
    now += 1000
    return options.capture ? options.capture(input) : { bytes, mime_type: 'audio/wav' as const, captured_at: now, duration_ms: 1000 }
  })
  const recognition = vi.fn(options.transcribe ?? (async input => input.language === 'ja' ? 'こんにちは。' : 'Hello.'))
  const policy = { enabled: true, allowed: () => true, subtitle_coverage: 'missing' as const, protected_video: false }
  const audio = new SystemAudioFallback({ state, now: () => now, audio: { capture }, recognition: { transcribe: recognition } }, policy)
  return { state, audio, capture, recognition, bytes, policy, video, caption, time: (value: number) => {
    now = value
  } }
}

afterEach(() => vi.useRealTimers())

describe('conditional system audio', () => {
  it.each(['en', 'ja'] as const)('transcribes a short %s segment through the existing capability', async (language) => {
    const f = fixture()
    expect(await f.audio.transcribe(language)).toBe('transcribed')
    expect(f.state.current().dialogue?.language).toBe(language)
    expect(f.state.current().dialogue?.value).toBe(language === 'ja' ? 'こんにちは。' : 'Hello.')
    expect(f.capture).toHaveBeenCalledWith(expect.objectContaining({ max_duration_ms: 8000 }))
    expect(f.bytes.every(byte => byte === 0)).toBe(true)
    expect(await f.audio.transcribe(language)).toBe('suppressed')
    f.audio.shutdown()
  })

  it('suppresses recording when structured subtitles are available', async () => {
    const f = fixture()
    f.audio.configure({ ...f.policy, subtitle_coverage: 'available', protected_video: true })
    expect(await f.audio.transcribe('en')).toBe('suppressed')
    expect(f.capture).not.toHaveBeenCalled()
    f.audio.configure(f.policy)
    f.caption()
    expect(await f.audio.transcribe('en')).toBe('suppressed')
    expect(f.capture).not.toHaveBeenCalled()
  })

  it('permits incomplete subtitle and protected video fallbacks on demand', async () => {
    const f = fixture()
    f.audio.configure({ ...f.policy, subtitle_coverage: 'incomplete' })
    expect(await f.audio.transcribe('en')).toBe('transcribed')
    const protectedSample = fixture()
    protectedSample.audio.configure({ ...protectedSample.policy, subtitle_coverage: 'unknown', protected_video: true })
    expect(await protectedSample.audio.transcribe('ja')).toBe('transcribed')
  })

  it('never infers recording permission from unknown coverage or privacy', async () => {
    const f = fixture()
    f.audio.configure({ ...f.policy, subtitle_coverage: 'unknown' })
    expect(await f.audio.transcribe('en')).toBe('suppressed')
    f.audio.configure({ ...f.policy, allowed: () => false })
    expect(await f.audio.transcribe('en')).toBe('suppressed')
    f.audio.configure(f.policy)
    f.state.fuse({ current: () => ({ status: 'blocked-by-privacy' }) })
    expect(await f.audio.transcribe('en')).toBe('suppressed')
    expect(f.capture).not.toHaveBeenCalled()
  })

  it('suppresses when paused, disabled, user speaking or browser stale', async () => {
    const f = fixture()
    f.video(false)
    expect(await f.audio.transcribe('en')).toBe('suppressed')
    f.video(true)
    f.audio.configure({ ...f.policy, enabled: false })
    expect(await f.audio.transcribe('en')).toBe('suppressed')
    f.audio.configure(f.policy)
    f.audio.userSpeech(true)
    expect(await f.audio.transcribe('en')).toBe('suppressed')
    f.audio.userSpeech(false)
    f.time(37000)
    expect(await f.audio.transcribe('en')).toBe('suppressed')
    expect(f.capture).not.toHaveBeenCalled()
  })

  it('cancels promptly and erases a late capture even when its producer ignores cancellation', async () => {
    const pending = deferred<Awaited<ReturnType<SystemAudioPort['capture']>>>()
    const f = fixture({ capture: () => pending.promise })
    const controller = new AbortController()
    const request = f.audio.transcribe('ja', controller.signal)
    controller.abort()
    expect(await request).toBe('cancelled')
    pending.resolve({ bytes: f.bytes, captured_at: 1000, duration_ms: 1000, mime_type: 'audio/wav' })
    await vi.waitFor(() => expect(f.bytes.every(byte => byte === 0)).toBe(true))
    expect(f.recognition).not.toHaveBeenCalled()
  })

  it.each(['caption', 'disconnect', 'user', 'privacy', 'shutdown'] as const)('revokes pending transcription on %s', async (trigger) => {
    const pending = deferred<string>()
    const f = fixture({ transcribe: () => pending.promise })
    const request = f.audio.transcribe('en')
    await vi.waitFor(() => expect(f.recognition).toHaveBeenCalled())
    if (trigger === 'caption')
      f.caption()
    if (trigger === 'disconnect')
      f.state.disconnect()
    if (trigger === 'user')
      f.audio.userSpeech(true)
    if (trigger === 'privacy')
      f.state.fuse({ current: () => ({ status: 'blocked-by-privacy' }) })
    if (trigger === 'shutdown')
      f.audio.shutdown()
    expect(await request).toBe('cancelled')
    pending.resolve('Old inferred dialogue')
    await Promise.resolve()
    expect(f.state.current().dialogue?.value).not.toBe('Old inferred dialogue')
    expect(f.bytes.every(byte => byte === 0)).toBe(true)
  })

  it('enforces one in-flight attempt and a deterministic cancellation deadline', async () => {
    vi.useFakeTimers()
    const pending = deferred<Awaited<ReturnType<SystemAudioPort['capture']>>>()
    const f = fixture({ capture: () => pending.promise })
    const request = f.audio.transcribe('en')
    expect(await f.audio.transcribe('ja')).toBe('suppressed')
    await vi.advanceTimersByTimeAsync(12000)
    expect(await request).toBe('cancelled')
    pending.resolve({ bytes: f.bytes, mime_type: 'audio/wav', captured_at: 1000, duration_ms: 1000 })
    await vi.waitFor(() => expect(f.bytes.every(byte => byte === 0)).toBe(true))
  })

  it('rejects an oversized segment and erases its bytes', async () => {
    const bytes = new Uint8Array(2_000_001).fill(1)
    const f = fixture({ capture: async () => ({ bytes, mime_type: 'audio/wav', captured_at: 2000, duration_ms: 1000 }) })
    expect(await f.audio.transcribe('en')).toBe('failed')
    expect(f.recognition).not.toHaveBeenCalled()
    expect(bytes.every(byte => byte === 0)).toBe(true)
  })

  it('rejects cached audio acquired before the current media request', async () => {
    const f = fixture({ capture: async () => ({ bytes: new Uint8Array([1, 2]), mime_type: 'audio/wav', captured_at: 50001, duration_ms: 8000 }), transcribe: async () => 'Prior episode dialogue' })
    f.time(50000)
    f.video()
    expect(await f.audio.transcribe('en')).toBe('failed')
    expect(f.recognition).not.toHaveBeenCalled()
    expect(f.state.current().dialogue).toBeUndefined()
  })

  it('sanitizes provider failure without putting raw audio or text in errors', async () => {
    const f = fixture({ transcribe: async () => {
      throw new Error('private provider contents')
    } })
    expect(await f.audio.transcribe('en')).toBe('failed')
    expect(f.bytes.every(byte => byte === 0)).toBe(true)
  })
})

describe('r3 gateway capability adapter', () => {
  const config = { base_url: 'http://127.0.0.1:11980/v1/', alias: 'companion-stt', aliases: { 'companion-stt': { role: 'speech-recognition' as const, chain: ['selected-model'], prompt: { softTarget: 4096, expandedTarget: 8192, maxTarget: 16384, mode: 'auto' as const, lowWaterRatio: 0.5 }, outputReserveTokens: 512 } } }

  it('sends the configured alias and Japanese language without implementing provider selection', async () => {
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('http://127.0.0.1:11980/v1/audio/transcriptions')
      const form = init?.body as FormData
      expect(form.get('model')).toBe('companion-stt')
      expect(form.get('language')).toBe('ja')
      expect(init?.headers).toEqual({ authorization: 'Bearer test-token' })
      return Response.json({ text: '一緒に見よう。' })
    })
    const adapter = new GatewaySpeechRecognition({ ...config, token: 'test-token', transport })
    expect(await adapter.transcribe({ bytes: new Uint8Array([1]), mime_type: 'audio/wav', language: 'ja', signal: new AbortController().signal })).toBe('一緒に見よう。')
  })

  it('rejects non-local gateways and aliases with another capability role', () => {
    expect(() => new GatewaySpeechRecognition({ ...config, base_url: 'https://example.com/v1/' })).toThrow('Invalid watch')
    expect(() => new GatewaySpeechRecognition({ ...config, alias: 'conversation' })).toThrow('Invalid watch')
  })

  it('bounds response size and never exposes provider error bodies', async () => {
    const input = { bytes: new Uint8Array([1]), mime_type: 'audio/wav' as const, language: 'en' as const, signal: new AbortController().signal }
    const oversized = new GatewaySpeechRecognition({ ...config, transport: async () => new Response('x'.repeat(20000)) })
    await expect(oversized.transcribe(input)).rejects.toThrow('response too large')
    const error = new GatewaySpeechRecognition({ ...config, transport: async () => new Response('private dialogue', { status: 429 }) })
    await expect(error.transcribe(input)).rejects.toThrow('Watch transcription unavailable')
  })
})
