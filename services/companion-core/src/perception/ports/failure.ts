export type FailureCode = 'cancelled' | 'timeout' | 'source-lost' | 'capture-busy' | 'stale-capture' | 'invalid-capture' | 'malformed' | 'rate-limited' | 'provider-error' | 'unconfigured' | 'privacy'

/** Safe failures carry only classification and numeric backoff. Provider responses never enter their messages. */
export class PerceptionFailure extends Error {
  constructor(readonly code: FailureCode, readonly retry_after_ms?: number) {
    super(`Perception ${code}`)
    this.name = 'PerceptionFailure'
  }
}

/** Bounds even non-cooperative adapters. Late capture values are released by the supplied cleanup. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal, releaseLate?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = () => {
      if (settled)
        return
      settled = true
      signal.removeEventListener('abort', abort)
      reject(new PerceptionFailure('cancelled'))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted)
      abort()
    promise.then((value) => {
      signal.removeEventListener('abort', abort)
      if (settled) {
        releaseLate?.(value)
        return
      }
      settled = true
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort)
      if (settled)
        return
      settled = true
      reject(error instanceof PerceptionFailure ? error : new PerceptionFailure('provider-error'))
    })
  })
}

/** Timers are cleared on every completion path. */
export async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, timeoutMs: number, releaseLate?: (value: T) => void): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const combined = AbortSignal.any([signal, controller.signal])
  try {
    return await abortable(operation(combined), combined, releaseLate)
  }
  catch (error) {
    if (controller.signal.aborted && !signal.aborted)
      throw new PerceptionFailure('timeout')
    throw error
  }
  finally { clearTimeout(timer) }
}
