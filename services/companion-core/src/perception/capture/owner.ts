import type { ScreenCapturePort, ScreenFrame } from '../ports/contracts'

import { abortable, PerceptionFailure } from '../ports/failure'

/** A native or app-owned backend produces encoded bytes and local samples without saving images. */
export interface CaptureBackend {
  capture: (signal: AbortSignal) => Promise<ScreenFrame>
  shutdown: () => Promise<void>
}

/** The backend transfers frame ownership. Consumers release it after inference or rejection. */
export function releaseFrame(frame: ScreenFrame): void {
  frame.image.bytes.fill(0)
  frame.samples.fill(0)
}

/** One backend capture can run at a time. Source events revoke leases and clear the service's current facts. */
export class OwnedScreenCapture implements ScreenCapturePort {
  private available = true
  private closed = false
  private busy = false
  private generation = 0
  private pending?: AbortController
  private listeners = new Set<() => void>()

  constructor(private readonly backend: CaptureBackend) {}

  isAvailable(): boolean { return this.available && !this.closed }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  sourceChanged(available: boolean): void {
    this.available = available
    this.generation++
    this.pending?.abort()
    for (const listener of this.listeners) {
      try {
        listener()
      }
      catch { /* Source loss must reach every subscriber, even if a consumer fails. */ }
    }
  }

  async capture(signal: AbortSignal): Promise<ScreenFrame> {
    if (!this.isAvailable())
      throw new PerceptionFailure('source-lost')
    if (signal.aborted)
      throw new PerceptionFailure('cancelled')
    if (this.busy)
      throw new PerceptionFailure('capture-busy')
    this.busy = true
    const generation = this.generation
    const controller = new AbortController()
    this.pending = controller
    const combined = AbortSignal.any([signal, controller.signal])
    let result: ScreenFrame
    try {
      const capture = this.backend.capture(combined)
      capture.then(() => {
        this.busy = false
      }, () => {
        this.busy = false
      })
      result = await abortable(capture, combined, releaseFrame)
    }
    catch (error) {
      if (!combined.aborted)
        this.busy = false
      throw error
    }
    finally {
      if (this.pending === controller)
        this.pending = undefined
    }
    if (combined.aborted || generation !== this.generation || !this.isAvailable()) {
      releaseFrame(result)
      throw new PerceptionFailure('cancelled')
    }
    return result
  }

  async shutdown(): Promise<void> {
    if (this.closed)
      return
    this.closed = true
    this.sourceChanged(false)
    this.listeners.clear()
    await this.backend.shutdown()
  }
}
