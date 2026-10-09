import type { TurnIdentity } from './turn-identity'

import { createHash } from 'node:crypto'

type Outcome = 'delivered' | 'declined' | 'cancelled'

/** Requests kept for correlation. Older ones leave first. */
const MAX_REQUESTS = 64
/** A request older than this is forgotten, even when it never finished. */
const REQUEST_TTL_MS = 10 * 60_000
/** An answered reply that starts no speech within this time counts as delivered without speech. */
const SPEECH_GRACE_MS = 1500
/** First-audio latencies kept for Ops. */
const MAX_LATENCIES = 50

interface Attachment {
  outputId: string
  signal: AbortSignal
  resolve: (outcome: Outcome) => void
  settled: boolean
  onAbort: () => void
  timer?: ReturnType<typeof setTimeout>
}

interface Request {
  requestId: string
  sessionId: string
  roundId: string
  characterId: string
  state: 'generating' | 'answered' | 'failed'
  /** Gateway requests of this round that have not finished, including tool rounds and retries. */
  open: number
  speaking: boolean
  updatedAt: number
  /** When the gateway saw the first request of the round. */
  openedAt: number
  /** Set at the first speech report of the round. */
  spoke: boolean
  attached?: Attachment
}

/**
 * Canonical user requests seen by the gateway, and their single owner.
 *
 * The existing AIRI chat pipeline answers every user request. The Director can only attach to that answer: it never
 * starts a second one. One attachment per request, so a Director reply and the existing reply cannot both consume it.
 * The request id is an opaque hash of the AIRI session and round ids. Tool rounds and retries of a round share it.
 *
 * Call stack:
 *
 * CompanionRuntime.begin (./runtime)
 *   -> CompanionDirector.beginTurn (./director) -> {@link ConversationLedger.open}
 * SpeechIntentPort.deliver for respond-user (./director)
 *   -> {@link ConversationLedger.attach}
 * output:voice:activity from the stage (./director)
 *   -> {@link ConversationLedger.speech}
 */
export class ConversationLedger {
  private readonly requests = new Map<string, Request>()
  /** Milliseconds from the first gateway request of a round to its first speech report, newest last. */
  private readonly firstSpeech: Array<{ ms: number, at: number }> = []

  constructor(private readonly now: () => number = Date.now) {}

  /** The opaque canonical id of one AIRI round. */
  static requestIdOf(turn: Pick<TurnIdentity, 'sessionId' | 'roundId'>): string {
    return `turn:${createHash('sha256').update(`${turn.sessionId}\u0000${turn.roundId}`).digest('base64url').slice(0, 32)}`
  }

  /**
   * Registers one gateway request of a round. `isNew` is true only for the first request of a round, so tool
   * continuations and retries never become a second user request. Call `finish` exactly once.
   */
  open(turn: TurnIdentity): { requestId: string, isNew: boolean, finish: (answered: boolean) => void } {
    this.prune()
    const requestId = ConversationLedger.requestIdOf(turn)
    let request = this.requests.get(requestId)
    const isNew = !request
    if (!request) {
      request = { requestId, sessionId: turn.sessionId, roundId: turn.roundId, characterId: turn.characterId, state: 'generating', open: 0, speaking: false, updatedAt: this.now(), openedAt: this.now(), spoke: false }
      this.requests.set(requestId, request)
      while (this.requests.size > MAX_REQUESTS)
        this.drop(this.requests.keys().next().value!)
    }
    request.open++
    request.state = 'generating'
    request.updatedAt = this.now()
    let finished = false
    const current = request
    return {
      requestId,
      isNew,
      finish: (answered) => {
        if (finished)
          return
        finished = true
        current.open = Math.max(0, current.open - 1)
        current.updatedAt = this.now()
        if (answered)
          current.state = 'answered'
        else if (current.open === 0 && current.state === 'generating')
          current.state = 'failed'
        this.settle(current)
      },
    }
  }

