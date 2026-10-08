import type { CurrentWorld, FailureStatus, Observation } from '../ports/contracts'

/** Stores current facts only. Stale and failed queries never expose an old observation as current. */
export class WorldState {
  private current?: Observation
  private uncertainObjects: string[] = []
  private status: FailureStatus = 'unavailable'
  private sequence = Number.NEGATIVE_INFINITY
  private suspended = false

  accept(input: Observation, now: number, sequence = input.captured_at): boolean {
    if (sequence <= this.sequence || input.valid_until <= now || input.captured_at > now)
      return false
    const next = structuredClone(input)
    const previous = this.current
    const sameWindow = previous && previous.source.id === next.source.id && previous.source.generation === next.source.generation
      && previous.source.window_id === next.source.window_id && previous.source.display_id === next.source.display_id && previous.source.foreground_app === next.source.foreground_app
    this.uncertainObjects = sameWindow && previous.valid_until > now
      ? previous.notable_objects.filter(value => !next.notable_objects.includes(value))
      : []
    if (next.confidence < 0.5) {
      next.visible_text_summary = ''
      next.notable_objects = []
      next.people_count = undefined
      next.media = { detected: false, playback: 'unknown', title_like_text: '', subtitle_like_text: '' }
      next.activity = 'uncertain'
      next.concise_summary = 'Screen observation has low confidence.'
      this.uncertainObjects = []
    }
    this.current = next
    this.suspended = false
    this.sequence = sequence
    return true
  }

  invalidate(status: FailureStatus): void {
    this.current = undefined
    this.uncertainObjects = []
    this.status = status
    this.suspended = false
  }

  /** A changed screen hides old facts while preserving one bounded comparison for temporal fusion. */
  suspend(): void {
    this.suspended = this.current !== undefined
  }

  /** A frame matching the accepted signature can restore facts only within their original TTL. */
  restore(): void {
    this.suspended = false
  }

  query(now: number): CurrentWorld {
    if (this.suspended)
      return { status: 'unavailable' }
    if (!this.current)
      return { status: this.status }
    if (now >= this.current.valid_until)
      return { status: 'stale' }
    return { status: 'fresh', observation: structuredClone(this.current), uncertain_objects: [...this.uncertainObjects] }
  }
}
