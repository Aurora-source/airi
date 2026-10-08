import type { TurnRef } from '@proj-airi/core-agent'
import type { OutputVoiceActivityEvent } from '@proj-airi/server-sdk'

import { turnKey } from '@proj-airi/core-agent'

/** Listeners treat an unrenewed report as ended after about ten seconds, so an active report renews sooner. */
const RENEW_MS = 4000

/**
 * Reports which response turns own speech output: `active: true` from the first scheduled audio of a turn, renewed
 * while it stays active, and `active: false` once the turn leaves the voice controller's active turns.
 * Modules that coordinate their own output use the turn id to tell their own speech from other speech.
 *
 * @example
 * const announcer = new SpeechOutputAnnouncer(activity => channel.send({ type: 'output:voice:activity', data: activity }))
 * announcer.started({ sessionId: 's1', turnId: 'r1' })
 * announcer.settled([])
 */
export class SpeechOutputAnnouncer {
  private readonly active = new Map<string, { turn: TurnRef, timer: ReturnType<typeof setInterval> }>()

  constructor(private readonly report: (activity: OutputVoiceActivityEvent) => void, private readonly renewMs = RENEW_MS) {}

  /** The first audio of `turn` was scheduled. Later clips of the same turn change nothing. */
  started(turn: TurnRef): void {
    const key = turnKey(turn)
    if (this.active.has(key))
      return
    const send = () => this.report({ active: true, outputId: turn.turnId, sessionId: turn.sessionId })
    this.active.set(key, { turn: { ...turn }, timer: setInterval(send, this.renewMs) })
    send()
  }

  /** Ends every announced turn that is no longer active. */
  settled(activeTurns: readonly TurnRef[]): void {
    const keep = new Set(activeTurns.map(turnKey))
    for (const [key, entry] of this.active) {
      if (keep.has(key))
        continue
      clearInterval(entry.timer)
      this.active.delete(key)
      this.report({ active: false, outputId: entry.turn.turnId, sessionId: entry.turn.sessionId })
    }
  }

  /** Ends all reports, for example when the output host detaches. */
  dispose(): void {
    this.settled([])
  }
}