  /**
   * Attaches one Director output to the existing answer of `requestId`. It resolves `delivered` once that answer is
   * complete and its speech ended, `cancelled` when the answer fails or `signal` aborts, and `declined` for an unknown
   * or already attached request.
   */
  attach(requestId: string, outputId: string, signal: AbortSignal): Promise<Outcome> {
    const request = this.requests.get(requestId)
    if (!request || request.attached || signal.aborted)
      return Promise.resolve(signal.aborted ? 'cancelled' : 'declined')
    return new Promise<Outcome>((resolve) => {
      const attachment: Attachment = { outputId, signal, resolve, settled: false, onAbort: () => this.resolve(attachment, 'cancelled') }
      request.attached = attachment
      signal.addEventListener('abort', attachment.onAbort, { once: true })
      this.settle(request)
    })
  }

  /**
   * Applies one stage speech report. Returns the attached Director output id when the speaking turn is the answer of
   * an attached request, so that speech never preempts its own Director output.
   */
  speech(turnId: string, sessionId: string | undefined, active: boolean): string | undefined {
    const request = [...this.requests.values()].find(item => item.roundId === turnId && (!sessionId || item.sessionId === sessionId))
    if (!request)
      return undefined
    request.speaking = active
    request.updatedAt = this.now()
    if (active && !request.spoke) {
      request.spoke = true
      this.firstSpeech.push({ ms: request.updatedAt - request.openedAt, at: request.updatedAt })
      if (this.firstSpeech.length > MAX_LATENCIES)
        this.firstSpeech.shift()
    }
    const attached = request.attached && !request.attached.settled ? request.attached.outputId : undefined
    this.settle(request)
    return attached
  }

  /**
   * Counts and timings for Ops. No ids. `firstSpeech` measures the voice path as the Core sees it: from the first
   * gateway request of a round to the stage's first speech report, so model time and synthesis time together.
   */
  status() {
    const values = [...this.requests.values()]
    const latencies = this.firstSpeech.map(item => item.ms).sort((a, b) => a - b)
    const at = (q: number) => latencies.length === 0 ? null : latencies[Math.min(latencies.length - 1, Math.ceil(q * latencies.length) - 1)]
    const last = this.firstSpeech.at(-1)
    return {
      requests: values.length,
      generating: values.filter(item => item.state === 'generating').length,
      attached: values.filter(item => item.attached && !item.attached.settled).length,
      firstSpeech: {
        samples: latencies.length,
        p50Ms: at(0.5),
        p95Ms: latencies.length >= 20 ? at(0.95) : null,
        lastMs: last?.ms ?? null,
        lastAt: last ? new Date(last.at).toISOString() : null,
        recentMs: this.firstSpeech.slice(-20).map(item => item.ms),
      },
    }
  }

  /** Cancels every pending attachment and forgets all requests, for example on an identity change. */
  clear(): void {
    for (const key of [...this.requests.keys()])
      this.drop(key)
  }

  private settle(request: Request): void {
    const attachment = request.attached
    if (!attachment || attachment.settled)
      return
    clearTimeout(attachment.timer)
    attachment.timer = undefined
    if (request.state === 'failed') {
      this.resolve(attachment, 'cancelled')
      return
    }
    if (request.state !== 'answered' || request.speaking)
      return
    // A reply without speech output (text only, muted speech) still answers the request. Speech that starts in the
    // grace window keeps the attachment open until it ends.
    attachment.timer = setTimeout(() => {
      if (!request.speaking && request.state === 'answered')
        this.resolve(attachment, 'delivered')
    }, SPEECH_GRACE_MS)
    attachment.timer.unref?.()
  }

  private resolve(attachment: Attachment, outcome: Outcome): void {
    if (attachment.settled)
      return
    attachment.settled = true
    clearTimeout(attachment.timer)
    attachment.signal.removeEventListener('abort', attachment.onAbort)
    attachment.resolve(attachment.signal.aborted && outcome === 'delivered' ? 'cancelled' : outcome)
  }

  private drop(requestId: string): void {
    const request = this.requests.get(requestId)
    if (request?.attached)
      this.resolve(request.attached, 'cancelled')
    this.requests.delete(requestId)
  }

  private prune(): void {
    const now = this.now()
    for (const [key, request] of this.requests) {
      if (now - request.updatedAt > REQUEST_TTL_MS)
        this.drop(key)
    }
  }
}
