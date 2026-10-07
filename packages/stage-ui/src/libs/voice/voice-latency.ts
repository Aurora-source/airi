/** Timing metadata for one voice input and its correlated assistant response. */
export interface VoiceLatencySample {
  inputId: string
  turnId?: string
  speechEndedAt?: number
  sttResultAt?: number
  firstTokenAt?: number
  firstAudioAt?: number
  playbackStartedAt?: number
  estimatedOutputLatencyMs?: number
  interrupted?: boolean
}

function distribution(values: number[]) {
  values.sort((a, b) => a - b)
  const percentile = (p: number) => values[Math.ceil(values.length * p) - 1] ?? null
  return { count: values.length, p50: percentile(0.5), p95: values.length >= 20 ? percentile(0.95) : null }
}

/**
 * Records bounded, in-memory AIRI timings without audio, transcripts, or credentials.
 * Input IDs isolate overlapping ASR requests. Turn IDs isolate streamed reply chunks.
 * Playback timing measures the Web Audio start plus reported device latency.
 * It cannot prove when physical speakers emit sound.
 */
export class VoiceLatencyTrace {
  private readonly samples = new Map<string, VoiceLatencySample>()
  private readonly turns = new Map<string, string>()
  private sequence = 0

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly enabled: () => boolean = () => true,
  ) {}

  beginInput(): string | undefined {
    if (!this.enabled())
      return
    const inputId = `voice-${++this.sequence}`
    this.samples.set(inputId, { inputId })
    if (this.samples.size > 256) {
      const oldest = this.samples.keys().next().value
      if (oldest) {
        const sample = this.samples.get(oldest)
        if (sample?.turnId)
          this.turns.delete(sample.turnId)
        this.samples.delete(oldest)
      }
    }
    return inputId
  }

  markSpeechEnd(inputId: string | undefined) {
    const sample = inputId ? this.samples.get(inputId) : undefined
    if (sample)
      sample.speechEndedAt ??= this.now()
  }

  markSttResult(inputId: string | undefined) {
    const sample = inputId ? this.samples.get(inputId) : undefined
    if (sample)
      sample.sttResultAt ??= this.now()
  }

  /** Binds an input to the chat turn before its first streamed token arrives. */
  bindTurn(inputId: string | undefined, turnId: string) {
    const sample = inputId ? this.samples.get(inputId) : undefined
    if (!sample || sample.turnId || this.turns.has(turnId))
      return
    sample.turnId = turnId
    this.turns.set(turnId, sample.inputId)
  }

  markFirstToken(turnId: string) {
    const sample = this.forTurn(turnId)
    if (sample)
      sample.firstTokenAt ??= this.now()
  }

  markFirstAudio(turnId: string | undefined) {
    const sample = this.forTurn(turnId)
    if (sample)
      sample.firstAudioAt ??= this.now()
  }

  markPlaybackStarted(turnId: string | undefined, estimatedOutputLatencyMs = 0) {
    const sample = this.forTurn(turnId)
    if (!sample || sample.playbackStartedAt !== undefined)
      return
    sample.playbackStartedAt = this.now()
    sample.estimatedOutputLatencyMs = Math.max(0, estimatedOutputLatencyMs)
  }

  interrupt(turnId: string | undefined) {
    const sample = this.forTurn(turnId)
    if (sample)
      sample.interrupted = true
  }

  /** Returns copies of captured metadata. No mutable recording state escapes. */
  snapshot(): VoiceLatencySample[] {
    return [...this.samples.values()].map(sample => ({ ...sample }))
  }

  summary() {
    const samples = this.snapshot()
    const deltas = (start: keyof VoiceLatencySample, end: keyof VoiceLatencySample) => samples.flatMap((sample) => {
      const a = sample[start]
      const b = sample[end]
      return typeof a === 'number' && typeof b === 'number' && b >= a ? [b - a] : []
    })
    const totals = samples.flatMap((sample) => {
      if (sample.speechEndedAt === undefined || sample.playbackStartedAt === undefined)
        return []
      const total = sample.playbackStartedAt - sample.speechEndedAt + (sample.estimatedOutputLatencyMs ?? 0)
      return total >= 0 ? [total] : []
    })
    return {
      captured: samples.length,
      completed: totals.length,
      interrupted: samples.filter(sample => sample.interrupted).length,
      stt: distribution(deltas('speechEndedAt', 'sttResultAt')),
      llm: distribution(deltas('sttResultAt', 'firstTokenAt')),
      tts: distribution(deltas('firstTokenAt', 'firstAudioAt')),
      playback: distribution(deltas('firstAudioAt', 'playbackStartedAt')),
      total: distribution(totals),
    }
  }

  reset() {
    this.samples.clear()
    this.turns.clear()
  }

  private forTurn(turnId: string | undefined) {
    const inputId = turnId ? this.turns.get(turnId) : undefined
    return inputId ? this.samples.get(inputId) : undefined
  }
}

/** Enables measurement only within a browser session that explicitly opts in. */
export function isVoiceLatencyCaptureEnabled() {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem('airi/r3/voice-latency') === 'true'
  }
  catch {
    return false
  }
}

export const voiceLatencyTrace = new VoiceLatencyTrace(() => performance.now(), isVoiceLatencyCaptureEnabled)
