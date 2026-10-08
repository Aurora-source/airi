import type { VoiceController } from '@proj-airi/core-agent'
import type { InputVoiceActivityEvent } from '@proj-airi/server-sdk'

/**
 * Reports every speech input of `controller`: `active: true` when the input begins and `active: false` when it settles.
 * Other modules use it to stop their own speech or recording at once, because user speech always wins.
 * An input settles once, so its listener needs no removal. Returns the function that stops reporting.
 */
export function announceVoiceActivity(controller: Pick<VoiceController, 'onInput'>, report: (activity: InputVoiceActivityEvent) => void): () => void {
  return controller.onInput((attempt) => {
    if (attempt.state.phase === 'settled')
      return
    report({ active: true, inputId: attempt.id })
    let ended = false
    attempt.subscribe((next) => {
      if (ended || next.phase !== 'settled')
        return
      ended = true
      report({ active: false, inputId: attempt.id })
    })
  })
}
