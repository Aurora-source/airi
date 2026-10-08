import type { WatchMemory, WatchPerception } from '../src/companion/watch'
import type { CurrentWorld } from '../src/perception'
import type { ReactionPermit, SpeechRecognitionPort, SystemAudioPort } from '../src/watch'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CompanionWatch } from '../src/companion/watch'
import { parseConfig } from '../src/config/config'
import { observation } from './perception/helpers'
import { FakeChannel, FakeExtension } from './support/watch'

const START = 1_000_000
let clock = START
const now = () => clock

let channel: FakeChannel
let extension: FakeExtension
let watch: CompanionWatch | undefined

/** Runs both the injected clock and the timers that the watch runtime and R6 policies own. */
function advance(ms: number): void {
  clock += ms
  vi.advanceTimersByTime(ms)
}

/** Lets promise callbacks run. setImmediate stays real. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++)
    await new Promise(resolve => setImmediate(resolve))
}

function config(watchConfig: Record<string, unknown> = {}) {
  return parseConfig({
    providers: { groq: { baseURL: 'https://api.groq.com/openai/v1/', keyRef: 'provider-groq' } },
    models: { whisper: { provider: 'groq', model: 'whisper-large-v3', capabilities: { contextWindow: 448 } } },
    aliases: { 'companion-stt': { role: 'speech-recognition', chain: ['whisper'] } },
    watch: watchConfig,
  })
}

/** Records the milestones that reach the R4 boundary. */
class FakeMemory implements WatchMemory {
  readonly milestones: Parameters<WatchMemory['observeWatchMilestone']>[0][] = []
  async observeWatchMilestone(milestone: Parameters<WatchMemory['observeWatchMilestone']>[0]) {
    this.milestones.push(milestone)
    return { status: 'inserted' as const }
  }
}

/** A scripted R5 boundary. Tests replace `world` and call `publish`. */
class FakePerception implements WatchPerception {
  world: CurrentWorld = { status: 'unavailable' }
  paused = false
  private readonly listeners = new Set<() => void>()
  current = () => this.world
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(world: CurrentWorld): void {
    this.world = world
    for (const listener of this.listeners)
      listener()
  }
}

/**
 * A system output recorder that holds each capture until the test answers. A cooperative recorder rejects on abort.
 * An uncooperative one still delivers its bytes later, and the fallback must erase them.
 */
class FakeCapture implements SystemAudioPort {
  cooperative = true
  readonly requests: { max_duration_ms: number, signal: AbortSignal, demandedAt: number, answer: (bytes?: Uint8Array) => void }[] = []
  capture(input: { max_duration_ms: number, signal: AbortSignal }) {
    return new Promise<Awaited<ReturnType<SystemAudioPort['capture']>>>((resolve, reject) => {
      const demandedAt = clock
      if (this.cooperative)
        input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      this.requests.push({
        ...input,
        demandedAt,
        answer: (bytes = new Uint8Array([1, 2, 3, 4])) => resolve({ bytes, mime_type: 'audio/wav', captured_at: clock, duration_ms: Math.min(8000, clock - demandedAt) }),
      })
    })
  }
}

class FakeRecognition implements SpeechRecognitionPort {
  readonly languages: string[] = []
  text = 'Let us watch together.'
  async transcribe(input: Parameters<SpeechRecognitionPort['transcribe']>[0]) {
    this.languages.push(input.language)
    return this.text
  }
}

function start(options: { watchConfig?: Record<string, unknown>, memory?: WatchMemory, perception?: WatchPerception, capture?: SystemAudioPort, recognition?: SpeechRecognitionPort, reactionOutput?: ConstructorParameters<typeof CompanionWatch>[0]['reactionOutput'], anilistTransport?: typeof fetch } = {}): CompanionWatch {
  watch = new CompanionWatch({
    config: config(options.watchConfig),
    now,
    createClient: channel.connect,
    memory: options.memory,
    perception: options.perception,
    systemAudio: options.capture,
    recognition: options.recognition,
    reactionOutput: options.reactionOutput,
    anilistTransport: options.anilistTransport,
  })
  channel.ready(true)
  return watch
}

