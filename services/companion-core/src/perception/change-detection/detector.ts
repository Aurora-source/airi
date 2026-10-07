import type { ScreenFrame } from '../ports/contracts'

import { createHash } from 'node:crypto'

export interface Signature {
  identity: string
  hash: string
  samples: Uint8Array
}

export interface Change {
  level: 'unchanged' | 'minor' | 'meaningful' | 'major'
  score: number
  duplicate: boolean
  protected: boolean
  signature: Signature
}

/** Keeps one successful signature. Differences accumulate instead of disappearing between captures. */
export class ChangeDetector {
  private accepted?: Signature

  inspect(frame: ScreenFrame): Change {
    if (frame.samples.length !== 2304)
      throw new Error('Invalid capture sample grid')
    const identity = JSON.stringify([frame.source.kind, frame.source.id, frame.source.generation, frame.source.display_id, frame.source.window_id, frame.source.foreground_app, frame.source.window_title, frame.width, frame.height])
    const samples = frame.samples.slice()
    const signature = { identity, samples, hash: createHash('sha256').update(samples).digest('hex') }
    let sum = 0
    let squared = 0
    let difference = 0
    let changedCells = 0
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i]
      squared += samples[i] ** 2
      if (this.accepted) {
        const delta = Math.abs(samples[i] - this.accepted.samples[i])
        difference += delta
        if (delta >= 32)
          changedCells++
      }
    }
    const mean = sum / samples.length
    const protectedFrame = frame.media_hint === 'video' && mean < 4 && squared / samples.length - mean ** 2 < 1
    const score = difference / samples.length
    const fraction = changedCells / samples.length
    const duplicate = this.accepted?.identity === identity && this.accepted.hash === signature.hash
    let level: Change['level'] = 'minor'
    if (!this.accepted || this.accepted.identity !== identity || score >= 70 || fraction >= 0.6)
      level = 'major'
    else if (duplicate)
      level = 'unchanged'
    else if (score >= 12 || fraction >= 0.08)
      level = 'meaningful'
    return { level, score, duplicate, protected: protectedFrame, signature }
  }

  accept(signature: Signature): void {
    this.accepted = { ...signature, samples: signature.samples.slice() }
  }

  reset(): void { this.accepted = undefined }
}
