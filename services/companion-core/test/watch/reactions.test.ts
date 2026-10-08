import { afterEach, describe, expect, it, vi } from 'vitest'

import { normalizeSubtitle, normalizeVideo } from '../../src/watch/browser'
import { ReactionPolicy } from '../../src/watch/reactions'
import { WatchState } from '../../src/watch/state'

function fixture() {
  let now = 1000
  let sequence = 1
  const state = new WatchState({ now: () => now })
  state.connect(1)
  const stamp = () => ({ session: 1, sequence: sequence++, observed_at: now, timeline: 0 })
  const video = (playing = true) => state.ingest(normalizeVideo({ site: 'youtube', url: 'https://youtube.com/watch?v=x', title: 'Sample', videoId: 'x', isPlaying: playing, currentTimeSec: 10 }, stamp())!)
  video()
  const subtitle = (text: string) => state.ingest(normalizeSubtitle({ site: 'youtube', url: 'https://youtube.com/watch?v=x', videoId: 'x', text }, stamp())!)
  const policy = new ReactionPolicy(state, () => now)
  const offer = (key = 'moment', salience = 0.9) => policy.offer({ kind: 'scene-change', observation_key: key, salience, revision: state.current().revision, observed_at: now })
  return { state, policy, offer, video, subtitle, time: (value: number) => {
    now = value
  } }
}

afterEach(() => vi.useRealTimers())

describe('deterministic sparse reactions', () => {
  it('suppresses active dialogue and waits for a 1.5 second subtitle gap', () => {
    const f = fixture()
    f.subtitle('Dialogue')
    f.offer()
    expect(f.policy.take()).toBeUndefined()
    f.time(2000)
    f.subtitle('')
    f.time(3400)
    expect(f.policy.take()).toBeUndefined()
    f.time(3500)
    expect(f.policy.take()).toBeDefined()
  })

  it('does not mistake missing captions for silence', () => {
    const f = fixture()
    f.offer()
    f.time(4000)
    expect(f.policy.take()).toBeUndefined()
  })

  it('admits a sufficiently salient pause after a gap', () => {
    const f = fixture()
    f.video(false)
    f.offer()
    f.time(2500)
    expect(f.policy.take()).toBeDefined()
  })

  it('uses a bounded VAD gap when subtitles are unavailable', () => {
    const f = fixture()
    f.offer()
    f.state.dialogueActivity(false, 1000)
    f.time(2500)
    const permit = f.policy.take()!
    expect(permit).toBeDefined()
    f.state.dialogueActivity(true, 2500)
    expect(permit.signal.aborted).toBe(true)
  })

  it('preserves a continuously observed VAD silence run across fresh updates', () => {
    const f = fixture()
    f.offer()
    for (const at of [1000, 1500, 2000, 2500]) {
      f.time(at)
      f.state.dialogueActivity(false, at)
    }
    expect(f.state.current().gap_since).toBe(1000)
    expect(f.policy.take()).toBeDefined()
  })

  it('rejects a delayed pre-resume subtitle gap instead of authorizing speech', () => {
    const f = fixture()
    f.video(false)
    const delayed = normalizeSubtitle({ site: 'youtube', url: 'https://youtube.com/watch?v=x', videoId: 'x', text: '' }, { session: 1, sequence: 3, observed_at: 1100, timeline: 0 })!
    f.time(2000)
    f.video(true)
    f.offer()
    expect(f.state.ingest(delayed)).toBe(false)
    f.time(2600)
    expect(f.state.current().dialogue_active).toBe('unknown')
    expect(f.policy.take()).toBeUndefined()
  })

  it('enforces cooldown and suppresses repeated observations', () => {
    const f = fixture()
    f.video(false)
    f.offer()
    f.time(2500)
    const first = f.policy.take()!
    f.policy.finish(first)
    expect(f.offer()).toBe(false)
    f.offer('another')
    expect(f.policy.take()).toBeUndefined()
    f.time(183000)
    f.video(false)
    f.offer('later')
    f.time(184500)
    expect(f.policy.take()).toBeDefined()
  })

  it('rejects weak, stale and future salience candidates', () => {
    const f = fixture()
    expect(f.offer('weak', 0.4)).toBe(false)
    expect(f.policy.offer({ kind: 'pause', observation_key: 'future', observed_at: 2000, revision: f.state.current().revision, salience: 1 })).toBe(false)
    f.offer()
    f.time(32000)
    f.video(false)
    expect(f.policy.take()).toBeUndefined()
  })

  it('gives user interruption priority over pending and admitted reactions', () => {
    const f = fixture()
    f.video(false)
    f.offer()
    f.time(2500)
    const permit = f.policy.take()!
    f.policy.userSpeech(true)
    expect(permit.signal.aborted).toBe(true)
    expect(f.policy.valid(permit)).toBe(false)
    expect(f.offer('another')).toBe(false)
    f.policy.userSpeech(false)
    expect(f.policy.take()).toBeUndefined()
  })

  it('revokes an admitted reaction when captions resume or browser disconnects', () => {
    const f = fixture()
    f.subtitle('')
    f.offer()
    f.time(2500)
    const permit = f.policy.take()!
    f.subtitle('New dialogue')
    expect(permit.signal.aborted).toBe(true)
    f.policy.shutdown()
    expect(f.offer('other')).toBe(false)
  })

  it('cancels permits on watch cancellation', () => {
    const f = fixture()
    f.video(false)
    f.offer()
    f.time(2500)
    const permit = f.policy.take()!
    f.state.cancel()
    expect(permit.signal.aborted).toBe(true)
    expect(f.state.current().status).toBe('cancelled')
    expect(f.state.current().media).toBeUndefined()
  })

  it('expires a permit before delayed voice output', () => {
    const f = fixture()
    f.video(false)
    f.offer()
    f.time(2500)
    const permit = f.policy.take()!
    f.time(8000)
    expect(f.policy.valid(permit)).toBe(false)
    expect(permit.signal.aborted).toBe(true)
  })

  it('automatically cancels an admitted permit when its silence evidence expires', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.state.dialogueActivity(false, 1000)
    f.offer()
    f.time(2500)
    const permit = f.policy.take()!
    expect(permit.valid_until).toBe(3500)
    await vi.advanceTimersByTimeAsync(999)
    expect(permit.signal.aborted).toBe(false)
    f.time(3500)
    await vi.advanceTimersByTimeAsync(1)
    expect(permit.signal.aborted).toBe(true)
  })
})