function status() {
  return watch!.status() as { session?: Record<string, any>, counters: Record<string, any>, userSpeaking: boolean, recentEvents: { kind: string, at: number }[] }
}

function tool() {
  return watch!.toolStatus() as Record<string, any>
}

/** A fresh R5 world that shows the selected video in a browser. */
function screen(overrides: { app?: string, window?: string, summary?: string, capturedAt?: number } = {}): CurrentWorld {
  const capturedAt = overrides.capturedAt ?? clock
  return {
    status: 'fresh',
    uncertain_objects: [],
    observation: observation({
      captured_at: capturedAt,
      valid_until: capturedAt + 15_000,
      concise_summary: overrides.summary ?? 'Two travelers sit at a campfire.',
      media: { detected: true, playback: 'playing', title_like_text: 'Frieren Episode 3', subtitle_like_text: '' },
      source: { kind: 'display', id: 'primary', generation: 0, foreground_app: overrides.app ?? 'chrome', window_title: overrides.window ?? 'Frieren Episode 3 - YouTube - Google Chrome' },
    }),
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  clock = START
  channel = new FakeChannel()
  extension = new FakeExtension(channel, now)
})

afterEach(async () => {
  await watch?.shutdown()
  watch = undefined
  vi.useRealTimers()
})

describe('watch bridge and state', () => {
  // A
  it('turns a stamped extension video event into fresh watch state', () => {
    start()
    extension.sendVideo({ isPlaying: true, currentTimeSec: 10, durationSec: 1420 })

    const facts = tool()
    expect(facts.status).toBe('watching')
    expect(facts.title).toEqual({ text: 'Frieren Episode 3', source: 'browser' })
    expect(facts.episode).toMatchObject({ number: 3, source: 'browser' })
    expect(facts.playback).toBe('playing')
    expect(facts.position).toEqual({ seconds: 10, age_s: 0 })
    expect(facts.dialogue_state).toBe('unknown')
    expect(facts.spoilers).toBe('withheld: completed progress unknown')
  })

  // B
  it('keeps only the current caption while captions progress', () => {
    start()
    extension.sendVideo({ isPlaying: true, currentTimeSec: 10 })
    for (let line = 0; line < 200; line++) {
      advance(500)
      // The extension reports progress every 15 s.
      if (line % 30 === 29)
        extension.sendVideo({ isPlaying: true, currentTimeSec: 10 + line / 2 })
      extension.sendSubtitle(`Caption line ${line}`, { language: 'en' })
    }

    const facts = tool()
    expect(facts.dialogue).toMatchObject({ text: 'Caption line 199', language: 'en', source: 'subtitle' })
    expect(facts.dialogue_state).toBe('active')
    const everything = JSON.stringify([facts, watch!.status(), watch!.unit()])
    expect(everything).not.toContain('Caption line 198')
    expect(everything).not.toContain('Caption line 0"')
    expect(status().counters.accepted).toBe(207)
  })

  // G
  it('starts a new playback epoch on a seek and refuses evidence from before it', () => {
    start()
    extension.sendVideo({ isPlaying: true, currentTimeSec: 10 })
    extension.sendSubtitle('Before the jump', { startMs: 10_000, endMs: 13_000 })
    const before = status().session!.revision
    const stale = { sequence: extension.sequence + 1, observedAt: clock, timeline: extension.timeline }

    advance(1000)
    extension.seek()
    extension.sendVideo({ isPlaying: true, currentTimeSec: 600 })

    expect(status().session!.revision).toBe(before + 1)
    expect(tool().dialogue).toBeUndefined()
    // A caption that the page read before the seek carries the old timeline.
    extension.sendStamped('web:subtitle', 'Subtitle: Before the jump', { site: 'youtube', url: 'https://www.youtube.com/watch?v=frieren3', videoId: 'frieren3' }, stale)
    expect(tool().dialogue).toBeUndefined()
    expect(tool().position.seconds).toBe(600)
  })

  // H
  it('ends the session when the extension leaves and refuses every event of the old connection', () => {
    const memory = new FakeMemory()
    start({ memory })
    extension.sendVideo({ isPlaying: true, currentTimeSec: 10 })
    const first = status().session!.id

    extension.leave()
    expect(tool().status).toBe('idle')
    expect(status().counters.sessionsEnded['producer-gone']).toBe(1)
    extension.sendSubtitle('Late caption')
    extension.sendVideo({ isPlaying: true, currentTimeSec: 12 })
    expect(tool().status).toBe('idle')
    expect(status().counters.ignored.retired).toBe(2)

    extension.connection = 'conn-2'
    extension.sendVideo({ isPlaying: true, currentTimeSec: 14 })
    expect(tool().status).toBe('watching')
    expect(status().session!.id).not.toBe(first)
    expect(memory.milestones.map(milestone => milestone.boundary)).toEqual(['watch_start', 'watch_stop', 'watch_start'])
  })

  it('ends the old session when the same producer comes back on a new connection', () => {
    start()
    extension.sendVideo({ isPlaying: true, currentTimeSec: 10 })
    const delayed = { sequence: extension.sequence + 1, observedAt: clock, timeline: 0 }
    extension.connection = 'conn-2'
    extension.sendVideo({ isPlaying: true, currentTimeSec: 11 })
    expect(status().counters.sessionsEnded['producer-reconnected']).toBe(1)

    extension.sendStamped('web:subtitle', 'Subtitle: from the old connection', { site: 'youtube', url: 'https://www.youtube.com/watch?v=frieren3', videoId: 'frieren3' }, { ...delayed, connection: 'conn-1' })
    expect(tool().dialogue).toBeUndefined()
    expect(status().counters.ignored.retired).toBe(1)
  })

  it('ends every session when the Core loses the server channel', () => {
    start()
    extension.sendVideo({ isPlaying: true, currentTimeSec: 10 })
    channel.ready(false)
    expect(tool().status).toBe('idle')
    expect(status().counters.sessionsEnded['channel-lost']).toBe(1)
  })

  // Q
  it('never lets a delayed, replayed, future, or unstamped event replace current state', () => {
    start()
    extension.sendVideo({ isPlaying: true, currentTimeSec: 10 })
    extension.sendSubtitle('Current line')
    const meta = { site: 'youtube', url: 'https://www.youtube.com/watch?v=frieren3', videoId: 'frieren3' }

    // Replayed sequence.
    extension.sendStamped('web:subtitle', 'Subtitle: Replayed line', meta, { sequence: 2, observedAt: clock, timeline: 0 })
    // Read 40 s ago: older than the browser expiry, so it never becomes fresh.
    extension.sendStamped('web:subtitle', 'Subtitle: Ancient line', meta, { sequence: 50, observedAt: clock - 40_000, timeline: 0 })
    // A producer clock far ahead of the Core.
    extension.sendStamped('web:subtitle', 'Subtitle: Future line', meta, { sequence: 51, observedAt: clock + 10_000, timeline: 0 })
    // Missing stamp.
    channel.emit('context:update', { id: 'x', contextId: 'x', lane: 'web:subtitle', strategy: 'replace-self', text: 'Subtitle: Unstamped line', metadata: { source: 'web-extension', ...meta } }, { source: { kind: 'plugin', id: 'extension-1', plugin: { id: 'proj-airi:plugin-web-extension' } } })
    // Another module posing as a browser lane.
    channel.emit('context:update', { id: 'y', contextId: 'y', lane: 'web:subtitle', strategy: 'replace-self', text: 'Subtitle: Foreign line', metadata: { source: 'web-extension', ...meta, stamp: { connection: 'c', stream: 's', sequence: 99, observedAt: clock, timeline: 0 } } }, { source: { kind: 'plugin', id: 'other', plugin: { id: 'some-other-plugin' } } })

    expect(tool().dialogue.text).toBe('Current line')
    expect(status().counters.ignored).toMatchObject({ 'future': 1, 'unstamped': 1, 'unknown-producer': 1 })
    expect(status().counters.rejected).toBe(2)
  })

  it('selects one stream and lets another take over only when it plays and the selected one does not', () => {
    start()
    const other = new FakeExtension(channel, now, 'conn-1', 'stream-2')
    extension.sendVideo({ isPlaying: true, currentTimeSec: 10 })
    other.sendVideo({ title: 'Another video', url: 'https://www.youtube.com/watch?v=other', videoId: 'other', isPlaying: true, currentTimeSec: 5 })
    expect(tool().title.text).toBe('Frieren Episode 3')
    expect(status().counters.ignored['not-selected']).toBe(1)

    extension.sendVideo({ isPlaying: false, currentTimeSec: 12 })
    other.sendVideo({ isPlaying: true, currentTimeSec: 6 })
    expect(tool().title.text).toBe('Another video')
    expect(status().counters.sessionsEnded.replaced).toBe(1)
  })
})

