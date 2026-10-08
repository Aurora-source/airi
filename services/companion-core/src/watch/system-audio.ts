import type { SpeechRecognitionPort, SystemAudioPort, WatchSnapshot } from './contracts'
import type { WatchState } from './state'

export interface AudioFallbackPolicy {
  enabled: boolean
  /** Host privacy and output capture authorization. Never infer authorization from missing metadata. */
  allowed: () => boolean
  subtitle_coverage: 'unknown' | 'available' | 'missing' | 'incomplete'
  protected_video: boolean
}

export type AudioResult = 'suppressed' | 'transcribed' | 'no-dialogue' | 'cancelled' | 'failed'

/**
 * Admits one bounded system-output segment on explicit demand. No background recording loop exists.
 * Caption availability, user speech, privacy and media revision can revoke an in-flight request.
 * A timed-out or cancelled producer's late bytes are erased and its text never becomes current state.
 */
export class SystemAudioFallback {
  private policy: AudioFallbackPolicy
  private user_speaking = false
  private disposed = false
  private pending?: AbortController
  private last_attempt = -Infinity
  private readonly unsubscribe: () => void

  constructor(private readonly ports: { state: WatchState, audio: SystemAudioPort, recognition: SpeechRecognitionPort, now: () => number }, policy: AudioFallbackPolicy) {
    this.policy = { ...policy }
    this.unsubscribe = ports.state.subscribe(() => {
      if (!this.useful(ports.state.current()))
        this.pending?.abort()
    })
  }

  configure(policy: AudioFallbackPolicy): void {
    this.policy = { ...policy }
    if (!this.useful(this.ports.state.current()))
      this.pending?.abort()
  }

  userSpeech(active: boolean): void {
    this.user_speaking = active
    if (active)
      this.pending?.abort()
  }

  async transcribe(language: 'en' | 'ja', signal?: AbortSignal): Promise<AudioResult> {
    const snapshot = this.ports.state.current()
    if (signal?.aborted)
      return 'cancelled'
    if (!['en', 'ja'].includes(language) || this.pending || !this.useful(snapshot)
      || this.ports.now() - this.last_attempt < this.ports.state.options.audio_interval_ms) {
      return 'suppressed'
    }
    this.last_attempt = this.ports.now()
    const controller = new AbortController()
    this.pending = controller
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(abort, this.ports.state.options.audio_timeout_ms)
    const unsubscribe = this.ports.state.subscribe(() => {
      if (this.ports.state.current().revision !== snapshot.revision)
        controller.abort()
    })
    let bytes: Uint8Array | undefined
    try {
      const capture = this.ports.audio.capture({ max_duration_ms: 8000, signal: controller.signal })
      // Keep the cleanup attached even after cancellation wins the race against an uncooperative capture.
      void capture.then((segment) => {
        if (controller.signal.aborted)
          segment.bytes.fill(0)
      }, () => {})
      const segment = await this.cancellable(capture, controller.signal)
      bytes = segment.bytes
      controller.signal.throwIfAborted()
      const now = this.ports.now()
      if (!this.useful(this.ports.state.current()) || snapshot.revision !== this.ports.state.current().revision)
        return 'cancelled'
      if (!Number.isFinite(segment.captured_at) || segment.captured_at < this.last_attempt || segment.captured_at > now
        || !Number.isFinite(segment.duration_ms) || segment.duration_ms <= 0 || segment.duration_ms > 8000
        || segment.captured_at - segment.duration_ms < this.last_attempt
        || bytes.byteLength === 0 || bytes.byteLength > 2_000_000 || !['audio/wav', 'audio/webm'].includes(segment.mime_type)) {
        return 'failed'
      }
      const transcript = await this.cancellable(this.ports.recognition.transcribe({ bytes, mime_type: segment.mime_type, language, signal: controller.signal }), controller.signal)
      if (!this.useful(this.ports.state.current()) || controller.signal.aborted)
        return 'cancelled'
      return this.ports.state.audioDialogue(transcript, language, segment.captured_at, snapshot.revision) ? 'transcribed' : 'no-dialogue'
    }
    catch { return controller.signal.aborted ? 'cancelled' : 'failed' }
    finally {
      bytes?.fill(0)
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      unsubscribe()
      if (this.pending === controller)
        this.pending = undefined
    }
  }

  shutdown(): void {
    this.disposed = true
    this.pending?.abort()
    this.unsubscribe()
  }

  private useful(snapshot: WatchSnapshot): boolean {
    if (this.disposed || this.user_speaking || !this.policy.enabled || !this.policy.allowed()
      || snapshot.perception_blocked || snapshot.status !== 'watching' || snapshot.playback?.value !== 'playing') {
      return false
    }
    // Fresh structured subtitles answer the dialogue question even when video capture is protected.
    if (snapshot.dialogue?.source === 'subtitle')
      return false
    return this.policy.subtitle_coverage === 'missing' || this.policy.subtitle_coverage === 'incomplete'
      || (this.policy.subtitle_coverage !== 'available' && this.policy.protected_video)
  }

  private async cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('Watch audio cancelled'))
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      return await Promise.race([promise, cancelled])
    }
    finally {
      signal.removeEventListener('abort', abort)
    }
  }
}