describe('dialogue gaps and reactions', () => {
  // C
  it('keeps a reaction blocked while a cleared overlay caption leaves dialogue unknown', () => {
    const deliveries: ReactionPermit[] = []
    start({ reactionOutput: { deliver: ({ permit }) => void deliveries.push(permit) } })
    extension.sendVideo({ isPlaying: true, currentTimeSec: 10 })
    extension.sendSubtitle('Spoken line')
    expect(watch!.offerReaction({ kind: 'scene-change', observation_key: 'campfire', salience: 0.9 })).toBe(true)
    advance(1000)
    extension.sendSubtitle('', { cleared: true })
    expect(tool().dialogue_state).toBe('unknown')

    advance(5000)
    expect(deliveries).toHaveLength(0)
    expect(status().counters.reactions.admitted).toBe(0)
  })

  // D
  it('admits a salient candidate after a proven 1.5 s gap and sends a Spark notification that expires with it', async () => {
    start()
    extension.sendVideo({ isPlaying: true, currentTimeSec: 10 })
    // Playback is at 10 s, so this cue ends 1 s from now.
    extension.sendSubtitle('A timed line', { startMs: 10_000, endMs: 11_000 })
    watch!.offerReaction({ kind: 'scene-change', observation_key: 'campfire', salience: 0.9 })

    advance(2400)
    expect(channel.sentOf('spark:notify')).toHaveLength(0)
    advance(1000)
    await flush()

    const sparks = channel.sentOf('spark:notify')
    expect(sparks).toHaveLength(1)
    expect(sparks[0].data.urgency).toBe('immediate')
    expect(sparks[0].data.ttlMs).toBeGreaterThan(0)
    expect(sparks[0].data.ttlMs).toBeLessThanOrEqual(5000)
    expect(sparks[0].route).toEqual({ destinations: [{ type: 'module', modules: ['proj-airi:stage-tamagotchi', 'proj-airi:stage-web'] }] })
    expect(status().session!.reaction.last.outcome).toBe('delivered')
    expect(status().session!.reaction.cooldownRemainingMs).toBe(180_000)
    advance(60_000)
    expect(status().session!.reaction.cooldownRemainingMs).toBe(120_000)
  })

  // E
  it('revokes an admitted reaction the moment the user starts speaking', async () => {
    let held: ReactionPermit | undefined
    start({ reactionOutput: { deliver: async ({ permit }) => {
      held = permit
      await new Promise(resolve => permit.signal.addEventListener('abort', resolve, { once: true }))
    } } })
    extension.sendVideo({ isPlaying: false, currentTimeSec: 10 })
    watch!.offerReaction({ kind: 'pause', observation_key: 'paused-here', salience: 0.9 })
    advance(2000)
    await flush()
    expect(held?.signal.aborted).toBe(false)

    channel.emit('input:voice:activity', { active: true, inputId: 'speech-1' })
    expect(held?.signal.aborted).toBe(true)
    await flush()
    expect(status().session!.reaction.last.outcome).toBe('revoked')
    expect(watch!.offerReaction({ kind: 'pause', observation_key: 'while-speaking', salience: 1 })).toBe(false)

    channel.emit('input:voice:activity', { active: false, inputId: 'speech-1' })
    expect(watch!.offerReaction({ kind: 'pause', observation_key: 'after-speaking', salience: 1 })).toBe(true)
  })

  it('treats a Core-observed user turn as speech for a short time', () => {
    start({ reactionOutput: { deliver: () => {} } })
    extension.sendVideo({ isPlaying: false, currentTimeSec: 10 })
    watch!.userSpeech()
    expect(status().userSpeaking).toBe(true)
    expect(watch!.offerReaction({ kind: 'pause', observation_key: 'k', salience: 1 })).toBe(false)
    advance(2100)
    expect(status().userSpeaking).toBe(false)
  })

  // F
  it('never admits a reaction from silence that ended at resume', async () => {
    const deliveries: ReactionPermit[] = []
    start({ reactionOutput: { deliver: ({ permit }) => void deliveries.push(permit) } })
    extension.sendVideo({ isPlaying: false, currentTimeSec: 10 })
    watch!.offerReaction({ kind: 'pause', observation_key: 'pause-moment', salience: 0.9 })
    const delayedGap = { sequence: extension.sequence + 1, observedAt: clock + 500, timeline: 0 }
    advance(1000)
    extension.sendVideo({ isPlaying: true, currentTimeSec: 10 })
    // A cleared caption read before the resume arrives late. It cannot reopen the old silence.
    extension.sendStamped('web:subtitle', 'Subtitle: ', { site: 'youtube', url: 'https://www.youtube.com/watch?v=frieren3', videoId: 'frieren3', cleared: true }, delayedGap)

    advance(5000)
    await flush()
    expect(deliveries).toHaveLength(0)
    expect(tool().dialogue_state).toBe('unknown')
  })
})

describe('perception fusion', () => {
  // I and media source correlation
  it('uses a fresh frame only when it shows the selected video, and clears it when it goes stale', () => {
    const perception = new FakePerception()
    start({ perception })
    extension.sendVideo({ isPlaying: true, currentTimeSec: 10 })

    perception.publish(screen({ app: 'code', window: 'Frieren Episode 3 - notes.md' }))
    expect(tool().scene).toBeUndefined()
    perception.publish(screen({ window: 'Some other page - Google Chrome' }))
    expect(tool().scene).toBeUndefined()

    perception.publish(screen())
    expect(tool().scene).toEqual({ summary: 'Two travelers sit at a campfire.', age_s: 0 })
    expect(tool().playback).toBe('playing')

    perception.publish({ status: 'stale' })
    expect(tool().scene).toBeUndefined()
    expect(tool().title.text).toBe('Frieren Episode 3')
  })

  it('keeps browser data while perception is blocked by privacy', () => {
    const perception = new FakePerception()
    start({ perception })
    extension.sendVideo({ isPlaying: true, currentTimeSec: 10 })
    perception.publish(screen())
    perception.publish({ status: 'blocked-by-privacy' })
    extension.sendSubtitle('Still here')

    expect(tool().scene).toBeUndefined()
    expect(tool().dialogue.text).toBe('Still here')
    expect(status().session!.visual.perceptionBlocked).toBe(true)
  })
})

describe('conditional system audio', () => {
  function startAudio(perception = new FakePerception()) {
    const capture = new FakeCapture()
    const recognition = new FakeRecognition()
    start({ watchConfig: { systemAudio: { enabled: true } }, perception, capture, recognition })
    return { capture, recognition, perception }
  }

  /** Plays the video for 31 s without captions, with the 15 s progress ticks of the extension. */
  function playWithoutCaptions(title?: string) {
    extension.sendVideo({ title, isPlaying: true, currentTimeSec: 10 })
    watch!.toolStatus()
    for (const position of [25, 40]) {
      advance(15_000)
      extension.sendVideo({ isPlaying: true, currentTimeSec: position })
    }
    advance(1000)
  }

  it('records nothing while caption coverage is only unknown', async () => {
    const { capture } = startAudio()
    extension.sendVideo({ isPlaying: true, currentTimeSec: 10 })
    expect(await watch!.listen()).toEqual({ status: 'suppressed', language: 'en' })
    expect(capture.requests).toHaveLength(0)
  })

  // J
  it('cancels a pending recording when perception privacy blocks, and erases its late bytes', async () => {
    const { capture, perception } = startAudio()
    capture.cooperative = false
    playWithoutCaptions()
    expect(status().session!.systemAudio.coverage).toBe('missing')

    const pending = watch!.listen()
    await flush()
    expect(capture.requests).toHaveLength(1)
    expect(capture.requests[0].max_duration_ms).toBeLessThanOrEqual(8000)

    perception.publish({ status: 'blocked-by-privacy' })
    expect(await pending).toEqual({ status: 'cancelled', language: 'en' })
    const late = new Uint8Array([9, 9, 9])
    capture.requests[0].answer(late)
    await flush()
    expect([...late]).toEqual([0, 0, 0])
  })

  it('cancels a pending recording when the user pauses perception', async () => {
    const { capture, perception } = startAudio()
    playWithoutCaptions()
    const pending = watch!.listen()
    await flush()
    perception.paused = true
    perception.publish({ status: 'unavailable' })
    expect((await pending).status).toBe('cancelled')
    expect(capture.requests[0].signal.aborted).toBe(true)
  })

  // K
  it('cancels redundant transcription when a usable caption appears', async () => {
    const { capture, recognition } = startAudio()
    playWithoutCaptions()
    const pending = watch!.listen()
    await flush()
    extension.sendSubtitle('Now there are captions', { language: 'en' })
    expect((await pending).status).toBe('cancelled')
    expect(capture.requests[0].signal.aborted).toBe(true)
    expect(recognition.languages).toHaveLength(0)
    expect(status().session!.systemAudio.coverage).toBe('available')
  })

  it('cancels a pending recording when the user speaks', async () => {
    const { capture } = startAudio()
    playWithoutCaptions()
    const pending = watch!.listen()
    await flush()
    channel.emit('input:voice:activity', { active: true, inputId: 'speech-2' })
    expect((await pending).status).toBe('cancelled')
    expect(capture.requests[0].signal.aborted).toBe(true)
  })

  // L
  it('uses Japanese recognition for a Japanese title and keeps the transcript as current dialogue only', async () => {
    const { capture, recognition } = startAudio()
    recognition.text = '一緒に見よう。'
    playWithoutCaptions('葬送のフリーレン 第3話')
    const pending = watch!.listen()
    await flush()
    advance(4000)
    capture.requests[0].answer()
    const reply = await pending

    expect(recognition.languages).toEqual(['ja'])
    expect(reply).toMatchObject({ status: 'transcribed', language: 'ja', dialogue: { text: '一緒に見よう。' } })
    expect(tool().dialogue).toMatchObject({ text: '一緒に見よう。', source: 'system-audio' })
    advance(7000)
    expect(tool().dialogue).toBeUndefined()
  })
})

describe('memory, completion, and AniList', () => {
  // M and N
  it('offers bounded milestones to memory and nothing for a caption, position, or frame flood', () => {
    const memory = new FakeMemory()
    const perception = new FakePerception()
    start({ memory, perception })
    extension.sendVideo({ isPlaying: true, currentTimeSec: 10 })
    for (let i = 0; i < 300; i++) {
      advance(400)
      extension.sendSubtitle(`Flood caption ${i}`)
      if (i % 10 === 0)
        extension.sendVideo({ isPlaying: true, currentTimeSec: 10 + i })
      perception.publish(screen({ summary: `Frame ${i}` }))
    }
    extension.sendVideo({ isPlaying: false, currentTimeSec: 140 })
    extension.sendVideo({ isPlaying: true, currentTimeSec: 140 })

    expect(memory.milestones).toHaveLength(1)
    expect(memory.milestones[0]).toMatchObject({ boundary: 'watch_start', text: 'Started watching "Frieren Episode 3" episode 3 on youtube.' })
    expect(memory.milestones[0].id).toMatch(/^[\w-]+:1$/)
    expect(JSON.stringify(memory.milestones)).not.toContain('Flood')
    expect(status().recentEvents.map(event => event.kind)).toEqual(['started', 'paused', 'resumed'])
  })

  // P
  it('confirms an episode only from the ended signal of the current media', () => {
    const memory = new FakeMemory()
    start({ memory })
    extension.sendVideo({ isPlaying: true, currentTimeSec: 1410, durationSec: 1420 })
    extension.seek()
    extension.sendVideo({ isPlaying: true, currentTimeSec: 1419, durationSec: 1420 })
    expect(memory.milestones.filter(milestone => milestone.text.startsWith('Finished'))).toHaveLength(0)

    extension.sendVideo({ isPlaying: false, isEnded: true, currentTimeSec: 1420, durationSec: 1420 })
    expect(memory.milestones.map(milestone => milestone.text)).toContain('Finished episode 3 of "Frieren Episode 3".')
  })

  it('never confirms completion of a video without a known episode', () => {
    const memory = new FakeMemory()
    start({ memory })
    extension.sendVideo({ title: 'A cooking stream', url: 'https://www.youtube.com/watch?v=cook', videoId: 'cook', isPlaying: true, currentTimeSec: 10 })
    extension.sendVideo({ isPlaying: false, isEnded: true, currentTimeSec: 600 })
    expect(memory.milestones.map(milestone => milestone.text).join()).not.toContain('Finished')
  })

  // O
  it('withholds spoiler-sensitive context while completed progress is unknown, and queries identity only', async () => {
    const queries: string[] = []
    const anilistTransport = vi.fn<typeof fetch>(async (_url, init) => {
      queries.push(String(init?.body))
      return Response.json({ data: { Media: { id: 154587, title: { english: 'Frieren: Beyond Journey\'s End', romaji: 'Sousou no Frieren', native: '葬送のフリーレン' }, episodes: 28, duration: 24 } } })
    })
    start({ watchConfig: { anilist: { enabled: true } }, anilistTransport })
    extension.sendVideo({ isPlaying: true, currentTimeSec: 10 })
    const mediaId = status().session!.media ? 'youtube:frieren3' : ''
    const context = [
      { kind: 'synopsis' as const, text: 'Early recap through episode 2.', verified_through_episode: 2 },
      { kind: 'character' as const, text: 'A late reveal from episode 5.', verified_through_episode: 5 },
    ]

    expect(watch!.bindAniList({ mediaId, anilistId: 154587, context })).toBe('bound')
    await flush()
    let facts = tool()
    expect(facts.anilist).toMatchObject({ id: 154587, episodes: 28, duration_minutes: 24 })
    expect(facts.verified_context).toBeUndefined()
    expect(facts.spoilers).toBe('withheld: completed progress unknown')
    expect(JSON.stringify(facts)).not.toContain('reveal')
    expect(queries[0]).not.toMatch(/description|characters|relations|tags|reviews|nextAiringEpisode/)

    expect(watch!.bindAniList({ mediaId, anilistId: 154587, completedEpisode: 3, context })).toBe('bound')
    await flush()
    facts = tool()
    expect(facts.verified_context).toEqual([{ kind: 'synopsis', text: 'Early recap through episode 2.', verified_through_episode: 2 }])
    expect(JSON.stringify(facts)).not.toContain('reveal')
  })

  it('refuses an AniList binding while AniList is disabled or for another media', () => {
    start()
    extension.sendVideo({ isPlaying: true, currentTimeSec: 10 })
    expect(watch!.bindAniList({ mediaId: 'youtube:frieren3', anilistId: 1 })).toBe('disabled')
    void watch!.shutdown()
    start({ watchConfig: { anilist: { enabled: true } }, anilistTransport: vi.fn<typeof fetch>() })
    extension.sendVideo({ isPlaying: true, currentTimeSec: 12 })
    expect(watch!.bindAniList({ mediaId: 'youtube:another', anilistId: 1 })).toBe('media-mismatch')
  })
})
